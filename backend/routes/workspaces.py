"""工作区 API 路由。

两类文件物理分离、各走各的接口：

- **写作文件**（本蓝图 ``/workspaces/<id>/files/...``）：tex/bib/txt/md 文本
  与图片素材（png/jpeg/gif/svg），存于工作区受控目录（storage.workspace）；
  不接受 PDF——阅读文献不属于写作目录。
- **本地文献**（``/workspaces/<id>/library/files/...``）：仅 PDF，存于文献库
  （storage.library，data/libraries/<id>/），统一 id 为
  ``local:<ws_id>:<rel_path>``，接入现有 Paper 机制
  （/paper/<id>、PDF、全文、上下文、RAG 工具全复用）。
"""
from __future__ import annotations

import math
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

import storage.db as db
import storage.workspace as ws
from storage import library as lib
from i18n import tr
from routes.papers import ApiError
from services import latex_build
from services import writing_edit as we

workspaces_api = Blueprint("workspaces", __name__)


@workspaces_api.errorhandler(ApiError)
def _handle_api_error(err: ApiError):
    return jsonify({"error": err.message}), err.status


@workspaces_api.errorhandler(Exception)
def _handle_unexpected(err: Exception):
    return jsonify({"error": tr("workspace.internal_error", err=err)}), 500


# 写作入口的约定文件名（新建工作区时自动生成骨架）
LATEX_FILE = latex_build.MAIN_TEX

# 写作目录允许上传：LaTeX 常用图片（xelatex 原生支持 png/jpeg）+ 文本源码。
# PDF 不属于写作目录（文献只能经文献库接口上传）。
_UPLOAD_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg"}
_UPLOAD_TEXT_EXTS = {".tex", ".bib", ".txt", ".md"}
_ALLOWED_UPLOAD_EXTS = _UPLOAD_IMAGE_EXTS | _UPLOAD_TEXT_EXTS
# 文献库只接受 PDF
_LIBRARY_EXTS = {".pdf"}

# 允许经文本接口在线编辑/新建的扩展名（图片等二进制禁止走文本写入）
_EDITABLE_TEXT_EXTS = _UPLOAD_TEXT_EXTS


def _classify(ext: str) -> str:
    if ext in _LIBRARY_EXTS:
        return "pdf"
    if ext in _UPLOAD_IMAGE_EXTS:
        return "image"
    if ext in (".tex", ".bib"):
        return "latex"
    if ext in (".txt", ".md"):
        return "text"
    return "other"


def _paper_id(ws_id: str, rel_path: str) -> str:
    """把工作区内的 PDF 文件映射为本地文献 id。"""
    return f"local:{ws_id}:{rel_path}"


@workspaces_api.get("/workspaces")
def list_workspaces():
    items = ws.list_workspaces()
    for item in items:
        item["file_count"] = len(ws.list_files(item["id"]))
    return jsonify({"workspaces": items})


@workspaces_api.post("/workspaces")
def create_workspace():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        raise ApiError(tr("workspace.name_required"))
    description = (body.get("description") or "").strip()
    item = ws.create_workspace(name, description)
    # 写作模块默认入口 main.tex：工作区创建即写入可编译骨架
    latex_build.ensure_main_tex(item["id"])
    item["file_count"] = len(ws.list_files(item["id"]))
    return jsonify({"workspace": item}), 201


@workspaces_api.get("/workspaces/<ws_id>")
def get_workspace(ws_id: str):
    try:
        item = ws.get_workspace(ws_id)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    return jsonify({"workspace": item})


@workspaces_api.put("/workspaces/<ws_id>")
def update_workspace(ws_id: str):
    body = request.get_json(silent=True) or {}
    try:
        item = ws.update_workspace(
            ws_id,
            name=(body.get("name") or "").strip() or None,
            description=(body.get("description") or "").strip() or None,
        )
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    return jsonify({"workspace": item})


@workspaces_api.delete("/workspaces/<ws_id>")
def delete_workspace(ws_id: str):
    try:
        ws.delete_workspace(ws_id)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    return jsonify({"ok": True})


# ---------- 文件 ----------
@workspaces_api.get("/workspaces/<ws_id>/files")
def list_files(ws_id: str):
    try:
        files = ws.list_files(ws_id)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    # 标注文件类别，供前端分类展示（写作目录内不存在文献，paper_id 恒为 null）
    for f in files:
        ext = Path(f["path"]).suffix.lower()
        f["kind"] = _classify(ext)
        f["paper_id"] = None
    return jsonify({"files": files})


