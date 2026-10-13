"""按工作区 id 隔离的受控文件目录（安全文件操作公共层）。

写作工作区（``data/workspaces/<id>/``）与本地文献库
（``data/libraries/<id>/``）的目录规则完全一致，仅根目录不同，因此统一抽为
:class:`SafeRoot`：

- 路径严格校验：拒绝绝对路径、``..`` 穿越、非法字符，访问范围不超出
  「根目录/<ws_id>/」容器；
- ``ws_id`` 由后端生成（uuid 短格式），不信任用户输入；
- 相对路径统一使用 POSIX 风格（``/`` 分隔），内部映射到磁盘。

storage.workspace 与 storage.library 各自持有一个 ``SafeRoot`` 实例并保持
各自的公共函数 API，业务层不需要感知本类。
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from i18n import tr

# 禁止分隔符、穿越、控制字符与 ':'（':' 用于 local:ws:path 文献 id 解析）
_ILLEGAL_SEGMENT = re.compile(r"[\\/]|^\.\.$|^\.$|[\x00-\x1f]|:")
_WS_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


class SafeRootError(Exception):
    """受控目录操作错误（携带用户可读消息）。"""


def check_ws_id(ws_id: str) -> str:
    if not _WS_ID_PATTERN.match(ws_id):
        raise SafeRootError(tr("workspace.invalid_id"))
    return ws_id


def _check_segment(seg: str) -> str:
    """校验单段文件名/目录名，禁止分隔符、穿越与空名。"""
    if not seg or _ILLEGAL_SEGMENT.search(seg) or seg in (".", ".."):
        raise SafeRootError(tr("workspace.invalid_segment", segment=repr(seg)))
    if len(seg) > 255:
        raise SafeRootError(tr("workspace.segment_too_long"))
    return seg


class SafeRoot:
    """一个物理根目录下、按 ``<ws_id>/`` 容器隔离的安全文件空间。"""

    def __init__(self, root: Path):
        self._root = Path(root)

    @property
    def root(self) -> Path:
        return self._root

    # ---------- 容器 ----------
    def container_path(self, ws_id: str) -> Path:
        """返回容器绝对路径（不要求存在）。"""
        check_ws_id(ws_id)
        return (self._root / ws_id).resolve()

    def create_container(self, ws_id: str, *, exist_ok: bool = False) -> Path:
        """创建 ``<root>/<ws_id>/`` 容器，返回其绝对路径。"""
        path = self.container_path(ws_id)
        try:
            path.mkdir(parents=True, exist_ok=exist_ok)
        except FileExistsError:
            raise SafeRootError(tr("workspace.create_conflict")) from None
        return path

    def ensure_container(self, ws_id: str) -> Path:
        """容器不存在则创建（幂等），返回其绝对路径。"""
        path = self.container_path(ws_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def remove_container(self, ws_id: str) -> None:
        """删除整个容器（不存在视为成功）。"""
        path = self.container_path(ws_id)
        if path.exists():
            shutil.rmtree(path)

    def list_containers(self) -> list[str]:
        """列出根目录下现存容器 id（仅目录名）。"""
        if not self._root.exists():
            return []
        return sorted(p.name for p in self._root.iterdir() if p.is_dir())

    # ---------- 路径与文件 ----------
    def resolve(self, ws_id: str, rel_path: str = "") -> Path:
        """把相对路径解析为容器内绝对路径，严格校验不越界。

        rel_path 为空时返回容器根目录。路径统一用 POSIX 风格传入。
        """
        root = self.container_path(ws_id)
        if not rel_path:
            return root
        parts = [p for p in rel_path.replace("\\", "/").split("/") if p]
        if not parts:
            return root
        for seg in parts:
            _check_segment(seg)
        target_resolved = root.joinpath(*parts).resolve()
        if target_resolved != root and root not in target_resolved.parents:
            raise SafeRootError(tr("workspace.path_escape"))
        return target_resolved

    def list_files(self, ws_id: str) -> list[dict]:
        """递归列出容器内文件，返回相对路径、大小、修改时间。"""
        root = self.resolve(ws_id)
        if not root.exists():
            return []
        result: list[dict] = []
        for p in sorted(root.rglob("*")):
            if p.is_file():
                st = p.stat()
                result.append({
                    "path": p.relative_to(root).as_posix(),
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                })
        return result

    def write_file(self, ws_id: str, rel_path: str, data: bytes) -> dict:
        """写入（或覆盖）文件，自动创建父目录。返回文件信息。"""
        target = self.resolve(ws_id, rel_path)
        self.ensure_container(ws_id)
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

    def write_text(self, ws_id: str, rel_path: str, text: str) -> dict:
        return self.write_file(ws_id, rel_path, text.encode("utf-8"))

    def read_file(self, ws_id: str, rel_path: str) -> bytes:
        target = self.resolve(ws_id, rel_path)
        if not target.is_file():
            raise SafeRootError(tr("workspace.file_not_found", rel_path=rel_path))
        return target.read_bytes()

    def read_text(self, ws_id: str, rel_path: str) -> str:
        return self.read_file(ws_id, rel_path).decode("utf-8", errors="replace")

    def delete_file(self, ws_id: str, rel_path: str) -> None:
        target = self.resolve(ws_id, rel_path)
        if target.is_file():
            target.unlink()
        else:
            raise SafeRootError(tr("workspace.file_not_found", rel_path=rel_path))

    def exists(self, ws_id: str, rel_path: str) -> bool:
        return self.resolve(ws_id, rel_path).is_file()

    def unique_path(self, ws_id: str, rel_path: str) -> str:
        """若目标文件已存在，生成 ``name (n).ext`` 形式的新路径，避免覆盖。"""
        target = self.resolve(ws_id, rel_path)
        if not target.exists():
            return rel_path
        stem, suffix = target.stem, target.suffix
        for n in range(2, 1000):
            candidate = f"{stem} ({n}){suffix}"
            if not self.resolve(ws_id, candidate).exists():
                return candidate
        raise SafeRootError(tr("workspace.unique_name_failed"))
