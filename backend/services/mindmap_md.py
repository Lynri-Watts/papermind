"""Markdown 嵌套列表 ↔ MindmapDoc 解析器 / 序列化器（后端一份）。

**格式约定（与前端 ``src/lib/mindmap/mdParser.ts`` / ``mdSerializer.ts``
必须逐字节一致；改此文件必须同步改前端）：**

::

    - 根主题 <!-- id:n_aaaaaaaa,shape:circle -->
      - 分支一 <!-- id:n_bbbbbbbb -->
        - 子节点
      - [论文标题](paper:arxiv:2401.00001) <!-- id:n_cccccccc -->

- 列表符号 `-` / `*` / `+` 等价（Markdown 标准），解析时统一兼容，
  序列化时固定使用 `-`；
- 缩进检测：首个父子节点列号差 = 统一缩进步长（2 空格最常见），
  之后每层列号必须是根列 + N * step；
- ``<!-- ... -->`` HTML 注释承载元信息：
  ``id:n_xxxxxxxx`` 为节点稳定 ID 注解；
  ``shape:circle|rect|rounded|hexagon`` 为形状注解；
  根节点规范 shape 恒为 circle，序列化时根节点即便显式 shape=circle 也省略
  shape 注解（只保留 id），往返幂等；
- 无 ``id:`` 注解的手写节点按「索引路径」（根到它的同级序号序列）做 sha1[:8]
  确定性哈希，得到 ``n_<8hex>``：同结构文本重复导入得到相同 ID；
- 论文节点：Markdown 链接 ``[文本](paper:<paperId>)``，paperId 必须符合
  PAPER_ID_RE（见 mindmap_doc）；形状强制为 rect；
- 不支持：嵌套代码块、表格、标题（仅解析列表层级）。

解析失败抛 :class:`mindmap_doc.MindmapError`，参数带 ``line`` 行号（1-based）。
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from .mindmap_doc import (
    MindmapError,
    make_node,
    normalize_orders,
    ordered_children,
    validate_doc,
    validate_paper_id,
)

#: 论文链接 Markdown：[文本](paper:<paperId>)；paperId 内不允许空白/右括号
PAPER_LINK_RE = re.compile(r"^\[([^\]]*)\]\(paper:([^\s)]+)\)$")
#: 注释中的稳定 ID 注解
ID_ANNOTATION_RE = re.compile(r"id:(n_[0-9a-fA-F]{8})\b")
#: 注释中的形状注解
SHAPE_ANNOTATION_RE = re.compile(r"shape:(circle|rect|rounded|hexagon|default)\b")
#: HTML 注释包裹：<!-- ... -->
HTML_COMMENT_RE = re.compile(r"<!--\s*(.*?)\s*-->", re.DOTALL)
#: 支持的列表符号
LIST_MARKERS = ("-", "*", "+")
#: 支持的形状 → shape 枚举
VALID_SHAPES = ("circle", "rect", "rounded", "hexagon", "default")


def _line_error(key: str, line: int, **params: Any) -> MindmapError:
    params.setdefault("line", line)
    return MindmapError(key, **params)


def _path_id(path: tuple[int, ...]) -> str:
    digest = hashlib.sha1("/".join(str(i) for i in path).encode("utf-8")).hexdigest()[:8]
    return f"n_{digest}"


# ---------- 解析 ----------

def parse_markdown(text: str) -> dict:
    """把 Markdown 嵌套列表解析为 MindmapDoc（``{"nodes": [...]}``）。

    缩进栈机：栈项为 ``(列号, 节点ID, 该节点在其兄弟中的序号)``；
    首次父子节点列差确定统一缩进步长；注释承载 ID/shape 元信息。
    """
    if not isinstance(text, str) or not text.strip():
        raise MindmapError("mindmap.md_empty")

    lines = text.splitlines()

    # 栈项：(column, node_id, sibling_index)
    stack: list[tuple[int, str, int]] = []
    level_columns: dict[int, int] = {}
    nodes: list[dict] = []
    step: int | None = None  # 检测到的缩进步长

    for line_no in range(1, len(lines) + 1):
        raw = lines[line_no - 1]
        if raw.strip() == "":
            continue

        # 提取前导空白与正文
        stripped_start = raw.lstrip()
        leading_ws = raw[: len(raw) - len(stripped_start)]
        if "\t" in leading_ws:
            raise _line_error("mindmap.mmd_indent_char", line_no)
        column = len(leading_ws)

        # 识别列表符号
        body_raw = stripped_start
        marker_pos = -1
        for mk in LIST_MARKERS:
            if body_raw.startswith(mk + " ") or body_raw == mk:
                marker_pos = len(mk)
                break
        if marker_pos < 0:
            # 不是列表项：跳过（允许解释性文本行，但不作为节点）
            continue

        body_after_marker = body_raw[marker_pos:].lstrip() if marker_pos < len(body_raw) else ""

        # 拆 HTML 注释（可能多个，只取最后一个里的元信息）
        content = body_after_marker
        annotation_id: str | None = None
        annotation_shape: str | None = None
        # 收集所有注释块
        all_comment_texts: list[str] = []
        for m in HTML_COMMENT_RE.finditer(body_after_marker):
            all_comment_texts.append(m.group(1))
        # 移除所有注释，得到实际节点文本
        content = HTML_COMMENT_RE.sub("", body_after_marker).strip()
        # 从收集到的注释里提取元信息（最后一个优先）
        for ctext in reversed(all_comment_texts):
            if annotation_id is None:
                m = ID_ANNOTATION_RE.search(ctext)
                if m:
                    annotation_id = m.group(1)
            if annotation_shape is None:
                m = SHAPE_ANNOTATION_RE.search(ctext)
                if m:
                    annotation_shape = m.group(1)
            if annotation_id is not None and annotation_shape is not None:
                break

        # 由列号确定父节点与深度
        if not stack:
            # 第一个节点 = 根
            level_columns[0] = column
            parent_id: str | None = None
            depth = 0
            sibling_index = 0
            path: tuple[int, ...] = ()
        else:
            root_column = level_columns[0]
            if column <= root_column:
                # 根列不能有其他节点（单根树）
                raise _line_error("mindmap.md_multiple_roots", line_no)

            # 检测缩进步长（首次出现子节点时）
            if step is None and column > stack[-1][0]:
                parent_col = stack[-1][0]
                step = column - parent_col
                if step <= 0:
                    raise _line_error("mindmap.md_indent_jump", line_no)

            # 列号合法性检查
            if step is not None:
                # 根之外的层：column 应该是 root_column + k * step 或 stack 顶同层
                # 简化：当前列要么等于栈顶同层，要么 = 栈顶 + step（新子层）
                expected_child_col = stack[-1][0] + step if step else stack[-1][0] + 2
                if column != stack[-1][0] and column != expected_child_col:
                    # 回退到祖先层：弹栈直到 column 匹配
                    popped = False
                    while stack and stack[-1][0] > column:
                        stack.pop()
                        popped = True
                    if not stack or stack[-1][0] != column:
                        raise _line_error("mindmap.md_indent_jump", line_no)

            # 栈顶列号 == column → 同层（替换栈顶）；> → 弹；< + step → 子层（压入）
            if column > stack[-1][0]:
                # 孩子：新一层
                depth = len(stack)
                if depth >= 2 and step is not None:
                    expected = level_columns.get(depth - 1, stack[-1][0]) + step
                    if column != expected:
                        raise _line_error("mindmap.md_indent_jump", line_no)
                level_columns.setdefault(depth, column)
                parent_id = stack[-1][1]
            else:
                # 同级或回退祖先层：弹栈直到列号匹配
                while stack and stack[-1][0] > column:
                    stack.pop()
                if not stack or stack[-1][0] != column:
                    raise _line_error("mindmap.md_indent_jump", line_no)
                depth = len(stack)
                parent_id = stack[-2][1] if len(stack) >= 2 else None

            if parent_id is None:
                raise _line_error("mindmap.md_multiple_roots", line_no)

            sibling_index = sum(1 for n in nodes if n["parentId"] == parent_id)
            path = tuple(item[2] for item in stack) + (sibling_index,)

        # 解析节点内容
        kind = "topic"
        text = content
        shape: str = annotation_shape or ("circle" if parent_id is None else "default")
        paper_id: str | None = None

        # 检测 paper 节点（Markdown 链接 [文本](paper:<paperId>)）
        m = PAPER_LINK_RE.match(content)
        if m:
            kind = "paper"
            text = m.group(1).strip()
            raw_paper_id = m.group(2).strip()
            try:
                validate_paper_id(raw_paper_id)
            except MindmapError:
                raise _line_error("mindmap.invalid_paper_id", line_no, paper_id=raw_paper_id)
            paper_id = raw_paper_id
            shape = "rect" if shape == "default" or shape is None else shape

        if shape not in VALID_SHAPES:
            raise _line_error("mindmap.md_invalid_shape", line_no, shape=shape)

        node_id = annotation_id or _path_id(path)
        node = make_node(node_id, parent_id, sibling_index, text,
                         kind=kind, shape=shape, paper_id=paper_id)
        nodes.append(node)

        # 入栈
        if not stack:
            stack.append((column, node_id, sibling_index))
        elif column > stack[-1][0]:
            stack.append((column, node_id, sibling_index))
        else:
            while stack and stack[-1][0] > column:
                stack.pop()
            if stack and stack[-1][0] == column:
                stack[-1] = (column, node_id, sibling_index)
            else:
                stack.append((column, node_id, sibling_index))

    if not nodes:
        raise MindmapError("mindmap.md_no_nodes")

    doc = {"nodes": nodes}
    normalize_orders(doc)
    validate_doc(doc)
    return doc


# ---------- 序列化 ----------

def _safe_text(value: str) -> str:
    """替换 Markdown 会破坏列表结构的字符（换行 → 空格，HTML 注释闭合 → 空格）。"""
    return (value or "").replace("\r", " ").replace("\n", " ").replace("-->", " ")


def doc_to_markdown(doc: dict) -> str:
    """把 MindmapDoc 序列化为合法 Markdown 嵌套列表（两空格缩进、带 HTML 注释元信息）。"""
    validate_doc(doc)
    nodes = doc["nodes"]
    root = next((n for n in nodes if n["parentId"] is None), None)
    if root is None:
        raise MindmapError("mindmap.root_missing")

    lines: list[str] = []

    def emit(node: dict, depth: int) -> None:
        indent = "  " * depth
        text = _safe_text(node.get("text", ""))
        node_id = node["id"]
        kind = node.get("kind") or "topic"
        shape = node.get("shape") or ("circle" if depth == 0 else "default")
        paper_id = node.get("paperId")

        # 构造节点内容体
        if kind == "paper" and paper_id:
            body = f"[{text}](paper:{paper_id})"
        else:
            body = text

        # 构造注释元信息
        # 根节点规范 shape = circle，不写 shape 注解（默认值）
        is_root = depth == 0
        annotations = [f"id:{node_id}"]
        if shape != "default" and not (is_root and shape == "circle"):
            annotations.append(f"shape:{shape}")
        comment = " ".join(annotations)

        # 列表项：空文本也必须输出（仅包含注释）
        if body:
            lines.append(f"{indent}- {body} <!-- {comment} -->")
        else:
            lines.append(f"{indent}- <!-- {comment} -->")

        for child in ordered_children(nodes, node["id"]):
            emit(child, depth + 1)

    emit(root, 0)
    return "\n".join(lines) + "\n"
