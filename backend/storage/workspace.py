"""写作工作区安全文件操作层。

工作区是服务器端受控目录（``config.WORKSPACES_ROOT/<id>/``），只存放写作
文件（LaTeX 源码、bib、图片素材等）。阅读侧上传的文献 PDF 已物理分离到
文献库（见 :mod:`storage.library`，``config.LIBRARIES_ROOT/<id>/``）。

本模块的路径校验/文件操作由公共层 :class:`storage.saferoot.SafeRoot` 提供，
这里保留面向写作业务的函数签名，并负责 workspaces 表的 DB 联动。

设计约束：
- ws_id 由后端生成（uuid 短格式），不信任用户输入；
- 相对路径统一使用 POSIX 风格（``/`` 分隔），后端负责映射到磁盘。
"""
from __future__ import annotations

import uuid

import storage.db as db
from config import WORKSPACES_ROOT
from i18n import tr
from storage.saferoot import SafeRoot, SafeRootError, check_ws_id

# 兼容历史导入：业务层普遍 catch ws.WorkspaceError（即 SafeRootError）
WorkspaceError = SafeRootError

_ROOT = SafeRoot(WORKSPACES_ROOT)


def _new_ws_id() -> str:
    return uuid.uuid4().hex[:12]


def _check_ws_id(ws_id: str) -> str:
    return check_ws_id(ws_id)


def resolve(ws_id: str, rel_path: str = ""):
    return _ROOT.resolve(ws_id, rel_path)


def create_workspace(name: str, description: str = "") -> dict:
    """创建工作区（DB 元数据 + 磁盘目录），返回工作区对象。"""
    ws_id = _new_ws_id()
    db.create_workspace(ws_id, name, description)
    try:
        _ROOT.create_container(ws_id)
    except Exception:
        # DB 行先建后补磁盘：磁盘失败时回滚 DB，避免元数据孤儿
        db.delete_workspace(ws_id)
        raise
    return get_workspace(ws_id)


def get_workspace(ws_id: str) -> dict:
    ws = db.get_workspace(ws_id)
    if ws is None:
        raise WorkspaceError(tr("workspace.not_found"))
    return ws


def list_workspaces() -> list[dict]:
    return db.list_workspaces()


def update_workspace(ws_id: str, *, name: str | None = None,
                     description: str | None = None) -> dict:
    _check_ws_id(ws_id)
    if name is not None and not name.strip():
        raise WorkspaceError(tr("workspace.name_required"))
    db.update_workspace(ws_id, name=name, description=description)
    return get_workspace(ws_id)


def delete_workspace(ws_id: str) -> None:
    """删除工作区：先删磁盘目录（写作目录 + 文献库目录），再删 DB 行。"""
    _check_ws_id(ws_id)
    # 文献库与工作区同生命周期：一并物理删除（DB 行由 db.delete_workspace 级联）
    from storage import library as _library
    _library.remove_library(ws_id)
    _ROOT.remove_container(ws_id)
    db.delete_workspace(ws_id)


def list_files(ws_id: str) -> list[dict]:
    return _ROOT.list_files(ws_id)


def write_file(ws_id: str, rel_path: str, data: bytes) -> dict:
    return _ROOT.write_file(ws_id, rel_path, data)


def read_file(ws_id: str, rel_path: str) -> bytes:
    return _ROOT.read_file(ws_id, rel_path)


def read_text(ws_id: str, rel_path: str) -> str:
    return _ROOT.read_text(ws_id, rel_path)


def write_text(ws_id: str, rel_path: str, text: str) -> dict:
    return _ROOT.write_text(ws_id, rel_path, text)


def delete_file(ws_id: str, rel_path: str) -> None:
    _ROOT.delete_file(ws_id, rel_path)


def exists(ws_id: str, rel_path: str) -> bool:
    return _ROOT.exists(ws_id, rel_path)


def unique_path(ws_id: str, rel_path: str) -> str:
    return _ROOT.unique_path(ws_id, rel_path)
