"""AI 自动写作工具组（function calling）。

六个工具注册进默认工具表，仅在"打开了写作工作区"的问答中可用（全局问答调用
返回可预期失败，不抛异常打断 ReAct）：

- ``list_files``：列工作区文本文件（tex/bib/cls/sty/bst/bbl）；
- ``read_file``：按相对路径读文件，回执带行号与内容 hash（edit 的版本依据）；
- ``edit_file``：SEARCH/REPLACE 唯一锚点批量编辑，原子应用、直接写盘；
- ``create_file``：新建 tex/bib 文件，可选同时向 main.tex 插 ``\\input``；
- ``add_bib_entries``：论文元数据 → BibTeX 条目追加 .bib（去重）并接线 main.tex；
- ``compile_document``：真实编译 main.tex，回执给结构化错误清单。

写入模型 = 边写边审（Cursor Agent/Claude Code 模式）：工具成功即写盘，
每个编辑块落 writing_revisions（pending），SSE 推 document_diff 在编辑器内联
高亮，用户逐块接受（仅消标记）/拒绝（反向还原）或整事务回滚。

请求级语义经 ``execute(arguments, context)`` 注入（/rag/stream 每请求构造）：

- ``scope``：''=全局（写作工具不可用），'ws:<id>'=当前工作区；
- ``transaction_id``：本次问答共享（与导图编辑同事务，一问一撤销）；
- ``run_id``：RAG 运行 id（落修订行，便于排查）；
- ``writing_events``：list，写操作/编译后追加 SSE 载荷，路由层逐条推送：
  document_diff（hunks 内联审核）、document_created（刷新文件树）、
  compile_result（编译面板/PDF 刷新）。
"""
from __future__ import annotations

from typing import Any, Optional

import storage.db as db
import storage.workspace as ws
from i18n import tr
from llm.tools import BaseTool, ToolResult
from services import bibtex, writing_edit as we
from services.latex_build import (
    MAIN_TEX,
    compile_workspace,
    ensure_main_tex,
    parse_log_errors,
)
from storage.workspace import WorkspaceError

#: 写操作允许的扩展名
WRITE_EXTENSIONS = (".tex", ".bib")
#: list_files 展示的文本文件扩展名
LIST_EXTENSIONS = (".tex", ".bib", ".cls", ".sty", ".bst", ".bbl")
#: 默认文献库文件名
DEFAULT_BIB = "references.bib"
#: 回执日志尾部字符数
LOG_TAIL_CHARS = 1500


# ---------- 请求级辅助 ----------
def _ws_id(context: Optional[dict]) -> Optional[str]:
    """从 context.scope（'ws:<id>' / ''）解出工作区裸 id；全局问答返回 None。"""
    scope = (context or {}).get("scope") or ""
    if scope.startswith("ws:") and len(scope) > 3:
        return scope[3:]
    return None


def _txn(context: Optional[dict]) -> str:
    return (context or {}).get("transaction_id") or ""


def _events(context: Optional[dict]) -> list[dict]:
    events = (context or {}).get("writing_events")
    return events if isinstance(events, list) else []


def _validate_path(ws_id: str, raw: str, allowed: tuple[str, ...]) -> str:
    """归一化并校验相对路径（POSIX、白名单后缀、不越界），非法抛 ValueError。"""
    path = (raw or "").replace("\\", "/").strip().lstrip("./")
    if not path:
        raise ValueError(tr("writing.bad_path"))
    # resolve 拒绝 .. 穿越/绝对路径/非法字符；不要求文件已存在
    ws.resolve(ws_id, path)
    if not path.lower().endswith(allowed):
        raise ValueError(tr(
            "writing.ext_not_allowed",
            allowed="/".join(allowed), path=path,
        ))
    return path


def _read_body(ws_id: str, path: str) -> tuple[str, str, str]:
    """读盘 → (原始文本, LF 正文, 主导行尾)。"""
    raw = ws.read_text(ws_id, path)
    return raw, we.normalize_eol(raw), we.detect_eol(raw)


def _write_body(ws_id: str, path: str, body_lf: str, eol: str) -> str:
    ws.write_text(ws_id, path, we.restore_eol(body_lf, eol))
    return we.content_hash(body_lf)


def _hunk(rev: dict, edit: we.AppliedEdit, action_kind: str) -> dict:
    return {
        "id": rev["id"],
        "kind": action_kind,
        "oldStart": edit.old_start,
        "oldLines": edit.old_lines,
        "newStart": edit.new_start,
        "newLines": edit.new_lines,
        "oldText": edit.old_text,
        "newText": edit.new_text,
    }


