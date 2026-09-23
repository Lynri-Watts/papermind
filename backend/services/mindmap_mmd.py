"""mermaid ``mindmap`` 缩进语法子集的解析器 / 序列化器（后端一份）。

**格式约定（与前端 ``src/lib/mindmap/mmdParser.ts`` / ``mmdSerializer.ts``
必须逐字节一致；改此文件必须同步改前端）：**

::

    mindmap
      ((根文本))                                          <- 根，circle 形状
        普通分支文本                                       <- topic 节点
          [论文标题](paper:arxiv:2401.00001)              <- paper 节点
        %%id:n_aaaaaaaa                                   <- 文本为空的节点

- 缩进表示层级：首个节点的列号为根列，第一次「父→子」的列差确定为统一步长
  （官方示例通常为 2 空格）；之后每层列号必须精确匹配，否则报缩进跳跃；
- ``%%`` 起到行尾为 mermaid 注释，其中形如 ``id:n_xxxxxxxx`` 的标记是**节点
  稳定 ID 注解**（真实 mermaid 把它当普通注释忽略，不影响渲染）；
- 序列化始终带 ID 注解，因此「导出 → 再导入」可按稳定 ID 合入，不丢手动几何；
- 无 ID 注解的手写节点按「索引路径」（根到它的同级序号序列）做确定性哈希，
  得到 ``n_<8hex>``：同结构文本重复导入得到相同 ID；
- 支持的形状包裹（解析时归一为 topic，形状信息 v1 丢弃）：
  ``((x))`` / ``(x)`` / ``[x]`` / ``{{x}}``；允许 ``root((x))`` 式前置节点名；
- 论文节点：整行为一个 Markdown 链接，链接目标以 ``paper:`` 开头；
- 不支持：非 mindmap 图类型、自由边、``::icon()`` 类指令行（直接跳过）。

解析失败抛 :class:`services.mindmap_doc.MindmapError`，参数带 ``line`` 行号（1-based）。
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

#: 论文链接：[文本](paper:<paperId>)；paperId 内不允许空白/右括号
PAPER_LINK_RE = re.compile(r"^\[([^\]]*)\]\(paper:([^\s)]+)\)\s*$")
#: 注释中的稳定 ID 注解
ID_ANNOTATION_RE = re.compile(r"(?:^|\s)id:(n_[0-9a-fA-F]{8})\b")
#: 支持的形状包裹（长前缀优先）
_SHAPE_WRAPPERS = (("((", "))"), ("{{", "}}"), ("[", "]"), ("(", ")"))
#: root((mindmap)) 式前置节点名（解析后丢弃，仅用于兼容官方语法）
_PREFIX_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*")

#: 占位布局（后端导入时给线性初值；前端可再 tidy-tree）
LEVEL_X = 240.0
ROW_Y = 72.0


def _line_error(key: str, line: int, **params: Any) -> MindmapError:
    params.setdefault("line", line)
    return MindmapError(key, **params)


def _strip_shape(content: str) -> str:
    """剥离形状包裹与可选的前置节点名，返回纯文本。"""
    text = content.strip()
    for left, right in _SHAPE_WRAPPERS:
        if text.startswith(left) and text.endswith(right) and len(text) >= len(left) + len(right):
            return text[len(left):len(text) - len(right)].strip()
    # root((mindmap)) / id[Text] 形式：先剥前置名再试形状
    match = _PREFIX_NAME_RE.match(text)
    if match:
        rest = text[match.end():].lstrip()
        for left, right in _SHAPE_WRAPPERS:
            if rest.startswith(left) and rest.endswith(right) and len(rest) >= len(left) + len(right):
                return rest[len(left):len(rest) - len(right)].strip()
    return text


def _path_id(path: tuple[int, ...]) -> str:
    digest = hashlib.sha1("/".join(str(i) for i in path).encode("utf-8")).hexdigest()[:8]
    return f"n_{digest}"


def _parse_content(content: str, line_no: int) -> tuple[str, str, str | None]:
    """返回 (kind, text, paperId)。"""
    m = PAPER_LINK_RE.match(content)
    if m:
        text = m.group(1).strip()
        paper_id = m.group(2).strip()
        try:
            validate_paper_id(paper_id)
        except MindmapError:
            raise _line_error("mindmap.invalid_paper_id", line_no, paper_id=paper_id)
        return "paper", text, paper_id
    return "topic", _strip_shape(content), None


def parse_mermaid(text: str) -> dict:
    """把 mermaid mindmap 文本解析为 MindmapDoc（``{"nodes": [...]}``）。

    缩进栈机：栈项为 ``(列号, 节点ID, 该节点在其兄弟中的序号)``；
    ``level_columns[d]`` 记录第 d 层的列号，第一个父子列差确定统一缩进步长。
    """
    if not isinstance(text, str) or not text.strip():
        raise MindmapError("mindmap.mmd_empty")

    lines = text.splitlines()

    # 1) 定位 mindmap 头（允许空行/注释先行）
    header_line: int | None = None
    for idx, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("%%"):
            continue
        if stripped.split("%%", 1)[0].strip() == "mindmap":
            header_line = idx
            break
        raise _line_error("mindmap.mmd_missing_header", idx)
    if header_line is None:
        raise MindmapError("mindmap.mmd_missing_header", line=1)

    # 栈项：(column, node_id, sibling_index)
    stack: list[tuple[int, str, int]] = []
    level_columns: dict[int, int] = {}
    nodes: list[dict] = []
    row_cursor = 0

    for line_no in range(header_line + 1, len(lines) + 1):
        raw = lines[line_no - 1]
        if raw.strip() == "":
            continue
        leading_ws = raw[:len(raw) - len(raw.lstrip())]
        if "\t" in leading_ws:
            raise _line_error("mindmap.mmd_indent_char", line_no)
        column = len(leading_ws)
        body_raw = raw.strip()
        if body_raw.startswith("::"):
            continue  # ::icon()/类指令行，v1 忽略

        # 拆注释与 ID 注解
        body = body_raw
        annotation: str | None = None
        if "%%" in body:
            body, comment = body.split("%%", 1)
            body = body.rstrip()
            m = ID_ANNOTATION_RE.search(comment)
            if m:
                annotation = m.group(1)
        content = body.strip()
        if not content and not annotation:
            continue  # 普通注释行

        # 2) 由列号确定父节点与深度
        if not stack:
            # 第一个节点 = 根
            level_columns[0] = column
            parent_id: str | None = None
            depth = 0
            sibling_index = 0
            path: tuple[int, ...] = ()
        else:
            root_column = level_columns[0]
            if column == root_column:
                raise _line_error("mindmap.mmd_multiple_roots", line_no)
            if column < root_column:
                raise _line_error("mindmap.mmd_indent_outside_root", line_no)

            if column > stack[-1][0]:
                # 孩子：新一层
                depth = len(stack)
                expected: int | None = None
                if depth in level_columns:
                    expected = level_columns[depth]
                elif depth >= 2:
                    # 步长已由前两层确定，新层列号必须可推出
                    step = level_columns[1] - level_columns[0]
                    expected = level_columns[depth - 1] + step
                if expected is not None and column != expected:
                    raise _line_error("mindmap.mmd_indent_jump", line_no)
                level_columns.setdefault(depth, column)
                parent_id = stack[-1][1]
            else:
                # 同级或回退到祖先层：弹栈直到列号匹配
                while stack and stack[-1][0] > column:
                    stack.pop()
                # 能走到这里说明 column > root_column（根列已在上面拦截），
                # 匹配后栈深至少为 2，父节点即栈顶的上一层。
                if len(stack) < 2 or stack[-1][0] != column:
                    raise _line_error("mindmap.mmd_indent_jump", line_no)
                depth = len(stack)
                parent_id = stack[-2][1]
            sibling_index = sum(1 for n in nodes if n["parentId"] == parent_id)
            path = tuple(item[2] for item in stack) + (sibling_index,)

        kind, text, paper_id = _parse_content(content, line_no)
        node_id = annotation or _path_id(path)
        node = make_node(node_id, parent_id, sibling_index, text,
                         kind=kind, paper_id=paper_id,
                         x=float(depth) * LEVEL_X, y=float(row_cursor) * ROW_Y)
        row_cursor += 1
        nodes.append(node)

        # 3) 入栈：新层压入；同层替换栈顶
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
        raise MindmapError("mindmap.mmd_no_nodes")

    doc = {"nodes": nodes}
    normalize_orders(doc)
    validate_doc(doc)
    return doc


def doc_to_mermaid(doc: dict) -> str:
    """把 MindmapDoc 序列化为合法 mermaid mindmap 文本（两空格缩进、带 ID 注解）。"""
    validate_doc(doc)
    nodes = doc["nodes"]
    root = next((n for n in nodes if n["parentId"] is None), None)
    if root is None:
        raise MindmapError("mindmap.root_missing")

    def safe_text(value: str) -> str:
        return (value or "").replace("\r", " ").replace("\n", " ").replace("%%", " ")

    lines = ["mindmap"]

    def emit(node: dict, depth: int) -> None:
        indent = "  " * (depth + 1)
        annotation = f"%%id:{node['id']}"
        text = safe_text(node.get("text", ""))
        if depth == 0:
            body = f"(({text}))"
        elif node.get("kind") == "paper" and node.get("paperId"):
            body = f"[{text}](paper:{node['paperId']})"
        else:
            body = text
        if body:
            lines.append(f"{indent}{body}  {annotation}")
        else:
            # 空文本：整行只有缩进与 ID 注解
            lines.append(f"{indent}{annotation}")
        for child in ordered_children(nodes, node["id"]):
            emit(child, depth + 1)

    emit(root, 0)
    return "\n".join(lines) + "\n"
