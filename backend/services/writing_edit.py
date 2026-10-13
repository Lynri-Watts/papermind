"""AI 写作编辑引擎：SEARCH/REPLACE 唯一锚点编辑（纯函数，无 Flask/DB 依赖）。

编辑原语（与 Aider diff / Anthropic str_replace_editor 同一语义）：

- ``replace``：``old`` 必须在当前正文中**逐字且唯一**命中，替换为 ``new``；
- ``insert_before`` / ``insert_after``：``anchor`` 必须唯一命中，在其前/后插入
  ``text``（引擎内部归一化为一次锚点替换，修订记录只存归一化后的 old/new）。

零命中 / 多命中都是**可预期失败**：整批不应用（调用方拿到每个失败动作的行号
信息交给 LLM 自行加大上下文重试），绝不做模糊猜测替换。

行尾约定：磁盘文件可能是 CRLF。引擎内部统一在 LF 文本上匹配与计算，写回时
恢复原文主导行尾风格，避免一次编辑把整篇 EOL 全部改写而污染 diff。
``content_hash`` 对 LF 归一化后的正文取 SHA-256，与行尾风格无关。
"""
from __future__ import annotations

import difflib
import hashlib
from dataclasses import dataclass, field

#: 单批动作上限 / 单块文本字符上限（工具层再校，引擎层兜底）
MAX_ACTIONS = 20
MAX_BLOCK_CHARS = 8000
#: read_file 单次回执字符上限
READ_MAX_CHARS = 24_000


class EditEngineError(Exception):
    """调用方式错误（非锚点失配）：动作结构非法等。"""


@dataclass
class ActionFailure:
    """单个动作的可预期失败信息（回 LLM，供其自修）。"""

    index: int
    code: str            # empty_block | same | not_found | multiple
    occurrences: list[int] = field(default_factory=list)  # 多命中时的全部行号
    candidates: list[int] = field(default_factory=list)   # 零命中时的相似行候选

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "code": self.code,
            "occurrences": self.occurrences,
            "candidates": self.candidates,
        }


@dataclass
class AppliedEdit:
    """一个成功应用的编辑（归一化后的真实替换 + 应用后的行号区间）。"""

    old_text: str
    new_text: str
    old_start: int       # old 块在应用前正文中的起始行（1 基）
    old_lines: int       # old 块行数
    new_start: int       # new 块在应用后正文中的起始行（1 基）
    new_lines: int       # new 块行数


@dataclass
class ApplyResult:
    text: str                       # 应用后的完整 LF 正文
    applied: list[AppliedEdit]


def normalize_eol(text: str) -> str:
    """CRLF / CR → LF。"""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def detect_eol(raw: str) -> str:
    """探测原文主导行尾：CRLF 占多数则返回 ``\\r\\n``，否则 ``\\n``。"""
    crlf = raw.count("\r\n")
    lf = raw.count("\n") - crlf
    return "\r\n" if crlf > lf else "\n"


def restore_eol(text_lf: str, eol: str) -> str:
    if eol == "\r\n":
        return text_lf.replace("\n", "\r\n")
    return text_lf


def content_hash(text: str) -> str:
    """对 LF 归一化正文取 SHA-256（64 位 hex）。"""
    return hashlib.sha256(normalize_eol(text).encode("utf-8")).hexdigest()


def line_at(text: str, offset: int) -> int:
    """offset（0 基）所在行号（1 基）。"""
    return text.count("\n", 0, offset) + 1


def _line_count(block: str) -> int:
    return block.count("\n") + 1


def _to_replace(action: dict, index: int) -> tuple[str, str] | ActionFailure:
    """把三类动作归一化为 (old, new)；结构问题返回 ActionFailure。"""
    kind = action.get("kind") or "replace"
    if kind == "replace":
        old = action.get("old")
        new = action.get("new")
    elif kind in ("insert_before", "insert_after"):
        anchor = action.get("anchor")
        inserted = action.get("text")
        if not isinstance(anchor, str) or not isinstance(inserted, str):
            return ActionFailure(index, "empty_block")
        if not anchor.strip():
            return ActionFailure(index, "empty_block")
        # 插入文本与锚点之间补换行（text 自带尾换行则不重复加）
        sep = "" if inserted.startswith("\n") else "\n"
        if kind == "insert_before":
            old, new = anchor, inserted + sep + anchor
        else:
            old, new = anchor, anchor + sep + inserted
    else:
        raise EditEngineError(f"unknown action kind: {kind!r}")
    if not isinstance(old, str) or not isinstance(new, str):
        return ActionFailure(index, "empty_block")
    if not old.strip():
        return ActionFailure(index, "empty_block")
    if len(old) > MAX_BLOCK_CHARS or len(new) > MAX_BLOCK_CHARS:
        raise EditEngineError("edit block exceeds size limit")
    if old == new:
        return ActionFailure(index, "same")
    return old, new