@workspaces_api.post("/workspaces/<ws_id>/files")
def upload_file(ws_id: str):
    """上传写作文件（multipart/form-data, 字段名 file）：文本/图片素材，不含 PDF。"""
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        raise ApiError(tr("workspace.upload_file_missing"))
    # 拒绝带路径分隔符的文件名（浏览器 File API 可能带路径，不允许任意路径写入）
    if "/" in upload.filename or "\\" in upload.filename:
        raise ApiError(tr("workspace.filename_no_path"))
    filename = upload.filename
    ext = Path(filename).suffix.lower()
    if ext not in _ALLOWED_UPLOAD_EXTS:
        raise ApiError(tr("workspace.unsupported_file_type", ext=ext,
                          exts="/".join(sorted(_ALLOWED_UPLOAD_EXTS))))
    rel_path = ws.unique_path(ws_id, filename)
    try:
        info = ws.write_file(ws_id, rel_path, upload.read())
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    info["kind"] = _classify(ext)
    info["paper_id"] = None
    return jsonify({"file": info}), 201


@workspaces_api.get("/workspaces/<ws_id>/files/<path:rel_path>")
def read_file(ws_id: str, rel_path: str):
    """读取文件。``?text=1`` 返回文本（{content}），否则返回原始二进制。"""
    try:
        if request.args.get("text") == "1":
            content = ws.read_text(ws_id, rel_path)
            return jsonify({"path": rel_path, "content": content})
        path = ws.resolve(ws_id, rel_path)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    return send_file(path, as_attachment=False, conditional=True)


@workspaces_api.put("/workspaces/<ws_id>/files/<path:rel_path>")
def write_file(ws_id: str, rel_path: str):
    """写入文本文件（body: {content}）；文件不存在即新建。

    仅允许可在线编辑的文本扩展名（tex/bib/txt/md），二进制文件必须走上传接口。
    """
    body = request.get_json(silent=True) or {}
    if "content" not in body:
        raise ApiError(tr("workspace.content_required"))
    ext = Path(rel_path).suffix.lower()
    if ext not in _EDITABLE_TEXT_EXTS:
        raise ApiError(tr("workspace.text_ext_required",
                          exts="/".join(sorted(_EDITABLE_TEXT_EXTS))))
    try:
        info = ws.write_text(ws_id, rel_path, body.get("content") or "")
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    info["kind"] = _classify(ext)
    info["paper_id"] = None
    return jsonify({"file": info})


@workspaces_api.delete("/workspaces/<ws_id>/files/<path:rel_path>")
def delete_file(ws_id: str, rel_path: str):
    # main.tex 是固定编译入口，不允许删除（可清空重写）
    if rel_path.replace("\\", "/") == LATEX_FILE:
        raise ApiError(tr("workspace.main_tex_protected"), 400)
    try:
        ws.delete_file(ws_id, rel_path)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    return jsonify({"ok": True})


# ---------- 本地文献库（阅读侧 PDF） ----------
@workspaces_api.get("/workspaces/<ws_id>/library/files")
def list_library_files(ws_id: str):
    """列出工作区文献库中的 PDF，附本地文献 id。"""
    try:
        ws.get_workspace(ws_id)
        files = lib.list_library_files(ws_id)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    for f in files:
        ext = Path(f["path"]).suffix.lower()
        f["kind"] = _classify(ext)
        f["paper_id"] = _paper_id(ws_id, f["path"])
    return jsonify({"files": files})


@workspaces_api.post("/workspaces/<ws_id>/library/files")
def upload_library_file(ws_id: str):
    """上传本地文献（multipart/form-data, 字段名 file），仅接受 PDF。"""
    try:
        ws.get_workspace(ws_id)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        raise ApiError(tr("workspace.upload_file_missing"))
    if "/" in upload.filename or "\\" in upload.filename:
        raise ApiError(tr("workspace.filename_no_path"))
    filename = upload.filename
    ext = Path(filename).suffix.lower()
    if ext not in _LIBRARY_EXTS:
        raise ApiError(tr("workspace.unsupported_file_type", ext=ext,
                          exts="/".join(sorted(_LIBRARY_EXTS))))
    rel_path = lib.unique_library_path(ws_id, filename)
    data = upload.read()
    if not data.startswith(b"%PDF"):
        raise ApiError(tr("workspace.not_a_pdf"), 400)
    try:
        info = lib.write_library_file(ws_id, rel_path, data)
    except Exception as exc:  # SafeRootError
        raise ApiError(str(exc), 400) from exc
    info["kind"] = "pdf"
    info["paper_id"] = _paper_id(ws_id, rel_path)
    return jsonify({"file": info}), 201


