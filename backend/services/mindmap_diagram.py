"""Mermaid 图类型检测（后端一份，与前端 ``src/lib/mindmap/diagramType.ts`` 同规则）。

导图文档只区分两类：

- ``mindmap``：缩进树，走 :mod:`services.mindmap_mmd` 解析为节点树 + 可编辑画布；
- 其他一切 mermaid 图（``flowchart`` / ``sequenceDiagram`` / ``C4Context`` /
  各类 ``*-beta`` ……）：原文存储，前端以 mermaid 引擎只读渲染。

后端不维护会随 mermaid 版本漂移的类型白名单：图类型名取源码首个有效声明行的
首 token 原样保存，语法合法性由前端 mermaid 引擎负责。跳行规则与 mindmap
解析器定位图头一致：空行、``%%`` 注释行（含 ``%%{init}%%`` directive）以及
mermaid 11 的 ``---`` YAML front-matter 块都不是图头。
"""
from __future__ import annotations

from typing import NamedTuple, Optional

#: 思维导图类型标识（doc.diagramType 的唯一可编辑值）
MINDMAP_TYPE = "mindmap"
#: front-matter 边界行
_FRONT_MATTER = "---"


class DiagramHeader(NamedTuple):
    """首个有效图声明：kind=mindmap/other，type=首声明 token，line=1-based 行号。"""

    kind: str
    type: str
    line: int


def detect_diagram_header(text: object) -> Optional[DiagramHeader]:
    """定位 mermaid 源码的图头；无任何有效声明行时返回 ``None``。

    与前端 ``detectDiagramHeader`` 逐分支一致；改动必须双端同步。
    """
    if not isinstance(text, str):
        return None
    lines = text.splitlines()

    # 1) 前导空行
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1

    # 2) YAML front-matter：源码以 --- 行开始时，整块跳到闭合 ---
    if i < len(lines) and lines[i].strip() == _FRONT_MATTER:
        i += 1
        while i < len(lines) and lines[i].strip() != _FRONT_MATTER:
            i += 1
        i += 1  # 跳过闭合行（未闭合则直接到 EOF，返回 None）

    # 3) 正文：跳过空行与 %% 注释行，首个 token 即图类型声明
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped and not stripped.startswith("%%"):
            token = stripped.split(None, 1)[0]
            if token:
                return DiagramHeader(
                    kind=MINDMAP_TYPE if token == MINDMAP_TYPE else "other",
                    type=token,
                    line=i + 1,
                )
        i += 1
    return None


def is_mindmap_source(text: object) -> bool:
    """便捷判定：源码是否为 mermaid mindmap 声明。"""
    header = detect_diagram_header(text)
    return header is not None and header.kind == MINDMAP_TYPE
