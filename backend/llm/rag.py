"""RAG：材料直注 + LLM 问答（支持多源 Context）。

流程（2026-09-28 起取消 BM25 检索——用户明确要求"完全通过工具层"）：

1. 该读哪些材料由 LLM 在 ReAct 工具循环里自行决定并读取（``llm/tools.py``
   的 ``read_paper`` / ``read_context`` / ``read_document``）：工具回执里
   ``data["fulltexts"]`` / ``data["document"]`` 的正文进入材料池
   （``routes/papers.py`` 的 ``_merge_material``），当前打开的论文与上下文
   条目**都不自动注入**，只在提示词里被建议读取；
2. 材料池里的每一条材料**原样**成为一个 ``[Source N]`` 段落注入最终 prompt，
   不再分块、不再检索、不再截 TOP_K——"AI 没有打开应该打开的文章"正是因为
   旧检索在词面零重合时（如中文提问检索英文论文）只喂了论文开头几块，模型
   据此以为材料里没有相关内容；
3. LLM 流式生成回答，行内引用 ``[Q]逐字原句||行内文字[/Q]`` 在流末统一绑定
   出处（见下方"行内引用"一节）。

系统只负责如实呈现工具读到的内容：是否读到、读到了多少，完全由工具调用
本身决定；引用核对时忽略页码/页眉页脚噪声（``services/textmatch``）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Optional

from llm.client import LLMClient, LLMNotConfiguredError
from i18n import tr
from services import textmatch

# 精简历史：最多保留最近 N 轮、每轮最多 M 字符，控制 token 用量
MAX_HISTORY_MESSAGES = 6
MAX_HISTORY_CHARS = 1500

# 发给前端的出处 ``text`` 上限：它只作为"模型没给原句时"的 PDF 定位兜底，
# 完整正文留在 ``full_text``（后端行内引用核对用），路由层发给前端前剔除
SOURCE_FALLBACK_CHARS = 1200


def _normalize_history(history: Optional[list]) -> list[dict]:
    """把前端传来的精简历史规整为 LLM 对话轮次：

    - 只保留 user / assistant 且有内容的轮次（不含全文、出处详情）；
    - 截断每轮文本长度、限制轮次数量（保留最近几轮），控制 token 用量。
    """
    if not history or not isinstance(history, list):
        return []
    cleaned: list[dict] = []
    for h in history:
        if not isinstance(h, dict):
            continue
        role = h.get("role")
        content = h.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        cleaned.append({"role": role, "content": content.strip()[:MAX_HISTORY_CHARS]})
    return cleaned[-MAX_HISTORY_MESSAGES:]


# ---------- 行内引用（无编号引用卡） ----------
# 2026-09-22 第二次重构：放弃引用编号。模型在回答的任意位置（允许一句话
# 中间）插入**不带编号**的行内引用标签；2026-09-27 扩展为**双段**标签：
#
#   该方法在 ImageNet 上[Q]We report a top-1 accuracy of 85.3% on ImageNet.
#   ||85.3% 的 top-1 准确率[/Q]取得最佳。
#
# - 段 1（``||`` 之前）= 逐字原句：从某个出处分块逐字复制的一句原文，只
#   用于**出处核对**、悬停卡片展示与「定位原文」。出处不由模型编号指定：
#   后端把段 1 与**全部检索分块**做逐字匹配来确定出处；每张卡独立，同一
#   出处可被多张卡引用。界面上也不出现任何编号。
# - 段 2（``||`` 之后）= 行内文字：由模型随引用一并生成的短转述（或该出处
#   的中心句本身），是**回答正文的一部分**——界面上直接以主色高亮显示在
#   该位置，鼠标悬停才展开段 1 的逐字原句卡片。
# - 摘录很短时可能逐字命中多个分块（相邻分块有重叠、或跨材料重复句）：
#   先按出处身份归并（同一 paper/context 的重叠分块等价），仍歧义则用
#   标签在答案中的**上下文句**对候选分块做相似度消歧（用户明确要求：
#   短句多命中必须匹配上下文，不能随便取一个）。
# - 逐字零命中（模型改写/编造）：用上下文句对全部分块做扩展模糊匹配，
#   命中则把段 1 替换为分块中的真实原句（保留历史锚句匹配机制）；仍失败
#   → 引用失败卡（段 1 保留模型文字、注明无法核对、不可定位；段 2 不变）。
#
# 标签语法（前端按同一语法解析；数字只是后端绑定的内部键，界面不显示）：
#   流式未决（闭合即转发，尚未绑定出处）：[Q]原句||行内文字[/Q]
#   终态成功（绑定到第 n 个 source，1-based）：[Q+n]原句||行内文字[/Q]
#   终态失败（无法核对原文）：              [Q!]原句||行内文字[/Q]
# 段 2 缺省（模型未给/历史消息）时只保留一段，界面退化为直接展示原句。
INLINE_QUOTE_PENDING_RE = re.compile(
    r"\[\s*q\s*\]([\s\S]*?)\[\s*/\s*q\s*\]", re.IGNORECASE
)
INLINE_QUOTE_OPEN_RE = re.compile(r"\[\s*q\s*\]", re.IGNORECASE)
INLINE_QUOTE_CLOSE_RE = re.compile(r"\[\s*/\s*q\s*\]", re.IGNORECASE)
# 未决/终态统一的完整块正则（终态前缀 +n / ! 为可选）
INLINE_QUOTE_FULL_RE = re.compile(
    r"\[\s*q\s*(?:([+!])(\d+)?)?\s*\]([\s\S]*?)\[\s*/\s*q\s*\]",
    re.IGNORECASE,
)
QUOTE_MAX_CHARS = 80          # 回退核心句展示/定位用的长度上限
QUOTE_ACCEPT_MAX_CHARS = 120  # 失败卡展示模型原文的长度上限
# 标签内两段的分隔符：``<逐字原句>||<行内文字>``（prompt 明确禁止在段内使用）
QUOTE_FIELD_SEP = "||"
_ANSWER_SENT_BOUNDARY = "。！？；!?;\n"
_ANCHOR_RADIUS = 300          # 消歧/回退时取标签前后文的半径（字符）
_ANCHOR_MIN_RUN = 10          # 上下文锚句与分块最长连续重合下限
_ANCHOR_MIN_RATIO = 0.45      # 命中点局部窗口相似度阈值
# 跨材料多命中消歧时，最佳候选必须领先次优至少这么多，否则视为无法判定
_ANCHOR_DISAMBIG_MARGIN = 0.05
# normal 状态下尾部"可能是开标签前缀"的最大扣留长度（[ + 空白 + q + 空白）
_OPEN_TAG_MAX_HOLD = 8
# 计算标签上下文时需剔除的机器标记：未决引用块整体、旧版 [Source N]
_MACHINE_MARK_RE = re.compile(
    r"\[\s*q\s*\][\s\S]*?\[\s*/\s*q\s*\]|\[\s*source\s*\d+\s*\]",
    re.IGNORECASE,
)


def _squash_ws(text: str) -> str:
    """删除全部空白（中英混合文本的跨提取器对齐策略与前端 pdfLocate 一致）。"""
    return re.sub(r"\s+", "", text)


def _open_tag_border(text: str) -> int:
    """normal 状态下返回应继续扣留的后缀起点。

    尾部若是开标签的某个前缀（``"["`` / ``"[q"`` / ``"[ Q "`` 等，允许
    标签内空白），整段扣留等下一帧确认——否则标签被 chunk 切碎时会把
    ``"[Q"`` 当成正文泄漏；确认不是标签后该片段随下一帧原样补发。
    """
    tail = text[-_OPEN_TAG_MAX_HOLD:]
    for i, ch in enumerate(tail):
        if ch != "[":
            continue
        cand = tail[i:]
        if re.fullmatch(r"\[\s*(?:[qQ]\s*)?", cand):
            return len(text) - len(tail) + i
    return len(text)


class InlineQuoteExtractor:
    """从回答 delta 流中解析无编号行内引用 ``[Q]原句||行内文字[/Q]`` 的状态机。

    - :meth:`feed` 接收模型原始增量，返回可转发给前端的可见文本：普通
      正文原样转发；引用块闭合后以**未决态** ``[Q]原句||行内文字[/Q]``
      内联转发（两段都不解析，原样透传——前端据段 2 先把行内文字显示出来）。
      出处绑定在流末 :func:`finalize_inline_answer` 统一完成——多命中消歧
      与模糊匹配都需要标签之后的上下文句，流式中途无法可靠判定。
    - :meth:`finish` 在流结束时补发最后扣留的普通文本；空摘录块与未
      闭合块一律丢弃（半截标签/摘录绝不泄漏到正文）。
    """

    def __init__(self) -> None:
        self._pending = ""               # normal 状态未确认的后缀
        self._qbuf: Optional[str] = None  # quote 状态：开标签后已扣留文本

    def feed(self, chunk: str) -> str:
        out: list[str] = []
        self._pending += chunk
        while self._pending:
            if self._qbuf is not None:
                # quote 状态：等待闭标签（可能跨 chunk，全部扣留）。
                # 闭标签必须在 qbuf + pending 拼接缓冲里搜：闭标签首字符
                # 在更早 chunk 时只搜 pending 会永远漏配、整段摘录被吞。
                haystack = self._qbuf + self._pending
                m = INLINE_QUOTE_CLOSE_RE.search(haystack)
                if m is None:
                    self._qbuf, self._pending = haystack, ""
                    break
                # 整段内容（原句 + 分隔符 + 行内文字）原样透传，不在此解析
                payload = haystack[:m.start()].strip()
                self._pending = haystack[m.end():]
                self._qbuf = None
                if payload:
                    out.append(f"[Q]{payload}[/Q]")
                continue
            m = INLINE_QUOTE_OPEN_RE.search(self._pending)
            if m is None:
                cut = _open_tag_border(self._pending)
                out.append(self._pending[:cut])
                self._pending = self._pending[cut:]
                break
            out.append(self._pending[:m.start()])
            self._qbuf = ""
            self._pending = self._pending[m.end():]
        return "".join(out)

    def finish(self) -> str:
        """流结束：补发扣留的普通正文；未闭合引用块丢弃。"""
        tail = "" if self._qbuf is not None else self._pending
        self._pending = ""
        self._qbuf = None
        return tail


def strip_inline_quote_markers(text: str) -> str:
    """剔除全部行内引用块（标签 + 摘录，未决/终态通吃），得到纯正文。"""
    return INLINE_QUOTE_FULL_RE.sub("", text)


def split_citation_fields(content: str) -> tuple[str, str]:
    """把引用标签的内容拆为 ``(逐字原句, 行内文字)``。

    只按**第一个** ``||`` 切分（prompt 禁止段内出现 ``||``；即便模型违约，
    多出的 ``||`` 也只会留在行内文字里，不影响核对目标）。只有一段时行内
    文字为空——此时段落本身即展示文字（历史消息与格式漂移的退化路径）。
    """
    text = content.strip()
    if QUOTE_FIELD_SEP not in text:
        return text, ""
    quote, display = text.split(QUOTE_FIELD_SEP, 1)
    return quote.strip(), display.strip()


def _compose_citation(quote: str, display: str) -> str:
    """拼回标签内容：行内文字缺省时只写原句（避免出现空的第二段）。"""
    return f"{quote}{QUOTE_FIELD_SEP}{display}" if display else quote


def _source_identity(src: dict, fallback: int) -> tuple:
    """出处身份键：同一论文/同一上下文条目的重叠分块对定位而言等价。
    两个标识都缺失（不应该出现）时退化为按序号区分，绝不错误合并。"""
    pid, cid = src.get("paper_id"), src.get("context_id")
    if pid is None and cid is None:
        return ("__index__", fallback)
    return (pid, cid)


def _anchor_around(answer: str, start: int, end: int) -> str:
    """取引用标签位置前后相邻的句子片段（前句尾 + 后句头），作为多命中
    消歧与扩展模糊匹配的上下文锚点。

    刻意**不**把标签内摘录拼入锚句：多命中消歧时摘录对各候选完全相同、
    无信息量；零命中模糊匹配时非逐字摘录只会稀释旧机制在局部窗口上调优
    过的相似度比率。锚句定义与历史 ``extract_core_quote`` 的
    ``_answer_anchor_text`` 保持一致（机器标记剔除、句界切分、去空白）。
    """
    before = _MACHINE_MARK_RE.sub(" ", answer[max(0, start - _ANCHOR_RADIUS):start])
    after = _MACHINE_MARK_RE.sub(" ", answer[end:end + _ANCHOR_RADIUS])
    pre = re.split(rf"[{_ANSWER_SENT_BOUNDARY}]", before)[-1]
    post = re.split(rf"[{_ANSWER_SENT_BOUNDARY}]", after, maxsplit=1)[0]
    return _squash_ws((pre + post).lower())


def finalize_inline_answer(answer: str, sources: list[dict]) -> str:
    """流式/非流式共用的收口：为每个未决 ``[Q]原句||行内文字[/Q]`` 绑定出处
    并输出终态。

    绑定策略见模块头注释：逐字唯一命中即绑定；多命中先按出处身份归并、
    再用标签上下文句消歧；零命中走全分块扩展模糊匹配（段 1 改用分块真实
    原句）；都失败输出 ``[Q!]`` 失败卡。**段 2（行内文字）全程原样保留**——
    它是回答正文的一部分，绑定结果只影响段 1 与悬浮卡。返回终态答案文本。

    核对在**去噪匹配视图**上进行（见 :class:`_SourceView`）：页码与页眉页脚
    只在视图里剔除，原文一个字都不改。出处正文取 ``full_text``（完整材料），
    没有该键时退回 ``text``。
    """
    chunks = [s.get("full_text") or s.get("text") or "" for s in sources]
    views = [_build_source_view(c) for c in chunks]

    out: list[str] = []
    cursor = 0
    for m in INLINE_QUOTE_PENDING_RE.finditer(answer):
        out.append(answer[cursor:m.start()])
        quote, display = split_citation_fields(m.group(1))
        anchor = _anchor_around(answer, m.start(), m.end())
        state, index, final_quote = _bind_citation(quote, sources, views, anchor)
        body = f"[Q+{index}]" if state == "bound" else "[Q!]"
        out.append(f"{body}{_compose_citation(final_quote, display)}[/Q]")
        cursor = m.end()
    out.append(answer[cursor:])
    return "".join(out)


# ---------- 逐字核对的"去噪匹配视图" ----------
# 噪声（页码、页眉页脚）只在匹配视图里剔除，**原文一个字都不改**。模型引用
# 时可能带上噪声（PyMuPDF 把页眉页脚插进了正文中间），也可能把它删掉，
# 两种写法都必须能核对通过——因此同时保留"去噪视图"与"原文视图"两个比对面，
# 逐字比对时两边都试。规则与前端 src/utils/pdfLocate.ts 的镜像实现一致。
@dataclass
class _SourceView:
    """单个出处分块的匹配视图（原文 + 三种折叠形式的文本与下标映射）。"""

    raw: str              # 原文（从不改写）
    squashed: str         # 去噪 + 去空白
    raw_squashed: str     # 原文 + 去空白
    stripped: str         # 去噪 + 去空白 + 去标点
    raw_stripped: str     # 原文 + 去空白 + 去标点
    norm: str             # 去噪 + 小写 + 去空白（相似度打分用）
    offsets: list[int]    # norm 每个字符在 raw 中的下标


_STRIP_PUNCT_RE = re.compile(r"[\s\W_]+", re.UNICODE)


def _strip_punct(text: str) -> str:
    """去掉空白与标点（保留字母/数字/下划线），用于容忍中英标点差异。"""
    return _STRIP_PUNCT_RE.sub("", text)


def _build_source_view(raw: str) -> _SourceView:
    """为一个出处分块构造匹配视图（去噪、去空白、去标点、小写映射各一份）。"""
    running = textmatch.detect_running_lines(raw)
    norm, offsets = textmatch.normalize_for_match(raw, running)
    raw_squashed = textmatch.squash_ws(raw)
    squashed = textmatch.denoise_squash(raw, running)
    return _SourceView(
        raw=raw,
        squashed=squashed,
        raw_squashed=raw_squashed,
        stripped=_strip_punct(squashed),
        raw_stripped=_strip_punct(raw_squashed),
        norm=norm,
        offsets=offsets,
    )


def _is_verbatim_excerpt(quote: str, view: _SourceView) -> bool:
    """校验模型给出的逐字原句确为出处分块中**逐字连续**出现的片段（防编造/改写）。

    逐级放宽：先去空白逐字比对（兼容 PDF/排版空格差异），不通过再去掉标点
    比对一层（容忍模型把中文标点写成西文等微小出入）。每一层都在"去噪视图"
    与"原文视图"上各试一次——前者接受模型删掉了页码/页眉，后者接受模型把
    页码/页眉一并照抄（两种都是对原文的忠实转录）。
    """
    q = _squash_ws(quote)
    if len(q) < 6:
        return False
    if q in view.squashed or q in view.raw_squashed:
        return True
    q2 = _strip_punct(q)
    return len(q2) >= 6 and (q2 in view.stripped or q2 in view.raw_stripped)


def _score_anchor_against_chunk(
    anchor_norm: str, chunk_norm: str
) -> Optional[tuple[float, int, int]]:
    """上下文锚句对单个归一化分块打分。

    先在整个 chunk 上找最长连续重合（强证据：转述也会保留成片原词，
    要求 ≥10 字符），再在命中点周围的局部窗口上算相似度（直接对约
    900 字整 chunk 算 ratio 会被无关文本稀释），阈值 0.45。
    返回 ``(ratio, 窗口起, 窗口止)``（norm 坐标），不可靠返回 None。
    """
    if len(anchor_norm) < _ANCHOR_MIN_RUN:
        return None
    sm = SequenceMatcher(None, anchor_norm, chunk_norm, autojunk=False)
    m = sm.find_longest_match(0, len(anchor_norm), 0, len(chunk_norm))
    if m.size < _ANCHOR_MIN_RUN:
        return None
    w0 = max(0, m.b - len(anchor_norm))
    w1 = min(len(chunk_norm), m.b + m.size + len(anchor_norm))
    ratio = SequenceMatcher(
        None, anchor_norm, chunk_norm[w0:w1], autojunk=False
    ).ratio()
    if ratio < _ANCHOR_MIN_RATIO:
        return None
    # 以连续命中段为中心取 QUOTE_MAX_CHARS 窗口（norm 坐标）
    half = QUOTE_MAX_CHARS // 2
    center = (m.b + m.b + m.size) // 2
    start = max(0, min(m.b, center - half))
    end = min(len(chunk_norm), max(m.b + m.size, center + half))
    return ratio, start, end


def _raw_window(chunk: str, offsets: list[int], start: int, end: int) -> str:
    """把 norm 坐标窗口映射回 chunk 真实连续子串；英文边界切在单词中间时
    向两侧扩到词边界（仅 ASCII 字母数字；CJK 不扩，否则越过句界吞邻句）。"""
    raw_start, raw_end = offsets[start], offsets[end - 1] + 1
    while raw_start > 0 and chunk[raw_start - 1].isascii() and chunk[raw_start - 1].isalnum():
        raw_start -= 1
    while raw_end < len(chunk) and chunk[raw_end].isascii() and chunk[raw_end].isalnum():
        raw_end += 1
    return chunk[raw_start:raw_end].strip()


def _bind_citation(
    verbatim: str,
    sources: list[dict],
    views: list[_SourceView],
    anchor_norm: str,
) -> tuple[str, Optional[int], str]:
    """把一张未决引用卡的**段 1（逐字原句）**绑定到出处分块。

    :param verbatim: 模型给出的逐字原句（行内文字不参与核对）
    :param views: 与 sources 一一对应的去噪匹配视图
    :returns: ``("bound", 1-based 序号, 段 1 的最终文字)`` 或
              ``("failed", None, 模型原文（截断）)``。

    顺序：逐字唯一命中 → 绑定；多命中先按出处身份归并（重叠分块等价），
    仍跨材料则用锚句对候选打分消歧；零命中用锚句对全部材料扩展模糊
    匹配，命中则段 1 换成材料中的真实原句；全部失败返回失败卡。
    """
    ai_text = verbatim.strip()
    if not ai_text:
        return "failed", None, ""
    short = ai_text[:QUOTE_ACCEPT_MAX_CHARS]

    candidates = [
        i for i, view in enumerate(views)
        if view.raw and _is_verbatim_excerpt(ai_text, view)
    ]
    if len(candidates) == 1:
        return "bound", candidates[0] + 1, ai_text
    if len(candidates) > 1:
        identities = {_source_identity(sources[i], i) for i in candidates}
        if len(identities) == 1:
            # 同一材料的重复/重叠内容：定位目标等价，取材料序最前者
            return "bound", candidates[0] + 1, ai_text
        scored = [
            (i, _score_anchor_against_chunk(anchor_norm, views[i].norm))
            for i in candidates
        ]
        scored = [(i, s) for i, s in scored if s is not None]
        if scored:
            ranked = sorted(scored, key=lambda x: x[1][0], reverse=True)
            best_i, best_stats = ranked[0]
            runner_up = ranked[1][1][0] if len(ranked) > 1 else -1.0
            # 必须明确领先：等分词面对应不同材料时不能猜一个
            if best_stats[0] - runner_up >= _ANCHOR_DISAMBIG_MARGIN:
                return "bound", best_i + 1, ai_text
        # 跨材料多命中且上下文无法消歧：不能猜，按引用失败处理
        return "failed", None, short

    # 逐字零命中：模型改写或编造。用标签上下文句对全部材料扩展模糊匹配，
    # 命中则卡片改用材料中的真实原句（保留历史扩展上下文匹配机制）。
    best: Optional[tuple[int, float, int, int]] = None
    for i, view in enumerate(views):
        if not view.raw:
            continue
        scored = _score_anchor_against_chunk(anchor_norm, view.norm)
        if scored is None:
            continue
        ratio, start, end = scored
        if best is None or ratio > best[1]:
            best = (i, ratio, start, end)
    if best is not None:
        i, _ratio, start, end = best
        real = _raw_window(views[i].raw, views[i].offsets, start, end)
        if real:
            return "bound", i + 1, real
    return "failed", None, short


class RAGEngine:
    def __init__(self, client: LLMClient) -> None:
        self.client = client

    # ---------- 问答（材料直注，见模块头注释） ----------
    def prepare_answer(self, question: str, sources: list[dict],
                       paper: Optional[dict] = None,
                       history: Optional[list] = None,
                       grounded: bool = True,
                       tool_findings: Optional[list[dict]] = None) -> tuple[list[dict], list[dict]]:
        """材料直注 + 组装 prompt（流式 / 非流式共用）。

        材料由工具循环读取后**原样**注入（每条一个 ``[Source N]`` 段落），不再
        分块、不再检索：旧实现在此用 BM25 挑 TOP_K 分块，词面零重合时只喂论文
        开头几块，模型据此以为"材料里没有相关内容"（实测：中文提问「双线性
        插值」对英文论文得分 0，于是只拿到封面与题录）。

        :param history: 精简对话历史（仅 user/assistant 文字，不含全文与出处详情）
        :param grounded: True（默认）= 必须基于材料作答，材料里没有正文时抛
            ValueError；False = 允许在**无任何材料**时仅凭模型通用知识作答
            （调用方负责先向用户发出"无材料"提示）。
        :param tool_findings: ReAct 工具循环**本轮已经拿到**的检索发现
            [{"label": str, "content": str}]。最终回答是一次无状态的新调用，
            工具循环里的 thought/observation 不会自动延续——paper_search 明明
            检到几十篇文献，最终模型却看不到、只能老实回答"我无法联网检索"。
            这里把回执作为独立段落注入 user，并限定：可转述/列举/对比其中的
            题录与摘要片段，但逐字 [Q] 引用仍只能来自下方 Sources 段落。
        :returns: (sources_out, messages)
                  sources_out：出处分块
                  [{"index","label","context_id","paper_id","text","score","full_text"}]；
                  ``text`` 是给前端做 PDF 定位兜底的短预览，``full_text`` 是完整
                  材料正文、**仅供后端行内引用核对**（路由层发给前端前剔除）。
                  messages：发给 LLM 的对话（system + 历史 + user）
        """
        passages: list[dict] = []
        for src in sources:
            text = (src.get("text") or "").strip()
            if not text:
                continue
            passages.append({
                "label": src.get("label", ""),
                "context_id": src.get("context_id"),
                "paper_id": src.get("paper_id"),
                "text": text,
            })

        if not passages:
            if grounded:
                # 调用方在无材料时走 grounded=False；走到这里说明材料存在但正文全空
                raise ValueError(tr("rag.no_readable_passages"))
            # 无材料模式：组装"通用知识作答"对话
            return self._prepare_unguided_answer(
                question, paper, history, tool_findings=tool_findings,
            )

        title = (paper or {}).get("title", "")
        year = (paper or {}).get("year")
        authors = (paper or {}).get("authors", []) or []
        author_str = ", ".join(authors[:3])
        if len(authors) > 3:
            author_str += " et al."

        prompt_sources = "\n\n".join(
            f"[Source {i + 1} - {p['label']}]\n{p['text']}"
            for i, p in enumerate(passages)
        )

        system = (
            "You are PaperMind, the AI research assistant embedded in a three-column "
            "research desktop: a PDF reader for the currently open paper on the left, "
            "a LaTeX editor on the right, and a Q&A panel with a context library in "
            "the middle. You help the researcher think: answer grounded in the "
            "provided sources, then go further by connecting and extending them.\n\n"
            "=== ENVIRONMENT ===\n"
            "- The currently open paper's metadata is stated in the User message;\n"
            "  its full text appears in the sources below only if it was actually\n"
            "  read this turn.\n"
            "- Other sources (tagged with a context id) come from the researcher's "
            "context library; they may be papers or web pages.\n"
            "- Earlier turns may be included as conversation history; they are "
            "context only and do not add sources beyond the ones listed below.\n"
            "- The sources below are delimited by [Source N - ...] headers for "
            "your reading only — the numbers are NOT citation keys and must "
            "never appear in your answer. Tracing works automatically: you "
            "embed a verbatim copy of the source sentence and the system finds "
            "which source it came from.\n\n"
            "=== RESPONSE RULES ===\n"
            "1. Ground facts in the sources. Facts, figures, results, claims and "
            "methods taken from a source must be quoted VERBATIM as COMPLETE "
            "sentences (from the start of a sentence to its period, word-for-word, "
            "never paraphrased or truncated), wrapped in an inline citation tag "
            "at the exact point where you use the fact (rule 7).\n"
            "2. Synthesize and reason beyond quotation — this is your core value. "
            "Connect ideas across sources: compare and contrast papers, reconcile "
            "conflicting claims, chain their conclusions toward the question, "
            "transfer methods or findings to the researcher's own problem, and "
            "explore implications, including cross-disciplinary links the sources "
            "do not spell out.\n"
            "3. Never dress up an inference as a source fact. When you go beyond "
            "what the quoted material states, frame it explicitly (\"the sources "
            "imply that ...\", \"one could hypothesize ...\", \"by analogy, ...\", "
            "\"this suggests ...\"), so verbatim-quoted facts stay visibly sourced "
            "and your analysis stays visibly yours.\n"
            "4. Use Markdown structure: short headings, bullets, bold key terms, "
            "and tables when useful, so the answer is easy to scan.\n"
            "5. If the materials genuinely do not support the question even after "
            "reasonable synthesis, say so explicitly, explain what is missing, and "
            "suggest what to search for or add — never fabricate.\n"
            "6. Answer in the language of the question.\n"
            "7. Inline citations — the citation IS part of the sentence, not a "
            "footnote. Whenever you state a fact taken from a source, embed a "
            "citation tag at that exact spot, in EXACTLY this form:\n"
            "[Q]<one core sentence copied VERBATIM from a source>||<short "
            "inline wording>[/Q]\n"
            "   - The tag holds TWO parts separated by the two-character "
            "sequence || — never write || anywhere else inside the tag:\n"
            "     PART 1 (before ||) is a CONTINUOUS, CHARACTER-FOR-CHARACTER "
            "copy from one source block (never rephrased, translated, "
            "abbreviated or stitched together), in the source's own language "
            "and punctuation, ≤80 characters, one sentence (at most two) — the "
            "single sentence that best supports the claim at that spot. It is "
            "what the system verifies against the sources and what the reader "
            "sees as the exact quotation when hovering the citation. Short or "
            "non-verbatim part 1 cannot be matched and will be shown as a "
            "failed citation.\n"
            "     PART 2 (after ||) is the text that ACTUALLY APPEARS in your "
            "answer at that spot: a short clause, in the answer's language, "
            "that restates the core of part 1 (or condenses it), written so "
            "that the surrounding sentence reads naturally and grammatically. "
            "≤60 characters, plain text (no markdown emphasis, no surrounding "
            "quotation marks). Part 1 stays in the source's language; only "
            "part 2 follows the answer's language. If part 1 already reads "
            "perfectly in place, repeat it as part 2.\n"
            "   - NO number inside the tag: the system locates the source by "
            "matching part 1 itself. Never write [Source N] or [Q:N] "
            "in your answer.\n"
            "   - The tag may sit in the MIDDLE of your sentence, right where "
            "the fact is used, e.g. \"The model reaches [Q]We report a top-1 "
            "accuracy of 85.3% on ImageNet.||85.3% top-1 accuracy on "
            "ImageNet[/Q], which suggests ...\"; it may also sit right after "
            "the sentence. The reader sees only part 2 inline; part 1 appears "
            "on hover. Each citation card is independent — cite the same "
            "source as many times as you use it.\n"
            "   - Never place a tag inside a heading or a table cell; for a "
            "fact in a table, put the tag in the sentence right after the "
            "table.\n"
            "   - Do NOT append any trailing quote list or manifest, and do not "
            "output any other machine-readable block. If a claim has no "
            "verbatim source sentence worth quoting, state it as your own "
            "analysis without a tag.\n"
        )
        user = (
            f"Currently open paper: \"{title}\" ({year}) by {author_str}.\n\n"
            if title else "Currently open paper: not loaded.\n\n"
        )
        findings_note = self._format_tool_findings(tool_findings)
        if findings_note:
            user += findings_note
        user += (
            f"Sources:\n{prompt_sources}\n\nQuestion: {question}\n\n"
            "Embed the [Q]<verbatim sentence>||<inline wording>[/Q] citations "
            "inline within your answer exactly as specified in response rule 7 "
            "(both parts, no numbers, no source tags)."
        )

        sources_out = [
            {
                "index": i + 1,
                "label": p["label"],
                "context_id": p["context_id"],
                "paper_id": p["paper_id"],
                # text 只作为"模型没给原句时"的 PDF 定位兜底，截短以控制传输体积；
                # full_text 是完整材料正文，仅供后端行内引用核对，路由层发给前端前剔除
                "text": p["text"][:SOURCE_FALLBACK_CHARS],
                "full_text": p["text"],
                # 已取消检索打分：score 只是前端类型要求的占位（界面不展示）
                "score": 0.0,
            }
            for i, p in enumerate(passages)
        ]
        messages = [{"role": "system", "content": system}]
        for h in _normalize_history(history):
            messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": user})
        return sources_out, messages

    @staticmethod
    def _format_tool_findings(findings: Optional[list[dict]]) -> str:
        """把 ReAct 循环本轮的工具回执格式化为最终回答可见的"检索发现"段落。

        最终回答是一次**无状态新调用**：工具循环中的 thought/observation 不会
        自动延续，若不显式带入，paper_search 明明已检到文献，最终模型仍会如实
        回答"我无法联网检索"（实测故障）。回执文本是给调度器看的工作记录，
        不是可逐字引用的正文，因此段落中明确：可转述/列举/对比题录与摘要片段，
        但 [Q] 标签只能引用 Sources 中逐字出现的句子；导图工具结果用于制止
        "文字版思维导图"。
        """
        items: list[str] = []
        for f in findings or []:
            label = (f.get("label") or "").strip()
            content = (f.get("content") or "").strip()
            if label and content:
                items.append(f"### Tool result — {label}\n{content}")
        if not items:
            return ""
        return (
            "=== TOOL FINDINGS ALREADY RETRIEVED THIS TURN ===\n"
            "The agent loop already executed the tools below in THIS SAME turn and "
            "obtained these results. They are real, current evidence available to you:\n"
            "- Where they list retrieved papers, treat them as external literature "
            "you genuinely have access to. NEVER claim that you cannot search, "
            "cannot access the internet, or have no retrieved papers — that would "
            "directly contradict this turn's actual tool results.\n"
            "- You may summarize, list, compare and reason over the titles, authors, "
            "years, venues, citation counts and abstract snippets, attributing each "
            "item by its title, year and source.\n"
            "- This digest is an operational transcript, NOT a quotation target. "
            "PART 1 of a [Q] tag may contain ONLY a sentence copied verbatim from "
            "the Sources blocks below; never wrap digest text in a [Q] tag (digest "
            "material may still be paraphrased in your own prose, without a tag).\n"
            "- If a mindmap tool result says a map was created or updated, tell the "
            "user the map is ready in the mindmap view (use its real title); NEVER "
            "draw a text / ASCII / Markdown tree as a substitute for the actual map. "
            "If the map is only an empty root skeleton, say so honestly and offer to "
            "fill it on request.\n\n"
            + "\n\n".join(items)
            + "\n\n"
        )

    def _prepare_unguided_answer(self, question: str,
                                 paper: Optional[dict],
                                 history: Optional[list],
                                 tool_findings: Optional[list[dict]] = None,
                                 ) -> tuple[list[dict], list[dict]]:
        """组装"无检索材料"的回答对话：仅凭模型通用知识作答，并明确标注未核实。

        与 :meth:`prepare_answer` 的 grounded 路径共用 persona 与历史规整，
        但不包含任何 [Source N] 段落；若用户当前打开着论文（仅拿到元数据、
        全文不可读），把标题/作者/年份告知模型——它可能凭公开知识认识该论文，
        但必须显式标注不确定性。``tool_findings`` 非空时（本轮工具确有检索
        回执，只是没有可切分的全文段落），不能对模型谎称"外部工具什么也没
        检索到"。
        """
        findings_note = self._format_tool_findings(tool_findings)
        title = (paper or {}).get("title", "")
        year = (paper or {}).get("year")
        authors = (paper or {}).get("authors", []) or []
        author_str = ", ".join(authors[:3])
        if len(authors) > 3:
            author_str += " et al."

        if findings_note:
            no_material_clause = (
                "No readable full-text source blocks are available this turn, BUT "
                "the tool findings below DO contain real results retrieved this "
                "turn — use them as instructed there and never deny their existence; "
                "only verbatim quotations are unavailable because no source blocks "
                "were retrieved."
            )
        else:
            no_material_clause = (
                "No readable source material is available: the open paper's full text "
                "could not be read, the context library provided nothing, and external "
                "tools retrieved nothing usable. You must STILL answer the user's "
                "question helpfully, using your own general knowledge."
            )
        system = (
            "You are PaperMind, the AI research assistant embedded in a researcher's "
            "desktop (PDF reader + context library + Q&A panel).\n\n"
            "=== IMPORTANT: NO RETRIEVED SOURCE BLOCKS THIS TURN ===\n"
            f"{no_material_clause}\n\n"
            "=== RESPONSE RULES ===\n"
            "1. Answer the question directly and substantively. If (and only if) no "
            "tool findings are present, state near the start in one short sentence "
            "that the answer is based on your general knowledge rather than retrieved "
            "sources and may be outdated or inaccurate, and that opening a paper or "
            "adding context enables a grounded answer.\n"
            "2. Never fabricate citations, [Source N] tags, quotes, figures, or "
            "claims that you pretend came from a specific paper. If the open paper "
            "is identified in the User message, you may share what you generally "
            "know about it but mark uncertainty explicitly.\n"
            "3. Prefer well-established facts; flag speculative or fast-moving "
            "information as such. Suggest concrete material the user could add.\n"
            "4. Use Markdown structure (short headings, bullets, bold key terms) so "
            "the answer is easy to scan.\n"
            "5. Answer in the language of the question.\n"
        )
        user = (
            f"Currently open paper: \"{title}\" ({year}) by {author_str}.\n"
            if title else "Currently open paper: not loaded.\n"
        )
        user += "No retrieved source blocks are available for this turn.\n\n"
        if findings_note:
            user += findings_note
        user += f"Question: {question}"

        messages = [{"role": "system", "content": system}]
        for h in _normalize_history(history):
            messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": user})
        return [], messages

    def stream_answer(self, question: str, sources: list[dict],
                      paper: Optional[dict] = None,
                      history: Optional[list] = None,
                      grounded: bool = True,
                      tool_findings: Optional[list[dict]] = None):
        """流式问答生成器（供 SSE 使用）。

        :param grounded: False 时允许 sources 为空（或全部不可切分），走通用
            知识作答路径（首帧 sources 为空列表）。
        :param tool_findings: 本轮 ReAct 工具循环已获得的检索发现，透传至
            prompt 组装（见 :meth:`prepare_answer`）。
        :yields: dict 事件：
            {"type": "sources", "sources": [...]}  首帧，出处分块（无材料时为 []）
            {"type": "delta", "delta": str}        每个回答文本增量
        """
        sources_out, messages = self.prepare_answer(
            question, sources, paper, history,
            grounded=grounded, tool_findings=tool_findings,
        )
        yield {"type": "sources", "sources": sources_out}
        for delta in self.client.chat_stream(messages, temperature=0.2):
            yield {"type": "delta", "delta": delta}


def build_rag_engine() -> RAGEngine:
    """工厂：按当前配置构造 RAG 引擎；未配置 key 时抛出明确错误。"""
    return RAGEngine(LLMClient())