@workspaces_api.delete("/workspaces/<ws_id>/library/files/<path:rel_path>")
def delete_library_file(ws_id: str, rel_path: str):
    """删除一篇本地文献的权威 PDF，并清理其 DB 全文缓存/笔记/上下文等关联数据。"""
    try:
        ws.get_workspace(ws_id)
        lib.delete_library_file(ws_id, rel_path)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    # 权威副本已删：清理 local:<ws>:<path> 的 DB 关联数据，避免孤儿数据
    db.delete_local_paper_data(_paper_id(ws_id, rel_path.replace("\\", "/")))
    return jsonify({"ok": True})


# ---------- 写作文件（LaTeX 编辑器） ----------
@workspaces_api.get("/workspaces/<ws_id>/latex")
def read_latex(ws_id: str):
    """读取当前工作区的写作文件（main.tex）；不存在时返回空字符串。"""
    try:
        content = ws.read_text(ws_id, LATEX_FILE) if ws.exists(ws_id, LATEX_FILE) else ""
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    return jsonify({"content": content})


@workspaces_api.put("/workspaces/<ws_id>/latex")
def write_latex(ws_id: str):
    """保存当前写作文件（main.tex）。"""
    body = request.get_json(silent=True) or {}
    if "content" not in body:
        raise ApiError(tr("workspace.content_required"))
    try:
        info = ws.write_text(ws_id, LATEX_FILE, body.get("content") or "")
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    return jsonify({"file": info})


# ---------- 写作入口初始化 / 编译 ----------
@workspaces_api.post("/workspaces/<ws_id>/writing/init")
def writing_init(ws_id: str):
    """确保写作入口 main.tex 存在（供旧工作区首次进入写作页时幂等补建）。"""
    try:
        ws.get_workspace(ws_id)
        created = latex_build.ensure_main_tex(ws_id)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    return jsonify({"created": created, "path": LATEX_FILE})


@workspaces_api.post("/workspaces/<ws_id>/compile")
def compile_workspace(ws_id: str):
    """编译指定入口 .tex（缺省 main.tex）。

    POST body: ``{entry: "chapters/ch1.tex"}``（可选，相对工作区根的 POSIX 路径）。
    """
    body = request.get_json(silent=True) or {}
    entry = (body.get("entry") or "").strip() or None
    try:
        ws.get_workspace(ws_id)
        result = latex_build.compile_workspace(ws_id, entry or latex_build.MAIN_TEX)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    return jsonify(result), (200 if result["ok"] else 422)


@workspaces_api.post("/workspaces/<ws_id>/synctex")
def synctex_inverse(ws_id: str):
    """双击编译 PDF 的反向定位：{page,x,y,entry?}（PDF 点，左上原点）→ 源码行。"""
    body = request.get_json(silent=True) or {}
    try:
        page = int(body.get("page"))
        x = float(body.get("x"))
        y = float(body.get("y"))
    except (TypeError, ValueError):
        raise ApiError(tr("workspace.synctex.bad_params"), 400)
    if page < 1 or not all(math.isfinite(v) and v >= 0 for v in (x, y)):
        raise ApiError(tr("workspace.synctex.bad_params"), 400)
    entry = (body.get("entry") or "").strip() or latex_build.MAIN_TEX
    try:
        ws.get_workspace(ws_id)
        loc = latex_build.synctex_inverse(ws_id, page, x, y, entry=entry)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    except latex_build.SynctexError as exc:
        # 未编译/无 synctex 数据/未命中/路径越界等业务失败
        raise ApiError(str(exc), 422) from exc
    return jsonify(loc), 200


# ---------- AI 写作修订：对账 / 逐块接受拒绝 / 整事务回滚 ----------
# 修订的物理语义与 services.writing_edit 的纯函数一一对应：
# edit/input = 一次唯一锚点替换（反向 reverse_replace）；
# append     = 文末整块追加（反向 remove_block）；
# create     = 新建整文件（反向删文件，仅在内容未被后续修改时）。
_TEXT_REV_KINDS = {"edit", "input", "append"}


def _writing_scope(ws_id: str) -> str:
    return f"ws:{ws_id}"


def _require_writing_ws(ws_id: str) -> None:
    try:
        ws.get_workspace(ws_id)
    except ws.WorkspaceError as exc:
        raise ApiError(tr("writing.workspace_missing"), 404) from exc


