"""思维导图 API 路由。

作用域沿用 context_items 约定：``workspace_id`` 为空 = 全局库（scope=''），
非空归一化为 ``'ws:<id>'``。导图仅在所属作用域内可见——访问他作用域导图
返回 404（不泄露存在性）。

所有结构化写入只经 :func:`services.mindmap_doc.apply_actions`（仅 mindmap 类型）；
任意 mermaid 源码导入/互转只经 :func:`services.mindmap_mmd.doc_from_mermaid_source`
（mindmap 头解析为树；其他图原文存为只读图）；
AI 事务撤销见 :func:`services.mindmap_undo.revert_transaction`。
"""
from __future__ import annotations

import uuid

from flask import Blueprint, jsonify, request

import storage.db as db
from i18n import tr
from routes.papers import ApiError, _ws_scope
from services import mindmap_doc as md
from services.mindmap_diagram import MINDMAP_TYPE
from services.mindmap_doc import MindmapError
from services.mindmap_mmd import doc_from_mermaid_source, doc_to_mermaid
from services.mindmap_undo import revert_transaction

mindmaps_api = Blueprint("mindmaps", __name__)


@mindmaps_api.errorhandler(ApiError)
def _handle_api_error(err: ApiError):
    return jsonify({"error": err.message}), err.status


@mindmaps_api.errorhandler(Exception)
def _handle_unexpected(err: Exception):
    return jsonify({"error": tr("mindmap.internal_error", err=err)}), 500


# ---------- 辅助 ----------
def _new_map_id() -> str:
    return "mm_" + uuid.uuid4().hex[:12]


def _diagram_type_of(row: dict, doc: dict | None = None) -> str:
    """图类型：优先冗余列，回退 doc.diagramType，再缺省 mindmap。"""
    value = row.get("diagram_type")
    if isinstance(value, str) and value:
        return value
    if doc is not None:
        inline = doc.get("diagramType")
        if isinstance(inline, str) and inline:
            return inline
    return MINDMAP_TYPE


