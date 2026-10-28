"""Markdown 嵌套列表 ↔ MindElixirData（NodeObj 嵌套树）转换器。

前端 ``src/lib/mindmap/elixirMarkdown.ts`` 必须保持逻辑一致。
MindElixirData 结构（纯 dict，JSON 可序列化）::

    {
        "nodeData": {
            "id": "n_aaaaaaaa",
            "topic": "根主题",
            "expanded": true,
            "metadata": {"kind": "topic"},
            "children": [
                {
                    "id": "n_bbbbbbbb",
                    "topic": "分支一",
                    "metadata": {"kind": "topic"},
                    "children": [...]
                },
                {
                    "id": "n_cccccccc",
                    "topic": "论文标题",
                    "metadata": {"kind": "paper", "paperId": "arxiv:2401.00001"},
                    "children": []
                }
            ]
        },
        "direction": 2,
        "compact": false,
        "meta": {"converter": "papermind"}
    }
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from .mindmap_doc import MindmapError

PAPER_LINK_RE = re.compile(r"^\[([^\]]*)\]\(paper:([^\s)]+)\)$")
ID_ANNOTATION_RE = re.compile(r"id:(n_[0-9a-fA-F]{8})\b")
SHAPE_ANNOTATION_RE = re.compile(r"shape:(circle|rect|rounded|hexagon|default)\b")
KIND_ANNOTATION_RE = re.compile(r"kind:(topic|paper)\b")
PAPER_ANNOTATION_RE = re.compile(r"paper:([^\s,>]+)")
HTML_COMMENT_RE = re.compile(r"<!--\s*(.*?)\s*-->", re.DOTALL)
LIST_MARKERS = ("-", "*", "+")
VALID_SHAPES = ("circle", "rect", "rounded", "hexagon", "default")


def _path_id(path: list[int]) -> str:
    h = hashlib.sha1("/".join(str(i) for i in path).encode("utf-8")).hexdigest()[:8]
    return f"n_{h}"


def _safe_text(value: str | None) -> str:
    return (value or "").replace("\r", " ").replace("\n", " ").replace("-->", " ")


def _line_error(key: str, line: int, **params: Any) -> MindmapError:
    params.setdefault("line", line)
    return MindmapError(key, **params)


# ---------- Markdown → MindElixirData ----------

def parse_markdown_to_elixir(text: str) -> dict:
    if not isinstance(text, str) or not text.strip():
        raise MindmapError("mindmap.md_empty")

    lines = text.splitlines()
    stack: list[dict] = []  # 项: {"column": int, "node": dict, "siblingIndex": int}
    level_columns: dict[int, int] = {}
    step: int | None = None

    for line_no in range(1, len(lines) + 1):
        raw = lines[line_no - 1]
        if raw.strip() == "":
            continue

        stripped = raw.lstrip()
        leading_ws = raw[: len(raw) - len(stripped)]
        if "\t" in leading_ws:
            raise _line_error("mindmap.md_indent_char", line_no)
        column = len(leading_ws)

        # 识别列表符号
        marker_pos = -1
        for mk in LIST_MARKERS:
            if stripped.startswith(mk + " ") or stripped == mk:
                marker_pos = len(mk)
                break
        if marker_pos < 0:
            continue

        body = stripped[marker_pos:].lstrip() if marker_pos < len(stripped) else ""

        # 注释元信息
        all_comments = [m.group(1) for m in HTML_COMMENT_RE.finditer(body)]
        content = HTML_COMMENT_RE.sub("", body).strip()

        annotation_id: str | None = None
        annotation_kind: str | None = None
        annotation_paper_id: str | None = None
        for ctext in reversed(all_comments):
            if annotation_id is None:
                m = ID_ANNOTATION_RE.search(ctext)
                if m:
                    annotation_id = m.group(1)
            if annotation_kind is None:
                m = KIND_ANNOTATION_RE.search(ctext)
                if m:
                    annotation_kind = m.group(1)
            if annotation_paper_id is None:
                m = PAPER_ANNOTATION_RE.search(ctext)
                if m:
                    annotation_paper_id = m.group(1)
            if annotation_id and annotation_kind and annotation_paper_id:
                break

        # 栈操作 + 父节点定位
        if not stack:
            level_columns[0] = column
        else:
            root_col = level_columns[0]
            if column <= root_col:
                raise _line_error("mindmap.md_multiple_roots", line_no)
            if step is None and column > stack[-1]["column"]:
                step = column - stack[-1]["column"]
                if step <= 0:
                    raise _line_error("mindmap.md_indent_jump", line_no)
            while stack and stack[-1]["column"] > column:
                stack.pop()
            if not stack or (stack[-1]["column"] != column and step is not None and column != stack[-1]["column"] + step):
                raise _line_error("mindmap.md_indent_jump", line_no)

        parent_item = None if not stack or stack[-1]["column"] < column else (
            stack[-2] if len(stack) >= 2 else None
        )
        sibling_index = len(parent_item["node"].get("children", [])) if parent_item else 0
        path = [item["siblingIndex"] for item in stack] + [sibling_index]
        node_id = annotation_id or _path_id(path)

        # 解析节点内容
        kind = annotation_kind or "topic"
        topic = content
        paper_id = annotation_paper_id

        link_match = PAPER_LINK_RE.match(content)
        if link_match:
            kind = "paper"
            topic = link_match.group(1).strip()
            paper_id = link_match.group(2).strip()

        metadata: dict[str, Any] = {"kind": kind}
        if kind == "paper":
            metadata["paperId"] = paper_id

        elixir_node: dict[str, Any] = {
            "id": node_id,
            "topic": topic or "",
            "metadata": metadata,
            "children": [],
        }

        if parent_item:
            parent_item["node"]["children"].append(elixir_node)

        item = {"column": column, "node": elixir_node, "siblingIndex": sibling_index}
        if not stack:
            stack.append(item)
        elif column > stack[-1]["column"]:
            stack.append(item)
        else:
            while stack and stack[-1]["column"] > column:
                stack.pop()
            if stack and stack[-1]["column"] == column:
                stack[-1] = item
            else:
                stack.append(item)

    if not stack:
        raise MindmapError("mindmap.md_no_nodes")

    return {
        "nodeData": stack[0]["node"],
        "direction": 2,
        "compact": False,
        "meta": {"converter": "papermind"},
    }


# ---------- MindElixirData → Markdown ----------

def _safe_text(value: str | None) -> str:
    return (value or "").replace("\r", " ").replace("\n", " ").replace("-->", " ")


def elixir_to_markdown(data: dict) -> str:
    lines: list[str] = []

    def emit(node: dict, depth: int) -> None:
        indent = "  " * depth
        node_id = node.get("id", "")
        metadata = node.get("metadata") or {}
        kind = metadata.get("kind") or "topic"
        paper_id = metadata.get("paperId")

        text = _safe_text(node.get("topic"))
        if kind == "paper" and paper_id:
            body = f"[{text}](paper:{paper_id})"
        else:
            body = text

        annotations = [f"id:{node_id}"]
        if kind != "topic" or paper_id:
            annotations.append(f"kind:{kind}")
            if paper_id:
                annotations.append(f"paper:{paper_id}")
        comment = " ".join(annotations)

        if body:
            lines.append(f"{indent}- {body} <!-- {comment} -->")
        else:
            lines.append(f"{indent}- <!-- {comment} -->")

        for child in node.get("children") or []:
            emit(child, depth + 1)

    emit(data.get("nodeData") or {}, 0)
    return "\n".join(lines) + "\n"


# ---------- MindmapDoc（扁平 nodes[]） ↔ MindElixirData（嵌套树） ----------

def doc_to_elixir(doc: dict) -> dict:
    """后端扁平 MindmapDoc → MindElixirData 嵌套树（给前端渲染/导出用）。"""
    nodes = doc.get("nodes") or []
    root = next((n for n in nodes if n.get("parentId") is None), None)
    if root is None:
        raise MindmapError("mindmap.root_missing")

    def build(node: dict) -> dict:
        kind = node.get("kind") or "topic"
        children_nodes = [n for n in nodes if n.get("parentId") == node.get("id")]
        elixir_node: dict[str, Any] = {
            "id": node["id"],
            "topic": node.get("text") or "",
            "metadata": {"kind": kind},
        }
        if node.get("paperId"):
            elixir_node["metadata"]["paperId"] = node["paperId"]
        if node.get("collapsed"):
            elixir_node["expanded"] = False
        if children_nodes:
            elixir_node["children"] = [build(c) for c in children_nodes]
        return elixir_node

    return {
        "nodeData": build(root),
        "direction": 2,
        "compact": False,
        "meta": {"converter": "papermind"},
    }


def elixir_to_doc(data: dict) -> dict:
    """MindElixirData 嵌套树 → 后端扁平 MindmapDoc（存库用）。"""
    nodes: list[dict] = []
    counter = 0

    def walk(elixir_node: dict, parent_id: str | None) -> None:
        nonlocal counter
        order = counter
        counter += 1
        metadata = elixir_node.get("metadata") or {}
        kind = metadata.get("kind") or "topic"
        node = {
            "id": elixir_node["id"],
            "parentId": parent_id,
            "order": order,
            "text": elixir_node.get("topic") or "",
            "kind": kind,
            "collapsed": elixir_node.get("expanded") is False,
            "paperId": metadata.get("paperId") if kind == "paper" else None,
        }
        nodes.append(node)
        for child in elixir_node.get("children") or []:
            walk(child, elixir_node["id"])

    walk(data.get("nodeData") or {}, None)
    return {"nodes": nodes}