def _rev_json(rev: dict) -> dict:
    """修订行 → 前端 camelCase（行号位置由前端按 old/new 文本自行定位，
    刷新后旧行号可能已因其他编辑漂移，不落库也不回传）。"""
    return {
        "id": rev["id"],
        "runId": rev.get("run_id") or "",
        "transactionId": rev["transaction_id"],
        "seq": rev["seq"],
        "kind": rev["action_kind"],
        "path": rev["rel_path"],
        "oldText": rev["old_text"],
        "newText": rev["new_text"],
        "baseHash": rev.get("base_hash") or "",
        "newHash": rev.get("new_hash") or "",
        "status": rev["status"],
        "createdAt": rev.get("created_at") or "",
    }


def _get_owned_rev(ws_id: str, rev_id: int) -> dict:
    rev = db.get_writing_revision(rev_id)
    if rev is None:
        raise ApiError(tr("writing.rev_not_found", rev_id=rev_id), 404)
    if rev["scope"] != _writing_scope(ws_id):
        raise ApiError(tr("writing.rev_wrong_scope"), 400)
    return rev


def _require_pending(rev: dict) -> None:
    if rev["status"] != "pending":
        raise ApiError(
            tr("writing.rev_not_pending", status=rev["status"]), 409)


def _reverse_text_rev(ws_id: str, rev: dict) -> dict:
    """把 edit/input/append 修订反向还原并写盘，返回 {path,content,hash}。

    锚点非唯一/已被改动（命中数 != 1）即放弃，抛 409（writing.rev_stale），
    绝不猜测替换。
    """
    path = rev["rel_path"]
    kind = rev["action_kind"]
    try:
        raw = ws.read_text(ws_id, path)
    except ws.WorkspaceError as exc:
        raise ApiError(tr("writing.rev_stale"), 409) from exc
    body_lf = we.normalize_eol(raw)
    eol = we.detect_eol(raw)
    if kind in ("edit", "input"):
        count, reverted = we.reverse_replace(
            body_lf, rev["new_text"], rev["old_text"])
    elif kind == "append":
        count, reverted = we.remove_block(body_lf, rev["new_text"])
    else:
        raise ApiError(tr("writing.rev_stale"), 409)
    if count != 1:
        raise ApiError(tr("writing.rev_stale"), 409)
    restored = we.restore_eol(reverted, eol)
    ws.write_text(ws_id, path, restored)
    return {"path": path, "content": restored,
            "hash": we.content_hash(reverted)}


@workspaces_api.get("/workspaces/<ws_id>/writing/revisions")
def writing_list_revisions(ws_id: str):
    """工作区全部待审修订（跨刷新对账），按事务、seq 升序。"""
    _require_writing_ws(ws_id)
    rows = db.list_pending_writing_revisions(_writing_scope(ws_id))
    return jsonify({"revisions": [_rev_json(r) for r in rows]})


@workspaces_api.post("/workspaces/<ws_id>/writing/hunks/<int:rev_id>/accept")
def writing_accept_hunk(ws_id: str, rev_id: int):
    """接受单块：仅消标记（文件内容本就是接受态），不可重复操作。"""
    _require_writing_ws(ws_id)
    rev = _get_owned_rev(ws_id, rev_id)
    _require_pending(rev)
    db.set_writing_revision_status(rev_id, "accepted")
    return jsonify({"ok": True, "revId": rev_id, "status": "accepted"})


@workspaces_api.post("/workspaces/<ws_id>/writing/hunks/<int:rev_id>/reject")
def writing_reject_hunk(ws_id: str, rev_id: int):
    """拒绝单块：把该处物理反向还原（edit/input/append）或删除新建文件。"""
    _require_writing_ws(ws_id)
    rev = _get_owned_rev(ws_id, rev_id)
    _require_pending(rev)

    deleted = None
    file_info = None
    if rev["action_kind"] == "create":
        path = rev["rel_path"]
        if ws.exists(ws_id, path):
            # 仅当文件内容仍是 AI 写入时的版本才删除；用户改过则保留并报 stale
            raw = ws.read_text(ws_id, path)
            if we.content_hash(raw) != rev["new_hash"]:
                raise ApiError(tr("writing.rev_stale"), 409)
            ws.delete_file(ws_id, path)
        deleted = path
    else:
        file_info = _reverse_text_rev(ws_id, rev)

    db.set_writing_revision_status(
        rev_id, "rejected", undo_of=f"rev:{rev_id}")
    return jsonify({
        "ok": True, "revId": rev_id, "status": "rejected",
        "file": file_info, "deleted": deleted,
    })


