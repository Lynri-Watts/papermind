"""工作区安全文件操作层。

工作区是服务器端受控目录（``config.WORKSPACES_ROOT/<id>/``），用于存放
用户上传的文件与正在写作的文件（如 LaTeX 源码）。为在线部署做准备，所有
对工作区目录的读写都必须经过本层：

- 路径严格校验：拒绝绝对路径、``..`` 穿越、非法字符，确保访问范围不超出
  对应工作区目录；
- 工作区元数据（id/name/description）存 ``workspaces`` 表，文件存磁盘。

设计约束：
- ws_id 由后端生成（uuid 短格式），不信任用户输入；
- 相对路径统一使用 POSIX 风格（``/`` 分隔），后端负责映射到磁盘。
"""
from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

import storage.db as db
from config import WORKSPACES_ROOT
from i18n import tr

# 允许作为文件/目录名的字符（含中文等非 ASCII）：仅禁止路径分隔、穿越与保留名
_ILLEGAL_WS = re.compile(r"[^A-Za-z0-9_-]")
# 禁止分隔符、穿越、控制字符与 ':'（':' 用于 local:ws:path 文献 id 解析）
_ILLEGAL_SEGMENT = re.compile(r"[\\/]|^\.\.$|^\.$|[\x00-\x1f]|:")
_WS_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


class WorkspaceError(Exception):
    """工作区操作错误（携带用户可读消息）。"""


def _new_ws_id() -> str:
    return uuid.uuid4().hex[:12]


def _check_ws_id(ws_id: str) -> str:
    if not _WS_ID_PATTERN.match(ws_id):
        raise WorkspaceError(tr("workspace.invalid_id"))
    return ws_id


def _check_segment(seg: str) -> str:
    """校验单段文件名/目录名，禁止分隔符、穿越与空名。"""
    if not seg or _ILLEGAL_SEGMENT.search(seg) or seg in (".", ".."):
        raise WorkspaceError(tr("workspace.invalid_segment", segment=repr(seg)))
    if len(seg) > 255:
        raise WorkspaceError(tr("workspace.segment_too_long"))
    return seg


def resolve(ws_id: str, rel_path: str = "") -> Path:
    """把相对路径解析为工作区内的绝对路径，严格校验不越界。

    rel_path 为空时返回工作区根目录。路径统一用 POSIX 风格传入。
    """
    ws_id = _check_ws_id(ws_id)
    root = WORKSPACES_ROOT / ws_id
    root_resolved = root.resolve()
    if not rel_path:
        return root_resolved
    # 规范化：按 / 分段、丢弃空段（容错 // 与结尾 /）
    parts = [p for p in rel_path.replace("\\", "/").split("/") if p]
    if not parts:
        return root_resolved
    for seg in parts:
        _check_segment(seg)
    target = root.joinpath(*parts)
    target_resolved = target.resolve()
    if target_resolved != root_resolved and root_resolved not in target_resolved.parents:
        raise WorkspaceError(tr("workspace.path_escape"))
    return target_resolved


def create_workspace(name: str, description: str = "") -> dict:
    """创建工作区（磁盘目录 + DB 元数据），返回工作区对象。"""
    ws_id = _new_ws_id()
    root = WORKSPACES_ROOT / ws_id
    try:
        root.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise WorkspaceError(tr("workspace.create_conflict")) from None
    db.create_workspace(ws_id, name, description)
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
    """删除工作区：先删磁盘目录，再删 DB 行（目录删除失败则抛出异常）。"""
    _check_ws_id(ws_id)
    root = resolve(ws_id)
    if root.exists():
        shutil.rmtree(root)
    db.delete_workspace(ws_id)


def list_files(ws_id: str) -> list[dict]:
    """递归列出工作区文件，返回相对路径、大小、修改时间。"""
    root = resolve(ws_id)
    if not root.exists():
        return []
    result: list[dict] = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            st = p.stat()
            result.append({
                "path": rel,
                "size": st.st_size,
                "mtime": int(st.st_mtime),
            })
    return result


def write_file(ws_id: str, rel_path: str, data: bytes) -> dict:
    """写入（或覆盖）文件，自动创建父目录。返回文件信息。"""
    target = resolve(ws_id, rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)  # 原子替换，避免写一半
    st = target.stat()
    return {
        "path": rel_path.replace("\\", "/"),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
    }


def read_file(ws_id: str, rel_path: str) -> bytes:
    target = resolve(ws_id, rel_path)
    if not target.is_file():
        raise WorkspaceError(tr("workspace.file_not_found", rel_path=rel_path))
    return target.read_bytes()


def read_text(ws_id: str, rel_path: str) -> str:
    return read_file(ws_id, rel_path).decode("utf-8", errors="replace")


def write_text(ws_id: str, rel_path: str, text: str) -> dict:
    return write_file(ws_id, rel_path, text.encode("utf-8"))


def delete_file(ws_id: str, rel_path: str) -> None:
    target = resolve(ws_id, rel_path)
    if target.is_file():
        target.unlink()
    else:
        raise WorkspaceError(tr("workspace.file_not_found", rel_path=rel_path))


def exists(ws_id: str, rel_path: str) -> bool:
    return resolve(ws_id, rel_path).is_file()


def unique_path(ws_id: str, rel_path: str) -> str:
    """若目标文件已存在，生成 ``name (n).ext`` 形式的新路径，避免覆盖。"""
    target = resolve(ws_id, rel_path)
    if not target.exists():
        return rel_path
    stem, suffix = target.stem, target.suffix
    for n in range(2, 1000):
        candidate = f"{stem} ({n}){suffix}"
        if not resolve(ws_id, candidate).exists():
            return candidate
    raise WorkspaceError(tr("workspace.unique_name_failed"))
