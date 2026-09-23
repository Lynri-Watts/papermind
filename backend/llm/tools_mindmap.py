"""思维导图 AI 工具（function calling）。

实现 spec FR-6.1 的五个工具，全部注册进默认工具表：

- ``list_mindmaps``：列出当前作用域（工作区/全局）的导图；
- ``create_mindmap``：空白创建或从 mermaid 文本导入；
- ``read_mindmap``：返回带稳定节点 ID 的结构清单 + mermaid 互换文本；
- ``edit_mindmap``：批量动作（add/update/move/delete/set_collapsed/attach_paper），
  原子应用、服务端提交，同一会话共享一个事务 ID；
- ``attach_paper_to_mindmap``：把论文挂为 paper 节点（指定节点则改挂，缺省挂根）。

请求级语义（作用域、事务、SSE 事件收集）不放在单例工具里，而是经
``execute(arguments, context)`` 的 context 传入（由 /rag/stream 每请求构造）：

- ``scope``：''=全局，'ws:<id>'=当前工作区（工具不可跨工作区读写）；
- ``transaction_id``：本次问答共享，落进 mindmap_revisions，供整事务撤销；
- ``mindmap_events``：list，edit/attach 成功后追加 mindmap_diff 载荷，
  路由层在工具返回后逐条以 SSE 推给前端。

可预期失败（导图不存在/不变量违反/版本冲突）返回失败型 ToolResult 文本，
让 LLM 读到可操作原因后自我修正（FR-6.6），不抛异常打断 ReAct 循环。
"""
from __future__ import annotations

import uuid
from typing import Any, Optional

import storage.db as db
from i18n import tr
from llm.tools import BaseTool, ToolResult
from services import mindmap_doc as md
from services.mindmap_doc import MindmapError
from services.mindmap_mmd import doc_to_mermaid, parse_mermaid

#: 单次 edit_mindmap 动作数上限（防止 LLM 一次提交超大批次）
MAX_ACTIONS_PER_CALL = 200


# ---------- 共享辅助 ----------
def _scope(context: Optional[dict], arguments: dict) -> str:
    """解析目标作用域：默认当前问答工作区；显式 scope="global" 才进全局库。"""
    current = (context or {}).get("scope") or ""
    choice = arguments.get("scope", "workspace")
    if choice == "global":
        return ""
    return current


def _load(map_id: str, scope: str) -> Optional[dict]:
    row = db.get_mindmap(map_id)
    if row is None or row.get("scope") != scope:
        return None
    return row


def _structure_error(exc: MindmapError) -> str:
    reason = tr(exc.key, **(exc.params or {}))
    if exc.action_index is not None:
        reason = tr("mindmap.action_error", index=exc.action_index + 1, reason=reason)
    return reason


def _outline(doc: dict) -> str:
    """生成带稳定 ID 的缩进树清单（LLM 后续按 [id] 定位节点）。"""
    nodes = doc["nodes"]
    root = md.find_root(nodes)
    if root is None:
        return ""

    lines: list[str] = []

    def render(node: dict, depth: int) -> None:
        text = (node.get("text") or "").replace("\n", " ").strip() or "(空)"
        suffix = ""
        if node.get("kind") == "paper":
            suffix = f" 📄{node.get('paperId')}"
        if node.get("collapsed"):
            suffix += " （折叠）"
        lines.append(f"{'  ' * depth}- [{node['id']}] {text}{suffix}")
        for child in md.ordered_children(nodes, node["id"]):
            render(child, depth + 1)

    render(root, 0)
    return "\n".join(lines)


def _read_report(row: dict) -> str:
    """read_mindmap 的完整 observation：元信息 + ID 清单 + mermaid 文本。"""
    doc = row["doc"]
    header = tr(
        "mindmap.ai.read_header",
        title=row["title"], map_id=row["id"],
        version=row["version"], count=len(doc["nodes"]),
    )
    return (
        f"{header}\n"
        f"{tr('mindmap.ai.structure_hint')}\n"
        f"{_outline(doc)}\n\n"
        f"== mermaid ==\n{doc_to_mermaid(doc)}"
    )