@workspaces_api.post("/workspaces/<ws_id>/writing/transactions/<txn_id>/accept")
def writing_accept_transaction(ws_id: str, txn_id: str):
    """全部接受一次写作事务：剩余 pending 修订一次性消标记（不动文件）。"""
    _require_writing_ws(ws_id)
    scope = _writing_scope(ws_id)
    rev_ids = [
        r["id"] for r in db.list_writing_transaction(scope, txn_id)
        if r["status"] == "pending"
    ]
    count = db.mark_writing_revisions_status(rev_ids, "accepted") if rev_ids else 0
    return jsonify({"ok": True, "transactionId": txn_id, "count": count})


@workspaces_api.post("/workspaces/<ws_id>/writing/transactions/<txn_id>/rollback")
def writing_rollback_transaction(ws_id: str, txn_id: str):
    """整事务回滚（一问一撤销）：按 seq 逆序逐块物理还原。

    - pending/accepted 的 edit/input/append 反向替换，create 在内容未变时删文件；
    - rejected 已逐块还原，stale/reverted 不重复处理；
    - create 文件被后续修改则保留（kept 列出），其余继续回滚；
    - 文本锚点遇冲突（已被改动/不唯一）立即停止，已完成的还原落库，
      返回 409 + 现场（files/deleted/processedCount），交用户手动检查。
    """
    _require_writing_ws(ws_id)
    scope = _writing_scope(ws_id)
    rows = db.list_writing_transaction(scope, txn_id)
    if not rows:
        raise ApiError(tr("writing.rollback_empty"), 404)

    files: dict[str, dict] = {}
    deleted: list[str] = []
    kept: list[str] = []
    processed = 0
    conflict: dict | None = None

    for rev in rows:
        status = rev["status"]
        # 已物理还原（逐块拒绝或此前回滚）的不再处理
        if status in ("rejected", "reverted"):
            continue
        path = rev["rel_path"]
        kind = rev["action_kind"]
        try:
            if kind == "create":
                if not ws.exists(ws_id, path):
                    # 文件已不在（可能被用户手动删除）：视同还原成功
                    db.set_writing_revision_status(
                        rev["id"], "reverted", undo_of=txn_id)
                    deleted.append(path)
                    processed += 1
                    continue
                raw = ws.read_text(ws_id, path)
                if we.content_hash(raw) != rev["new_hash"]:
                    # 创建后又被修改：保留文件，修订不落 reverted，提示用户
                    kept.append(path)
                    continue
                ws.delete_file(ws_id, path)
                db.set_writing_revision_status(
                    rev["id"], "reverted", undo_of=txn_id)
                deleted.append(path)
                processed += 1
                continue

            # edit / input / append
            if kind not in _TEXT_REV_KINDS:
                conflict = {"seq": rev["seq"], "path": path}
                break
            if kind in ("edit", "input"):
                raw = ws.read_text(ws_id, path)
                body_lf = we.normalize_eol(raw)
                count, reverted = we.reverse_replace(
                    body_lf, rev["new_text"], rev["old_text"])
            else:
                raw = ws.read_text(ws_id, path)
                body_lf = we.normalize_eol(raw)
                count, reverted = we.remove_block(body_lf, rev["new_text"])
            if count != 1:
                conflict = {"seq": rev["seq"], "path": path}
                break
            eol = we.detect_eol(raw)
            restored = we.restore_eol(reverted, eol)
            ws.write_text(ws_id, path, restored)
            files[path] = {"path": path, "content": restored,
                           "hash": we.content_hash(reverted)}
            db.set_writing_revision_status(
                rev["id"], "reverted", undo_of=txn_id)
            processed += 1
        except ws.WorkspaceError:
            conflict = {"seq": rev["seq"], "path": path}
            break

    payload = {
        "ok": conflict is None,
        "transactionId": txn_id,
        "count": processed,
        "files": list(files.values()),
        "deleted": deleted,
        "kept": kept,
    }
    if conflict is not None:
        payload["error"] = tr(
            "writing.rollback_conflict",
            seq=conflict["seq"], path=conflict["path"], done=processed)
        payload["processedCount"] = processed
        return jsonify(payload), 409
    if processed == 0 and not kept:
        # 全部修订此前都已处理过
        payload["message"] = tr("writing.rollback_txn_undone")
    return jsonify(payload), 200
