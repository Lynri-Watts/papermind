"""思维导图 API 路由。

作用域沿用 context_items 约定：``workspace_id`` 为空 = 全局库（scope=''），
非空归一化为 ``'ws:<id>'``。导图仅在所属作用域内可见——访问他作用域导图
返回 404（不泄露存在性）。

所有结构化写入只经 :func:`services.mindmap_doc.apply_actions`；
mermaid 文本导入只经 :func:`services.mindmap_mmd.parse_mermaid`；
AI 事务撤销见 :func:`services.mindmap_undo.revert_transaction`。
"""
from __future__ import annotations

import uuid

from flask import Blueprint, jsonify, request

import storage.db as db
from i18n import tr
from routes.papers import ApiError, _ws_scope
from services import mindmap_doc as md
from services.mindmap_doc import MindmapError
from services.mindmap_mmd import doc_to_mermaid, parse_mermaid
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


def _serialize(row: dict) -> dict:
    """DB 行 → API 文档（doc 的 nodes 展开到顶层，避免双重嵌套）。"""
    doc = row.get("doc") or {"nodes": []}
    return {
        "id": row["id"],
        "scope": row.get("scope", ""),
        "title": row["title"],
        "version": row["version"],
        "nodes": doc.get("nodes", []),
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
    return jsonify({"mindmaps": items})


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
        try:
            doc = parse_mermaid(mermaid_text)
        except MindmapError as exc:
            _raise_structural(exc)
        if not title:
            # 显式回退规则（非静默）：未给标题时用根文本，仍为空才拒绝
            root = md.find_root(doc["nodes"])
            title = (root.get("text") if root else "").strip()
        if not title:
            raise ApiError(tr("mindmap.title_required"), 400)
    else:
        root_text = (body.get("rootText") or "").strip()
        if not title:
            title = root_text
        if not title:
            raise ApiError(tr("mindmap.title_required"), 400)
        doc = md.new_doc(root_text or title)

    row = db.create_mindmap(_new_map_id(), scope, title, doc)
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


@mindmaps_api.get("/mindmaps/<map_id>/mermaid")
def export_mermaid(map_id: str):
    scope = _ws_scope(request.args.get("workspace_id"))
    row = _load_scoped(map_id, scope)
    try:
        text = doc_to_mermaid(row["doc"])
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