def _ensure_temp_ids(actions: list[dict]) -> None:
    """add_node 缺省 id 时补批内临时 ID；idMap 依赖它把正式 ID 回传给前端与 LLM。"""
    used: set[str] = set()
    for action in actions:
        if action.get("op") == "add_node" and not action.get("id"):
            temp = "tmp_" + uuid.uuid4().hex[:8]
            while temp in used:
                temp = "tmp_" + uuid.uuid4().hex[:8]
            action["id"] = temp
            used.add(temp)


def commit_ai_actions(
    map_id: str, scope: str, actions: list[dict], context: Optional[dict],
    *, expect_version: Optional[int] = None,
) -> ToolResult:
    """AI 写导图的统一提交管线（edit_mindmap / attach_paper_to_mindmap 共用）。

    成功返回成功型 ToolResult（含新节点正式 ID 映射），并向 context 追加一个
    mindmap_diff 事件载荷；失败返回失败型 ToolResult（可直接回 LLM）。
    """
    if not isinstance(actions, list) or not actions:
        return ToolResult(tr("mindmap.actions_empty"))
    if len(actions) > MAX_ACTIONS_PER_CALL:
        return ToolResult(tr("mindmap.ai.actions_limit", limit=MAX_ACTIONS_PER_CALL))

    row = _load(map_id, scope)
    if row is None:
        return ToolResult(tr("mindmap.ai.map_not_in_scope", map_id=map_id))
    if expect_version is not None and row["version"] != expect_version:
        return ToolResult(tr(
            "mindmap.ai.version_mismatch",
            expected=expect_version, current=row["version"],
        ))

    _ensure_temp_ids(actions)
    try:
        new_doc, result = md.apply_actions(row["doc"], actions)
    except MindmapError as exc:
        return ToolResult(tr("mindmap.ai.edit_failed", reason=_structure_error(exc)))

    transaction_id = (context or {}).get("transaction_id")
    new_version = db.commit_mindmap_doc(
        map_id, new_doc, actions, actor="ai", transaction_id=transaction_id,
    )
    if new_version is None:
        # 读与提交之间版本被推进（当前实现中请求内串行，正常不会发生）
        return ToolResult(tr("mindmap.ai.conflict"))

    saved = _load(map_id, scope)
    assert saved is not None
    # 追加 SSE 载荷：路由层拿到后推送 mindmap_diff（actions 保留临时 ID，
    # 前端凭 idMap 本地对账，与 GUI 走同一套外部差异应用逻辑）
    events = (context or {}).get("mindmap_events")
    if isinstance(events, list):
        events.append({
            "mapId": map_id,
            "version": new_version,
            "actions": actions,
            "idMap": result["idMap"],
            "transactionId": transaction_id,
        })

    id_map = result["idMap"]
    id_lines = ""
    if id_map:
        id_lines = "\n" + tr("mindmap.ai.id_map_hint") + " " + ", ".join(
            f"{temp}→{real}" for temp, real in id_map.items()
        )
    ops_summary = ", ".join(str(a.get("op")) for a in actions)
    content = tr(
        "mindmap.ai.edit_done",
        count=len(actions), ops=ops_summary, version=new_version,
    ) + id_lines + f"\n{_read_report(saved)}"
    return ToolResult(content, {
        "mapId": map_id,
        "version": new_version,
        "idMap": id_map,
        "transactionId": transaction_id,
        "mindmap": {
            "id": saved["id"],
            "title": saved["title"],
            "version": saved["version"],
            "nodes": new_doc["nodes"],
        },
    })


# ---------- 工具：list ----------
class ListMindmapsTool(BaseTool):
    """列出当前作用域的思维导图（默认当前工作区，可显式查全局库）。"""

    name = "list_mindmaps"
    description = (
        "列出思维导图库，返回每张导图的 id、标题、节点数与更新时间。"
        "默认列出当前工作区的导图；需要全局导图库时传 scope=\"global\"。"
        "操作导图前若不知道 map_id，应先调用本工具。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "scope": {
                "type": "string",
                "enum": ["workspace", "global"],
                "description": "workspace=当前工作区（默认）；global=全局导图库",
            },
        },
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        scope = _scope(context, arguments)
        items = db.list_mindmaps(scope=scope, include_doc=True)
        if not items:
            return ToolResult(tr("mindmap.ai.list_empty"))
        lines = [tr("mindmap.ai.list_header", n=len(items))]
        for it in items:
            count = len(it["doc"]["nodes"])
            lines.append(
                f"- [{it['id']}] 《{it['title']}》｜{tr('mindmap.ai.node_count', n=count)}｜"
                f"{tr('mindmap.ai.updated_at')}: {it.get('updated_at') or ''}"
            )
        lines.append(tr("mindmap.ai.list_hint"))
        return ToolResult("\n".join(lines))