def _emit_diff(events: list[dict], *, path: str, txn: str,
               hunks: list[dict], new_hash: str) -> None:
    events.append({
        "kind": "diff", "path": path, "transactionId": txn,
        "hunks": hunks, "newHash": new_hash,
    })


def _failure_text(failures: list[we.ActionFailure]) -> str:
    lines = [tr("writing.failures_header", count=len(failures))]
    for f in failures:
        idx = f.index + 1
        if f.code == "not_found":
            if f.candidates:
                lines.append(tr(
                    "writing.fail_not_found",
                    index=idx, candidates=", ".join(str(x) for x in f.candidates),
                ))
            else:
                lines.append(tr("writing.fail_not_found_no_hint", index=idx))
        elif f.code == "multiple":
            lines.append(tr(
                "writing.fail_multiple",
                index=idx, count=len(f.occurrences),
                lines=", ".join(str(x) for x in f.occurrences),
            ))
        elif f.code == "empty_block":
            lines.append(tr("writing.fail_empty", index=idx))
        elif f.code == "same":
            lines.append(tr("writing.fail_same", index=idx))
    return "\n".join(lines)


# ---------- 工具：list_files ----------
class ListWritingFilesTool(BaseTool):
    name = "list_files"
    description = (
        "列出当前写作工作区中的文本文件（.tex/.bib/.cls/.sty/.bst/.bbl），"
        "返回相对路径、行数与大小（PDF/编译辅助产物不显示）。"
        "开始写作或不确定工作区结构（main.tex 在何处 \\input 了哪些章节文件、"
        ".bib 在哪里）时，应先调用本工具。仅在打开了写作工作区时可用。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "type": {
                "type": "string",
                "enum": ["all", "tex", "bib"],
                "description": "过滤类型：all=全部文本文件（默认）；tex=仅 .tex；bib=仅 .bib",
            },
        },
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        ws_id = _ws_id(context)
        if ws_id is None:
            return ToolResult(tr("writing.no_workspace"))
        kind = arguments.get("type", "all")
        try:
            files = ws.list_files(ws_id)
        except WorkspaceError as exc:
            return ToolResult(str(exc))
        rows = []
        for f in files:
            path = f["path"]
            if not path.lower().endswith(LIST_EXTENSIONS):
                continue
            if kind == "tex" and not path.lower().endswith(".tex"):
                continue
            if kind == "bib" and not path.lower().endswith(".bib"):
                continue
            try:
                text = ws.read_text(ws_id, path)
                lines = text.count("\n") + 1
            except (OSError, WorkspaceError):
                lines = 0
            rows.append(f"- {path}（{lines} 行，{f['size']} 字节）")
        if not rows:
            return ToolResult(tr("writing.list_empty"))
        return ToolResult(
            tr("writing.list_header", n=len(rows)) + "\n" + "\n".join(rows))


# ---------- 工具：read_file ----------
class ReadWritingFileTool(BaseTool):
    name = "read_file"
    description = (
        "读取写作工作区中的文件并返回带行号的内容（编辑锚点必须逐字取自这里）。"
        "path 为相对路径（POSIX 风格），省略时读 main.tex（不存在会自动创建骨架）。"
        "回执头部含文件 hash：随后 edit_file 可带 expect_hash，若文件在此期间被"
        "改动会直接失败，避免覆盖。文件较大时用 start_line/end_line 分段读，"
        "不要凭猜测构造锚点。仅在打开了写作工作区时可用。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "相对路径，缺省 main.tex"},
            "start_line": {"type": "integer", "description": "起始行（1 基，含）"},
            "end_line": {"type": "integer", "description": "结束行（1 基，含）"},
        },
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        ws_id = _ws_id(context)
        if ws_id is None:
            return ToolResult(tr("writing.no_workspace"))
        raw_path = (arguments.get("path") or "").strip() or MAIN_TEX
        try:
            path = _validate_path(ws_id, raw_path, LIST_EXTENSIONS)
        except ValueError as exc:
            return ToolResult(str(exc))

        notes: list[str] = []
        try:
            if path == MAIN_TEX and not ws.exists(ws_id, MAIN_TEX):
                ensure_main_tex(ws_id)
                notes.append(tr("writing.main_missing"))
            _raw, body, _eol = _read_body(ws_id, path)
        except WorkspaceError:
            return ToolResult(tr("writing.file_not_found", path=path))

        total = body.count("\n") + 1
        start = arguments.get("start_line")
        end = arguments.get("end_line")
        if not (start is None or isinstance(start, int) and not isinstance(start, bool)):
            return ToolResult(tr("writing.range_bad", total=total, start=start, end=end))
        if not (end is None or isinstance(end, int) and not isinstance(end, bool)):
            return ToolResult(tr("writing.range_bad", total=total, start=start, end=end))
        try:
            sliced, total, _n = we.numbered_slice(body, start, end)
        except we.EditEngineError as exc:
            msg = str(exc)
            if msg.startswith("range too large"):
                return ToolResult(tr(
                    "writing.range_too_large", limit=we.READ_MAX_CHARS))
            return ToolResult(tr(
                "writing.range_bad", total=total, start=start, end=end))

        header = tr("writing.read_header",
                    path=path, total=total, hash=we.content_hash(body)[:12])
        parts = [header]
        if start is not None or end is not None:
            parts.append(tr(
                "writing.read_range",
                start=start or 1, end=end or total))
        parts.append(sliced)
        if notes:
            parts.extend(notes)
        return ToolResult("\n".join(parts))


