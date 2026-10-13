"""本地文献库安全文件操作层（阅读侧文献 PDF）。

与写作工作区物理分离：文献存放于 ``config.LIBRARIES_ROOT/<id>/``，目录规则
与 :mod:`storage.workspace` 完全一致（共用 :class:`SafeRoot`）。

本地文献 id 仍为 ``local:<ws_id>:<rel_path>``（见 services/fulltext.py 的
``split_local_id``），其中 rel_path 改为相对**文献库根**；id 格式不变意味着
DB 全文缓存、上下文库、思维导图节点引用等历史数据无需迁移。

旧版本把阅读文献与写作文件混放在 workspaces/<id>/ 中，:func:`migrate_legacy_literature`
在应用启动时幂等搬迁（除编译产物 main.pdf 外的所有 PDF）。
"""
from __future__ import annotations

import shutil
from pathlib import Path

from config import LIBRARIES_ROOT, WORKSPACES_ROOT
from storage.saferoot import SafeRoot

_LIBRARY = SafeRoot(LIBRARIES_ROOT)
_WRITING = SafeRoot(WORKSPACES_ROOT)

# 编译入口产物固定名：位于写作容器根的 main.pdf 是 xelatex 输出而非文献
MAIN_PDF = "main.pdf"


def ensure_library(ws_id: str) -> Path:
    return _LIBRARY.ensure_container(ws_id)


def remove_library(ws_id: str) -> None:
    _LIBRARY.remove_container(ws_id)


def resolve(ws_id: str, rel_path: str = "") -> Path:
    return _LIBRARY.resolve(ws_id, rel_path)


def list_library_files(ws_id: str) -> list[dict]:
    return _LIBRARY.list_files(ws_id)


def write_library_file(ws_id: str, rel_path: str, data: bytes) -> dict:
    return _LIBRARY.write_file(ws_id, rel_path, data)


def read_library_file(ws_id: str, rel_path: str) -> bytes:
    return _LIBRARY.read_file(ws_id, rel_path)


def delete_library_file(ws_id: str, rel_path: str) -> None:
    _LIBRARY.delete_file(ws_id, rel_path)


def library_exists(ws_id: str, rel_path: str) -> bool:
    return _LIBRARY.exists(ws_id, rel_path)


def unique_library_path(ws_id: str, rel_path: str) -> str:
    return _LIBRARY.unique_path(ws_id, rel_path)


def _is_legacy_literature_pdf(rel_path: str) -> bool:
    """写作容器中的该文件是否属于应搬迁的旧版文献 PDF。

    规则：扩展名 .pdf，且不是位于容器根的编译产物 main.pdf。
    """
    p = rel_path.replace("\\", "/")
    if not p.lower().endswith(".pdf"):
        return False
    return p != MAIN_PDF


def migrate_legacy_literature() -> list[tuple[str, str, str]]:
    """把混放在写作容器中的旧版文献 PDF 搬迁到文献库（幂等）。

    遍历所有现存写作容器，把除根目录 main.pdf 外的 PDF 移到对应文献库容器，
    保持相对子目录结构；目标重名时自动改用 unique 名。文献 id 中的 rel_path
    会随之变化——历史缓存/上下文若指向旧路径，读取时按缺失容错（与"用户删除
    了文件"一致），搬迁后阅读侧以新路径重新打开。

    :returns: 搬迁记录列表 (ws_id, 旧 rel_path, 新 rel_path)
    """
    moved: list[tuple[str, str, str]] = []
    for ws_id in _WRITING.list_containers():
        for info in _WRITING.list_files(ws_id):
            old_rel = info["path"]
            if not _is_legacy_literature_pdf(old_rel):
                continue
            src = _WRITING.resolve(ws_id, old_rel)
            new_rel = _LIBRARY.unique_path(ws_id, old_rel)
            dst = _LIBRARY.resolve(ws_id, new_rel)
            _LIBRARY.ensure_container(ws_id)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            moved.append((ws_id, old_rel, new_rel))
    return moved