# ---------- 工具：create ----------
class CreateMindmapTool(BaseTool):
    """新建导图（空白或从 mermaid mindmap 文本导入）。"""

    name = "create_mindmap"
    description = (
        "新建一张思维导图并返回其 map_id。可只给根主题（root_text），"
        "也可用 from_mermaid 传入一段 mermaid mindmap 文本直接成图。"
        "导图创建在当前工作区（scope=\"global\" 时进全局库）。"
        "创建后若要继续增删节点，调用 read_mindmap 取得节点 ID 再用 edit_mindmap。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "导图标题（必填）"},
            "root_text": {"type": "string", "description": "根节点文本（空白创建时用；缺省取标题）"},
            "from_mermaid": {
                "type": "string",
                "description": "可选：mermaid mindmap 代码（以 mindmap 头开始的缩进文本）",
            },
            "scope": {"type": "string", "enum": ["workspace", "global"]},
        },
        "required": ["title"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        scope = _scope(context, arguments)
        title = (arguments.get("title") or "").strip()
        mermaid_text = arguments.get("from_mermaid")
        if mermaid_text is not None:
            if not isinstance(mermaid_text, str) or not mermaid_text.strip():
                return ToolResult(tr("mindmap.mermaid_required"))
            try:
                doc = parse_mermaid(mermaid_text)
            except MindmapError as exc:
                return ToolResult(tr("mindmap.ai.create_failed", reason=_structure_error(exc)))
            if not title:
                root = md.find_root(doc["nodes"])
                title = ((root.get("text") if root else "") or "").strip()
            if not title:
                return ToolResult(tr("mindmap.title_required"))
        else:
            if not title:
                return ToolResult(tr("mindmap.title_required"))
            root_text = (arguments.get("root_text") or "").strip() or title
            doc = md.new_doc(root_text)

        map_id = "mm_" + uuid.uuid4().hex[:12]
        row = db.create_mindmap(map_id, scope, title, doc)
        return ToolResult(
            tr("mindmap.ai.created", title=title, map_id=map_id) + f"\n{_read_report(row)}",
            {"mapId": map_id, "version": row["version"]},
        )


# ---------- 工具：read ----------
class ReadMindmapTool(BaseTool):
    """读取导图：ID 结构清单 + mermaid 文本（编辑前必须先读）。"""

    name = "read_mindmap"
    description = (
        "读取一张思维导图的完整结构，返回带节点 ID 的缩进树清单和等价 mermaid 文本。"
        "edit_mindmap / attach_paper_to_mindmap 需要用到清单中的节点 ID，"
        "因此编辑前必须先调用本工具；操作后工具也会回传最新结构，无需重复读取。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "map_id": {"type": "string", "description": "导图 id（取自 list_mindmaps / create_mindmap）"},
            "scope": {"type": "string", "enum": ["workspace", "global"]},
        },
        "required": ["map_id"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        map_id = (arguments.get("map_id") or "").strip()
        row = _load(map_id, _scope(context, arguments)) if map_id else None
        if row is None:
            return ToolResult(tr("mindmap.ai.map_not_in_scope", map_id=map_id or "(空)"))
        return ToolResult(_read_report(row))


# ---------- 工具：edit ----------
class EditMindmapTool(BaseTool):
    """批量动作编辑导图（六类 op，原子提交，同一问答共享一个撤销事务）。"""

    name = "edit_mindmap"
    description = (
        "对一张思维导图原子地应用一批动作（全部成功才生效，任一非法整批不写入）。"
        "动作类型：\n"
        "1) add_node 新增节点：{op,id(临时ID,建议tmp_开头且本批唯一),parentId"
        "(已有节点ID；根用 null，仅在导图无根时),text,kind?(topic|paper),"
        "paperId?(kind=paper 时必填，形如 来源:编号),order?(同级位置,缺省末尾)}；\n"
        "2) update_node 改节点：{op,id,text?}（只允许改文本；改类型用 attach_paper）；\n"
        "3) move_node 移动：{op,id,newParentId,newOrder?}（不能移到根/自己/后代下）；\n"
        "4) delete_node 删除：{op,id,strategy?(promote=子节点提升(默认)|delete_branch=连后代)}"
        "（根不可删）；\n"
        "5) set_collapsed 折叠：{op,id,collapsed:boolean}；\n"
        "6) attach_paper 把已有节点变成论文节点：{op,id,paperId}。\n"
        "同一批内新增节点的后续动作可直接引用其临时 ID。新节点的正式 ID 会在结果的"
        "映射中返回。编辑前先 read_mindmap；节点文本要简洁、沿用导图既有语言；"
        "不要删除用户节点，除非用户明确要求。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "map_id": {"type": "string"},
            "actions": {
                "type": "array",
                "description": f"动作数组（1..{MAX_ACTIONS_PER_CALL} 个），按顺序应用",
                "items": {"type": "object"},
            },
            "expect_version": {
                "type": "integer",
                "description": "可选：你读取时的 version；服务端版本不同会直接失败并回传最新版本",
            },
            "scope": {"type": "string", "enum": ["workspace", "global"]},
        },
        "required": ["map_id", "actions"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        map_id = (arguments.get("map_id") or "").strip()
        if not map_id:
            return ToolResult(tr("mindmap.ai.map_not_in_scope", map_id="(空)"))
        expect_version = arguments.get("expect_version")
        if not (expect_version is None
                or isinstance(expect_version, int) and not isinstance(expect_version, bool)):
            return ToolResult(tr("mindmap.base_version_invalid"))
        actions = arguments.get("actions")
        if not isinstance(actions, list):
            return ToolResult(tr("mindmap.actions_not_list"))
        return commit_ai_actions(
            map_id, _scope(context, arguments), actions, context,
            expect_version=expect_version,
        )


# ---------- 工具：attach paper ----------
class AttachPaperToMindmapTool(BaseTool):
    """把论文挂为导图的 paper 节点（指定节点则改挂，缺省在根下新增）。"""

    name = "attach_paper_to_mindmap"
    description = (
        "把一篇论文关联到思维导图：不传 node_id 时在根节点下新增一个论文节点"
        "（文本自动取论文标题）；传 node_id 时把该已有节点变成论文节点。"
        "paper_id 必须是系统中的论文标识（来自 paper_search 返回的 id，形如 来源:编号）。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "map_id": {"type": "string"},
            "paper_id": {"type": "string", "description": "论文 id（paper_search 结果中的 id）"},
            "node_id": {"type": "string", "description": "可选：已有节点 ID；缺省挂根节点下（新增）"},
            "scope": {"type": "string", "enum": ["workspace", "global"]},
        },
        "required": ["map_id", "paper_id"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        map_id = (arguments.get("map_id") or "").strip()
        paper_id = (arguments.get("paper_id") or "").strip()
        node_id = (arguments.get("node_id") or "").strip() or None
        scope = _scope(context, arguments)
        if not map_id or not paper_id:
            return ToolResult(tr("mindmap.ai.attach_args_missing"))
        try:
            md.validate_paper_id(paper_id)
        except MindmapError:
            return ToolResult(tr("mindmap.invalid_paper_id", paper_id=paper_id))

        row = _load(map_id, scope)
        if row is None:
            return ToolResult(tr("mindmap.ai.map_not_in_scope", map_id=map_id))

        if node_id is not None:
            if not any(n["id"] == node_id for n in row["doc"]["nodes"]):
                return ToolResult(tr("mindmap.node_not_found", id=node_id))
            actions = [{"op": "attach_paper", "id": node_id, "paperId": paper_id}]
        else:
            root = md.find_root(row["doc"]["nodes"])
            if root is None:
                return ToolResult(tr("mindmap.root_missing"))
            meta = db.get_paper(paper_id) or {}
            title = (meta.get("title") or paper_id).strip() or paper_id
            actions = [{
                "op": "add_node",
                "parentId": root["id"],
                "text": title,
                "kind": "paper",
                "paperId": paper_id,
            }]
        return commit_ai_actions(map_id, scope, actions, context)


def register_mindmap_tools(registry: Any) -> None:
    """把五个导图工具注册进工具表（default_registry 初始化时调用一次）。"""
    registry.register(ListMindmapsTool())
    registry.register(CreateMindmapTool())
    registry.register(ReadMindmapTool())
    registry.register(EditMindmapTool())
    registry.register(AttachPaperToMindmapTool())