# ---------- 工具：edit_file ----------
class EditWritingFileTool(BaseTool):
    name = "edit_file"
    description = (
        "对写作工作区中的文件做一批精确修改（全部成功才写盘，任一锚点失配整批不写入）。"
        "编辑前必须先 read_file：锚点必须与文件**逐字一致且全文唯一**（含缩进、标点、换行）。\n"
        "动作类型：\n"
        "1) replace 替换：{kind:\"replace\", old, new}；old 必须唯一命中，零命中或"
        "多命中都会失败并回传候选行号，请扩大上下文消歧后整批重试；\n"
        "2) insert_before / insert_after 插入：{kind:\"insert_before\"|\"insert_after\","
        " anchor, text}；anchor 同样必须唯一。\n"
        "单批最多 20 个动作、单块 ≤8000 字符；跨多处大改用多批。\n"
        "可选 expect_hash：传 read_file 回执中的 hash，文件被用户改动过会失败而不是覆盖。"
        "修改立即写盘并在编辑器高亮待用户审核，你可以继续后续编辑；不要删除与任务"
        "无关的用户内容。仅 .tex/.bib 可编辑。仅在打开了写作工作区时可用。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "目标文件相对路径"},
            "actions": {
                "type": "array",
                "description": "动作数组（1..20），按顺序应用",
                "items": {"type": "object"},
            },
            "expect_hash": {
                "type": "string",
                "description": "可选：read_file 时拿到的 hash（完整 64 位或回执前缀均可，前缀需≥12 位）",
            },
        },
        "required": ["path", "actions"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        ws_id = _ws_id(context)
        if ws_id is None:
            return ToolResult(tr("writing.no_workspace"))
        txn = _txn(context)
        events = _events(context)

        try:
            path = _validate_path(ws_id, arguments.get("path") or "", WRITE_EXTENSIONS)
        except ValueError as exc:
            return ToolResult(str(exc))
        actions = arguments.get("actions")
        if not isinstance(actions, list) or not actions:
            return ToolResult(tr("writing.actions_empty"))
        if len(actions) > we.MAX_ACTIONS:
            return ToolResult(tr(
                "writing.actions_limit", limit=we.MAX_ACTIONS, count=len(actions)))
        for a in actions:
            if not isinstance(a, dict):
                return ToolResult(tr("writing.actions_empty"))
            blob = sum(len(str(a.get(k) or "")) for k in ("old", "new", "anchor", "text"))
            if blob > we.MAX_BLOCK_CHARS * 2:
                return ToolResult(tr("writing.block_too_large", limit=we.MAX_BLOCK_CHARS))

        if not ws.exists(ws_id, path):
            return ToolResult(tr("writing.file_not_found", path=path))
        try:
            _raw, body, eol = _read_body(ws_id, path)
        except WorkspaceError:
            return ToolResult(tr("writing.file_not_found", path=path))

        expect_hash = (arguments.get("expect_hash") or "").strip().lower()
        current_hash = we.content_hash(body)
        if expect_hash and not current_hash.startswith(expect_hash):
            return ToolResult(tr("writing.hash_mismatch"))

        base_hash = current_hash
        try:
            result = we.apply_actions(body, actions)
        except we.EditEngineError as exc:
            return ToolResult(str(exc))
        if isinstance(result, list):
            return ToolResult(_failure_text(result))

        new_body = result.text
        new_hash = _write_body(ws_id, path, new_body, eol)
        hunks: list[dict] = []
        for edit in result.applied:
            seq = db.next_writing_seq(txn)
            rev_id = db.insert_writing_revision(
                run_id=(context or {}).get("run_id") or "",
                transaction_id=txn, scope=f"ws:{ws_id}", rel_path=path, seq=seq,
                action_kind="edit", old_text=edit.old_text, new_text=edit.new_text,
                base_hash=base_hash, new_hash=new_hash,
            )
            rev = db.get_writing_revision(rev_id)
            hunks.append(_hunk(rev, edit, "edit"))
        _emit_diff(events, path=path, txn=txn, hunks=hunks, new_hash=new_hash)
        return ToolResult(tr(
            "writing.edit_done", path=path,
            count=len(result.applied), hash=new_hash[:12]))


# ---------- 工具：create_file ----------
class CreateWritingFileTool(BaseTool):
    name = "create_file"
    description = (
        "在写作工作区新建文件（tex/bib），已存在同名文件时失败（绝不覆盖）。"
        "新建章节 .tex 时可传 add_input=true：自动在 main.tex 的 \\end{document} "
        "前插入 \\input{不带后缀的相对路径}。新文件内容用完整全文写入。"
        "仅在打开了写作工作区时可用。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "新文件相对路径（父目录自动创建）"},
            "content": {"type": "string", "description": "文件完整内容"},
            "add_input": {
                "type": "boolean",
                "description": "仅对 .tex：同时在 main.tex 中加入 \\input{...}",
            },
        },
        "required": ["path", "content"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        ws_id = _ws_id(context)
        if ws_id is None:
            return ToolResult(tr("writing.no_workspace"))
        txn = _txn(context)
        events = _events(context)

        try:
            path = _validate_path(ws_id, arguments.get("path") or "", WRITE_EXTENSIONS)
        except ValueError as exc:
            return ToolResult(str(exc))
        content = arguments.get("content")
        if not isinstance(content, str) or not content.strip():
            return ToolResult(tr("writing.actions_empty"))
        if ws.exists(ws_id, path):
            return ToolResult(tr("writing.file_exists", path=path))

        body = we.normalize_eol(content)
        new_hash = _write_body(ws_id, path, body, "\n")
        seq = db.next_writing_seq(txn)
        db.insert_writing_revision(
            run_id=(context or {}).get("run_id") or "",
            transaction_id=txn, scope=f"ws:{ws_id}", rel_path=path, seq=seq,
            action_kind="create", old_text="", new_text=body,
            base_hash="", new_hash=new_hash,
        )
        events.append({"kind": "created", "path": path, "transactionId": txn})

        notes = [tr("writing.create_done", path=path,
                    lines=body.count("\n") + 1, hash=new_hash[:12])]

        # 可选：把 \input 接线进 main.tex（同事务修订，可一起回滚）
        if arguments.get("add_input") and path.lower().endswith(".tex"):
            name = path[:-4] if path.lower().endswith(".tex") else path
            wired = self._wire_input(ws_id, txn, context, events, name)
            if isinstance(wired, ToolResult):
                # 文件已建成，接线失败不回滚文件：给出可操作原因让 LLM 处理
                return ToolResult(notes[0] + "\n" + wired.content)
            notes.append(tr("writing.input_done", name=name))
        return ToolResult("\n".join(notes))

    @staticmethod
    def _wire_input(ws_id: str, txn: str, context: dict,
                    events: list[dict], name: str) -> Optional[ToolResult]:
        cmd = f"\\input{{{name}}}"
        ensure_main_tex(ws_id)
        _raw, main_body, eol = _read_body(ws_id, MAIN_TEX)
        if cmd in main_body:
            return None  # 已接好，幂等
        action = {"kind": "insert_before", "anchor": r"\end{document}",
                  "text": cmd + "\n"}
        base_hash = we.content_hash(main_body)
        result = we.apply_actions(main_body, [action])
        if isinstance(result, list):
            return ToolResult(_failure_text(result))
        edit = result.applied[0]
        new_hash = _write_body(ws_id, MAIN_TEX, result.text, eol)
        seq = db.next_writing_seq(txn)
        rev_id = db.insert_writing_revision(
            run_id=context.get("run_id") or "",
            transaction_id=txn, scope=f"ws:{ws_id}", rel_path=MAIN_TEX, seq=seq,
            action_kind="input", old_text=edit.old_text, new_text=edit.new_text,
            base_hash=base_hash, new_hash=new_hash,
        )
        rev = db.get_writing_revision(rev_id)
        _emit_diff(events, path=MAIN_TEX, txn=txn,
                   hunks=[_hunk(rev, edit, "input")], new_hash=new_hash)
        return None


# ---------- 工具：add_bib_entries ----------
class AddBibEntriesTool(BaseTool):
    name = "add_bib_entries"
    description = (
        "把系统文献库中的论文生成 BibTeX 条目并追加到工作区 .bib 文件（默认 "
        "references.bib，不存在则创建），按 DOI/arXiv/cite key 去重；同时自动把"
        "文献资源接入 main.tex（检测 biblatex 用 \\addbibresource+\\printbibliography，"
        "否则用经典 \\bibliography）。回执返回每篇论文的 cite key——之后在正文里"
        "用 edit_file 插入 \\cite{key}（本工具不改正文）。paper_ids 取自 paper_search/"
        "read_paper 返回的标准论文 id。仅在打开了写作工作区时可用。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "paper_ids": {"type": "array", "items": {"type": "string"},
                          "description": "论文标准 id 列表（source:external_id 形式）"},
            "bib_path": {"type": "string", "description": "目标 .bib 相对路径，缺省 references.bib"},
        },
        "required": ["paper_ids"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        ws_id = _ws_id(context)
        if ws_id is None:
            return ToolResult(tr("writing.no_workspace"))
        txn = _txn(context)
        events = _events(context)

        raw_ids = arguments.get("paper_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            return ToolResult(tr("writing.actions_empty"))
        try:
            bib_path = _validate_path(
                ws_id, (arguments.get("bib_path") or "").strip() or DEFAULT_BIB,
                (".bib",))
        except ValueError as exc:
            return ToolResult(str(exc))

        papers, missing = [], []
        for pid in [str(x).strip() for x in raw_ids if str(x).strip()]:
            paper = db.get_paper(pid)
            (papers if paper else missing).append(paper or pid)

        bib_existed = ws.exists(ws_id, bib_path)
        existing = ws.read_text(ws_id, bib_path) if bib_existed else ""
        existing_lf = we.normalize_eol(existing)
        eol_bib = we.detect_eol(existing) if bib_existed else "\n"

        results = bibtex.build_entries(papers, existing_lf)
        added = [r for r in results if r["status"] == "added"]
        dupes = [r for r in results if r["status"] == "duplicate"]
        notes: list[str] = []
        for pid in missing:
            notes.append(tr("writing.paper_not_found", paper_id=pid))
        for r in dupes:
            notes.append(tr("writing.bib_dup", paper_id=r["paper_id"], reason=r["reason"]))

        if not added:
            notes.append(tr("writing.bib_none", bib=bib_path))
            return ToolResult("\n".join(notes))

        entries_text = "".join(r["entry"] for r in added)
        # 拼接块：与旧内容之间恰好一个空行；整块作为 append 修订（反向时整块移除）
        prefix = "" if not existing_lf.strip() else (
            "" if existing_lf.endswith("\n\n") else "\n" if existing_lf.endswith("\n") else "\n\n")
        block = prefix + entries_text
        new_bib = existing_lf + block
        base_hash = we.content_hash(existing_lf)
        new_hash = _write_body(ws_id, bib_path, new_bib, eol_bib)
        seq = db.next_writing_seq(txn)
        append_rev_id = db.insert_writing_revision(
            run_id=(context or {}).get("run_id") or "",
            transaction_id=txn, scope=f"ws:{ws_id}", rel_path=bib_path, seq=seq,
            action_kind="append", old_text="", new_text=block,
            base_hash=base_hash, new_hash=new_hash,
        )
        if not bib_existed:
            events.append({"kind": "created", "path": bib_path, "transactionId": txn})
        # append 的内联位置：旧文件末尾之后
        append_line = existing_lf.count("\n") + 1 if existing_lf.strip() else 1
        events.append({
            "kind": "diff", "path": bib_path, "transactionId": txn,
            "hunks": [{
                "id": append_rev_id,
                "kind": "append",
                "oldStart": append_line, "oldLines": 0,
                "newStart": append_line,
                "newLines": block.count("\n") + (0 if block.endswith("\n") else 1),
                "oldText": "", "newText": block,
            }],
            "newHash": new_hash,
        })
        notes.append(tr(
            "writing.bib_added", bib=bib_path, count=len(added),
            keys=", ".join(f"{r['paper_id']}→{r['key']}" for r in added),
        ))

        # 把 .bib 接入 main.tex（幂等；失败不影响已追加的条目）
        wired = self._wire_bib(ws_id, txn, context or {}, events, bib_path)
        if wired:
            notes.append(wired)
        return ToolResult("\n".join(notes))

    @staticmethod
    def _wire_bib(ws_id: str, txn: str, context: dict, events: list[dict],
                  bib_path: str) -> str:
        ensure_main_tex(ws_id)
        _raw, main_body, eol = _read_body(ws_id, MAIN_TEX)
        scheme = bibtex.detect_bib_scheme(main_body)
        try:
            actions = bibtex.resource_edits(main_body, scheme, bib_path)
        except ValueError as exc:
            return tr("writing.bib_anchor_missing",
                      bib=bib_path, anchor=str(exc))
        if not actions:
            return ""
        base_hash = we.content_hash(main_body)
        result = we.apply_actions(main_body, actions)
        if isinstance(result, list):
            return _failure_text(result)
        new_hash = _write_body(ws_id, MAIN_TEX, result.text, eol)
        hunks = []
        for edit in result.applied:
            seq = db.next_writing_seq(txn)
            rev_id = db.insert_writing_revision(
                run_id=context.get("run_id") or "",
                transaction_id=txn, scope=f"ws:{ws_id}", rel_path=MAIN_TEX, seq=seq,
                action_kind="input", old_text=edit.old_text, new_text=edit.new_text,
                base_hash=base_hash, new_hash=new_hash,
            )
            rev = db.get_writing_revision(rev_id)
            hunks.append(_hunk(rev, edit, "input"))
        _emit_diff(events, path=MAIN_TEX, txn=txn, hunks=hunks, new_hash=new_hash)
        detail = "addbibresource/printbibliography" if scheme == "biblatex" \
            else "\\bibliography"
        return tr("writing.bib_wired", detail=detail)


# ---------- 工具：compile_document ----------
class CompileDocumentTool(BaseTool):
    name = "compile_document"
    description = (
        "在工作区目录中用 xelatex 真实编译指定 .tex 入口（多趟 + 自动 bibtex/biber）。"
        "不指定 path 则编译 main.tex。"
        "成功返回成功提示并刷新 PDF；失败返回结构化错误清单（file:line + 原因）与"
        "日志尾部，你应按行号用 edit_file 修正后重新编译，直到成功。"
        "新增章节、宏包、参考文献或公式环境后建议编译一次自检。"
        "单次编译可能耗时较久，请耐心等待结果，不要并发重复调用。"
        "仅在打开了写作工作区时可用。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "要编译的 .tex 入口相对路径，缺省 main.tex",
            },
        },
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        ws_id = _ws_id(context)
        if ws_id is None:
            return ToolResult(tr("writing.no_workspace"))
        events = _events(context)
        entry = (arguments.get("path") or "").strip() or MAIN_TEX
        try:
            report = compile_workspace(ws_id, entry=entry)
        except WorkspaceError as exc:
            return ToolResult(str(exc))

        errors = report.get("errors") or parse_log_errors(
            report.get("log") or "", default_file=entry)
        events.append({
            "kind": "compile", "ok": bool(report.get("ok")),
            "errors": errors, "message": report.get("message") or "",
            "entry": report.get("entry") or entry,
            "pdf": report.get("pdf"),
        })
        if report.get("ok"):
            return ToolResult(tr("writing.compile_ok", passes="1-3"))
        if not report.get("log") and not errors:
            return ToolResult(tr("writing.compile_engine_missing"))
        lines = [tr("writing.compile_failed",
                    count=len(errors),
                    errors="\n".join(
                        f"- {e['file']}:{e['line'] or '?'} {e['text']}"
                        for e in errors[:10]) or "(未能解析出定位行)")]
        log_tail = (report.get("log") or "")[-LOG_TAIL_CHARS:]
        if log_tail:
            lines.append(tr("writing.compile_log_hint", log=log_tail))
        return ToolResult("\n".join(lines))


def register_writing_tools(registry: Any) -> None:
    """把六个写作工具注册进工具表（default_registry 初始化后调用一次）。"""
    registry.register(ListWritingFilesTool())
    registry.register(ReadWritingFileTool())
    registry.register(EditWritingFileTool())
    registry.register(CreateWritingFileTool())
    registry.register(AddBibEntriesTool())
    registry.register(CompileDocumentTool())