def _occurrence_lines(text: str, needle: str) -> list[int]:
    lines, start = [], 0
    while True:
        pos = text.find(needle, start)
        if pos < 0:
            return lines
        lines.append(line_at(text, pos))
        start = pos + 1  # 允许重叠计数（逐字锚点重叠极罕见，计数仍准确）


def _similar_lines(text: str, block: str, limit: int = 3) -> list[int]:
    """零命中时找与锚点首行最相似的正文行（去空白比较，ratio≥0.6）。"""
    key = block.split("\n", 1)[0].strip()
    if not key:
        return []
    scored: list[tuple[float, int]] = []
    for i, line in enumerate(text.split("\n"), start=1):
        ratio = difflib.SequenceMatcher(None, key, line.strip()).ratio()
        if ratio >= 0.6:
            scored.append((ratio, i))
    scored.sort(reverse=True)
    return [ln for _, ln in scored[:limit]]


def apply_actions(text: str, actions: list[dict]) -> ApplyResult | list[ActionFailure]:
    """对 LF 正文**顺序、原子**地应用一批动作。

    每个动作在"当前正文"上必须唯一命中；任一动作失配则整批不改动，
    返回失败列表。全部成功返回 :class:`ApplyResult`。
    """
    if not isinstance(actions, list) or not actions:
        raise EditEngineError("actions must be a non-empty list")
    if len(actions) > MAX_ACTIONS:
        raise EditEngineError(f"too many actions: {len(actions)} > {MAX_ACTIONS}")

    normalized: list[tuple[int, str, str]] = []
    for i, action in enumerate(actions):
        if not isinstance(action, dict):
            raise EditEngineError("each action must be an object")
        result = _to_replace(action, i)
        if isinstance(result, ActionFailure):
            return [result]
        normalized.append((i, result[0], result[1]))

    # 先全量校验：在"应用到该动作时的正文"上逐个检查唯一命中。
    # 在副本上预演，任何失配都不影响调用方原文，保证原子性。
    probe = text
    failures: list[ActionFailure] = []
    for i, old, _new in normalized:
        count = probe.count(old)
        if count == 0:
            failures.append(ActionFailure(
                i, "not_found", candidates=_similar_lines(text, old)))
        elif count > 1:
            failures.append(ActionFailure(
                i, "multiple", occurrences=_occurrence_lines(probe, old)))
        else:
            probe = probe.replace(old, _new_for(normalized, i), 1)
    if failures:
        return failures

    # 全部合法：正式顺序应用并记录行号
    current = text
    applied: list[AppliedEdit] = []
    for i, old, new in normalized:
        pos = current.find(old)
        old_start = line_at(current, pos)
        old_n = _line_count(old)
        current = current.replace(old, new, 1)
        new_pos = current.find(new)
        applied.append(AppliedEdit(
            old_text=old, new_text=new,
            old_start=old_start, old_lines=old_n,
            new_start=line_at(current, new_pos), new_lines=_line_count(new),
        ))
    return ApplyResult(text=current, applied=applied)


def _new_for(normalized: list[tuple[int, str, str]], index: int) -> str:
    for i, _old, new in normalized:
        if i == index:
            return new
    raise EditEngineError(f"action index missing: {index}")


def reverse_replace(text: str, new_block: str,
                    old_block: str) -> tuple[int, str]:
    """把一个已应用的替换反向还原（拒绝单块 / 事务回滚共用）。

    要求 new_block 在当前正文唯一命中，否则不改动并返回 (命中数, 原文)
    （0=已被改动/不存在，>1=环境有歧义）；成功返回 ``(1, 还原后正文)``。
    """
    count = text.count(new_block)
    if count != 1:
        return count, text
    return 1, text.replace(new_block, old_block, 1)


def remove_block(text: str, block: str) -> tuple[int, str]:
    """反向删除一个"追加块"（add_bib_entries 的 append 修订）。

    要求 block 唯一命中；删除后收敛拼接处 3+ 连续空行为两个换行，
    返回 ``(1, 新正文)``；非唯一返回 (命中数, 原文)。
    """
    count = text.count(block)
    if count != 1:
        return count, text
    new_text = text.replace(block, "", 1)
    while "\n\n\n" in new_text:
        new_text = new_text.replace("\n\n\n", "\n\n")
    return 1, new_text


def numbered_slice(text: str, start_line: int | None,
                   end_line: int | None) -> tuple[str, int, int]:
    """按 1 基闭区间行号切片，返回 (带行号文本, 总行数, 实际字符数)。

    行号非法时抛出 :class:`EditEngineError`，由工具层转可预期失败。
    """
    lines = text.split("\n")
    total = len(lines)
    s = 1 if start_line is None else start_line
    e = total if end_line is None else end_line
    if s < 1 or e < s or e > total:
        raise EditEngineError(
            f"bad line range: {s}-{e}, total {total} lines")
    width = len(str(e))
    chosen = lines[s - 1:e]
    body = "\n".join(f"{n:>{width}}\t{line}" for n, line in enumerate(chosen, start=s))
    if len(body) > READ_MAX_CHARS:
        raise EditEngineError("range too large; narrow start_line/end_line")
    return body, total, len(body)
