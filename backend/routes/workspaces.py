"""工作区 API 路由。

工作区是服务器端受控目录（见 ``storage.workspace`` 安全层），用于存放
用户上传的文献文件（PDF）与正在写作的文件（如 LaTeX 源码）。所有文件
操作只经过安全层，不接受任意本地路径。

本地文献统一 id：``local:<ws_id>:<rel_path>``，接入现有 Paper 机制
（/paper/<id>、PDF、全文、上下文、RAG 工具全复用）。
"""
from __future__ import annotations

from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

import storage.db as db
import storage.workspace as ws
from i18n import tr
from routes.papers import ApiError

workspaces_api = Blueprint("workspaces", __name__)


@workspaces_api.errorhandler(ApiError)
def _handle_api_error(err: ApiError):
    return jsonify({"error": err.message}), err.status


@workspaces_api.errorhandler(Exception)
def _handle_unexpected(err: Exception):
    return jsonify({"error": tr("workspace.internal_error", err=err)}), 500


# 写作文件的约定文件名：前端 LaTeX 编辑器的内容保存于此
LATEX_FILE = "main.tex"

_ALLOWED_UPLOAD_EXTS = {".pdf", ".tex", ".bib", ".txt", ".md"}


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
    # 标注文件类别，供前端分类展示
    for f in files:
        ext = Path(f["path"]).suffix.lower()
        f["kind"] = ("pdf" if ext == ".pdf"
                     else "latex" if ext in (".tex", ".bib")
                     else "text" if ext in (".txt", ".md")
                     else "other")
        f["paper_id"] = _paper_id(ws_id, f["path"]) if ext == ".pdf" else None
    return jsonify({"files": files})


@workspaces_api.post("/workspaces/<ws_id>/files")
def upload_file(ws_id: str):
    """上传文件（multipart/form-data, 字段名 file）。PDF 同时注册为本地文献。"""
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
    info["kind"] = "pdf" if ext == ".pdf" else ("latex" if ext in (".tex", ".bib") else "text")
    info["paper_id"] = _paper_id(ws_id, rel_path) if ext == ".pdf" else None
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
    """写入文本文件（body: {content}）。"""
    body = request.get_json(silent=True) or {}
    if "content" not in body:
        raise ApiError(tr("workspace.content_required"))
    try:
        info = ws.write_text(ws_id, rel_path, body.get("content") or "")
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 400) from exc
    return jsonify({"file": info})


@workspaces_api.delete("/workspaces/<ws_id>/files/<path:rel_path>")
def delete_file(ws_id: str, rel_path: str):
    try:
        ws.delete_file(ws_id, rel_path)
    except ws.WorkspaceError as exc:
        raise ApiError(str(exc), 404) from exc
    # PDF 是对应本地文献（local:<ws>:<path>）的权威副本：文件删除后清理
    # 其 DB 全文缓存、PDF 状态、笔记/数据块及引用它的上下文条目，避免孤儿数据。
    # 非 PDF（tex/bib/txt/md）无文献 id，不涉及关联数据。
    if Path(rel_path).suffix.lower() == ".pdf":
        db.delete_local_paper_data(_paper_id(ws_id, rel_path))
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