def _serialize(row: dict) -> dict:
    """DB 行 → API 文档（doc 的 nodes/diagramType/source 展开到顶层）。"""
    doc = row.get("doc") or {"nodes": []}
    dtype = _diagram_type_of(row, doc)
    return {
        "id": row["id"],
        "scope": row.get("scope", ""),
        "title": row["title"],
        "version": row["version"],
        "diagramType": dtype,
        "nodes": doc.get("nodes", []) if dtype == MINDMAP_TYPE else [],
        "source": doc.get("source") if dtype != MINDMAP_TYPE else None,
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _serialize_meta(row: dict) -> dict:
    """列表项 → API 元信息（snake_case 冗余列映射为 diagramType）。"""
    return {
        "id": row["id"],
        "scope": row.get("scope", ""),
        "title": row["title"],
        "version": row["version"],
        "diagramType": _diagram_type_of(row),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _load_scoped(map_id: str, scope: str) -> dict:
    row = db.get_mindmap(map_id)
    if row is None or row.get("scope") != scope:
        raise ApiError(tr("mindmap.not_found"), 404)
    return row


def _raise_structural(exc: MindmapError) -> None:
    """内核错误翻译为本地文案；动作批错误附带序号。"""
    reason = tr(exc.key, **(exc.params or {}))
    if exc.action_index is not None:
        reason = tr("mindmap.action_error", index=exc.action_index + 1, reason=reason)
    raise ApiError(reason, 400) from exc


def _scope_from_body(body: dict) -> str:
    return _ws_scope(body.get("workspace_id"))


# ---------- 列表 / 创建 / 导入 ----------
@mindmaps_api.get("/mindmaps")
def list_mindmaps():
    scope = _ws_scope(request.args.get("workspace_id"))
    items = db.list_mindmaps(scope=scope, include_doc=False)
    return jsonify({"mindmaps": [_serialize_meta(r) for r in items]})


@mindmaps_api.post("/mindmaps")
def create_mindmap():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ApiError(tr("mindmap.body_invalid"), 400)
    scope = _scope_from_body(body)
    title = (body.get("title") or "").strip()
    mermaid_text = body.get("mermaid") or body.get("fromMermaid")

    has_mermaid = ("mermaid" in body and body.get("mermaid") is not None) or \
        ("fromMermaid" in body and body.get("fromMermaid") is not None)
    if has_mermaid:
        if not isinstance(mermaid_text, str):
            raise ApiError(tr("mindmap.mermaid_required"), 400)
        # mindmap 头 → 节点树；其他 mermaid 图（flowchart/sequence/…）→ 原文只读图
        try:
            doc, diagram_type = doc_from_mermaid_source(mermaid_text)
        except MindmapError as exc:
            _raise_structural(exc)
        if not title:
            if diagram_type == MINDMAP_TYPE:
                # 显式回退规则（非静默）：未给标题时用根文本，仍为空才拒绝
                root = md.find_root(doc["nodes"])
                title = (root.get("text") if root else "").strip()
            # 非 mindmap 图无法从结构推导标题：必须显式提供
        if not title:
            raise ApiError(tr("mindmap.title_required"), 400)
    else:
        root_text = (body.get("rootText") or "").strip()
        if not title:
            title = root_text
        if not title:
            raise ApiError(tr("mindmap.title_required"), 400)
        doc = md.new_doc(root_text or title)
        diagram_type = MINDMAP_TYPE

    row = db.create_mindmap(_new_map_id(), scope, title, doc, diagram_type)
    return jsonify({"mindmap": _serialize(row)}), 201


@mindmaps_api.post("/mindmaps/import")
def import_mermaid():
    """与 POST /mindmaps?fromMermaid 等价的显式导入入口（语义清晰，便于前端调用）。"""
    return create_mindmap()


# ---------- 单导图读写 ----------
@mindmaps_api.get("/mindmaps/<map_id>")
def get_mindmap(map_id: str):
    scope = _ws_scope(request.args.get("workspace_id"))
    row = _load_scoped(map_id, scope)
    return jsonify({"mindmap": _serialize(row)})


@mindmaps_api.put("/mindmaps/<map_id>")
def rename_mindmap(map_id: str):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ApiError(tr("mindmap.body_invalid"), 400)
    scope = _scope_from_body(body)
    _load_scoped(map_id, scope)
    title = (body.get("title") or "").strip()
    if not title:
        raise ApiError(tr("mindmap.title_required"), 400)
    db.rename_mindmap(map_id, title)
    row = _load_scoped(map_id, scope)
    return jsonify({"mindmap": _serialize(row)})


@mindmaps_api.delete("/mindmaps/<map_id>")
def delete_mindmap(map_id: str):
    body = request.get_json(silent=True) or {}
    scope = _ws_scope(body.get("workspace_id") or request.args.get("workspace_id"))
    _load_scoped(map_id, scope)
    db.delete_mindmap(map_id)
    return jsonify({"ok": True})


@mindmaps_api.post("/mindmaps/<map_id>/actions")
def mindmap_actions(map_id: str):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ApiError(tr("mindmap.body_invalid"), 400)
    scope = _scope_from_body(body)
    row = _load_scoped(map_id, scope)

    # 非 mindmap 图（flowchart 等原文只读图）不接受结构化动作：改图走 PUT /source
    dtype = _diagram_type_of(row, row.get("doc"))
    if dtype != MINDMAP_TYPE:
        raise ApiError(tr("mindmap.actions_unsupported", diagram_type=dtype), 400)

    base = body.get("baseVersion")
    if not isinstance(base, int) or isinstance(base, bool):
        raise ApiError(tr("mindmap.base_version_invalid"), 400)
    actions = body.get("actions")
    if not isinstance(actions, list):
        raise ApiError(tr("mindmap.actions_not_list"), 400)
    if not actions:
        raise ApiError(tr("mindmap.actions_empty"), 400)

    if row["version"] != base:
        return jsonify({
            "error": tr("mindmap.version_conflict"),
            "currentVersion": row["version"],
            "mindmap": _serialize(row),
        }), 409

    try:
        new_doc, result = md.apply_actions(row["doc"], actions)
    except MindmapError as exc:
        _raise_structural(exc)

    new_version = db.commit_mindmap_doc(map_id, new_doc, actions, actor="user")
    if new_version is None:
        fresh = _load_scoped(map_id, scope)
        return jsonify({
            "error": tr("mindmap.version_conflict"),
            "currentVersion": fresh["version"],
            "mindmap": _serialize(fresh),
        }), 409

    saved = _load_scoped(map_id, scope)
    return jsonify({"mindmap": _serialize(saved), "idMap": result["idMap"]})


@mindmaps_api.put("/mindmaps/<map_id>/source")
def replace_mermaid_source(map_id: str):
    """以整段 mermaid 源码替换导图内容（支持 mindmap↔其他图互转）。

    - mindmap 源码：解析为节点树（等价导入语义，坐标由前端重排，不入库）；
    - 其他 mermaid 图：nodes 清空、原文存储，前端切只读渲染；
    - 乐观锁同 /actions（baseVersion 不符返回 409 + 当前文档）。
    """
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ApiError(tr("mindmap.body_invalid"), 400)
    scope = _scope_from_body(body)
    row = _load_scoped(map_id, scope)

    source = body.get("source")
    if not isinstance(source, str) or not source.strip():
        raise ApiError(tr("mindmap.source_required"), 400)
    base = body.get("baseVersion")
    if not isinstance(base, int) or isinstance(base, bool):
        raise ApiError(tr("mindmap.base_version_invalid"), 400)
    if row["version"] != base:
        return jsonify({
            "error": tr("mindmap.version_conflict"),
            "currentVersion": row["version"],
            "mindmap": _serialize(row),
        }), 409

    try:
        new_doc, diagram_type = doc_from_mermaid_source(source)
    except MindmapError as exc:
        _raise_structural(exc)

    record = [{"op": "replace_source", "diagramType": diagram_type}]
    new_version = db.commit_mindmap_doc(map_id, new_doc, record, actor="user")
    if new_version is None:
        fresh = _load_scoped(map_id, scope)
        return jsonify({
            "error": tr("mindmap.version_conflict"),
            "currentVersion": fresh["version"],
            "mindmap": _serialize(fresh),
        }), 409

    saved = _load_scoped(map_id, scope)
    return jsonify({"mindmap": _serialize(saved)})


@mindmaps_api.get("/mindmaps/<map_id>/mermaid")
def export_mermaid(map_id: str):
    scope = _ws_scope(request.args.get("workspace_id"))
    row = _load_scoped(map_id, scope)
    doc = row.get("doc") or {}
    dtype = _diagram_type_of(row, doc)
    if dtype != MINDMAP_TYPE:
        # 非 mindmap 图：原文就是其 mermaid 表达
        return jsonify({"mermaid": doc.get("source") or ""})
    try:
        text = doc_to_mermaid(doc)
    except MindmapError as exc:
        _raise_structural(exc)
    return jsonify({"mermaid": text})


# ---------- AI 事务撤销 ----------
@mindmaps_api.post("/mindmaps/<map_id>/undo-ai")
def undo_ai_transaction(map_id: str):
    body = request.get_json(silent=True) or {}
    scope = _ws_scope(body.get("workspace_id") or request.args.get("workspace_id"))
    row = _load_scoped(map_id, scope)

    transaction_id = (body.get("transactionId") or "").strip() or None
    if transaction_id is None:
        txn = db.get_latest_ai_transaction(map_id)
        if txn is None:
            raise ApiError(tr("mindmap.undo_no_ai"), 400)
        transaction_id = txn["transaction_id"]
    elif db.is_transaction_undone(map_id, transaction_id):
        raise ApiError(tr("mindmap.undo_already"), 400)

    # 取本事务全部修订（升序）。修订表只保留最近 20 版，若事务起点已被
    # 裁剪（min-1 快照缺失），无法可靠逆向。
    revisions = [r for r in db.list_mindmap_revisions(map_id, limit=100)
                 if r.get("transaction_id") == transaction_id]
    if not revisions:
        raise ApiError(tr("mindmap.undo_no_ai"), 400)
    versions = sorted(r["version"] for r in revisions)
    min_v, max_v = versions[0], versions[-1]
    if db.is_transaction_undone(map_id, transaction_id):
        raise ApiError(tr("mindmap.undo_already"), 400)

    pre_rev = db.get_mindmap_revision(map_id, min_v - 1) if min_v > 1 else None
    end_rev = db.get_mindmap_revision(map_id, max_v)
    if pre_rev is None or end_rev is None:
        raise ApiError(tr("mindmap.undo_too_old"), 400)

    try:
        new_doc, stats = revert_transaction(row["doc"], pre_rev["doc"], end_rev["doc"])
    except MindmapError as exc:
        _raise_structural(exc)

    undo_action = {"op": "undo_ai", "transactionId": transaction_id, "stats": stats}
    new_version = db.commit_mindmap_doc(
        map_id, new_doc, [undo_action], actor="system", undo_of=transaction_id)
    if new_version is None:
        raise ApiError(tr("mindmap.undo_conflict"), 409)

    saved = _load_scoped(map_id, scope)
    return jsonify({"mindmap": _serialize(saved), "stats": stats,
                    "transactionId": transaction_id})
