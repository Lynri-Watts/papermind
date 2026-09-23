"""思维导图文档内核：节点树模型、树不变量校验、动作（actions）批量应用。

本模块是导图唯一的结构化变更入口（GUI 与 AI 共用），不依赖 Flask/DB，
便于自动化测试。设计约定：

- 文档为 JSON 原生 dict：``{"nodes": [MindmapNode, ...]}``；
- MindmapNode::

      {
        "id": "n_xxxxxxxx",          # 稳定 ID（服务端生成或客户端临时 ID 回填）
        "parentId": "n_yyy" | null,  # 根为 null
        "order": 0,                  # 同级位置（每次动作后规范化为 0..n-1）
        "text": "节点文本",
        "kind": "topic" | "paper",
        "paperId": "source:ext" | "local:..." | null,  # 仅 kind=paper
        "x": 0.0, "y": 0.0,          # 手动几何坐标（mermaid 不表达几何）
        "collapsed": false           # 可选；折叠分支
      }

- 动作顺序应用到深拷贝上，任一动作非法即抛 :class:`MindmapError`，
  调用方传入的原文档不会被改动（无半截写入）；
- 错误携带 i18n 键（``mindmap.xxx``，文案表在 ``locales/mindmap.py``）
  与插值参数，路由层负责翻译。
"""
from __future__ import annotations

import re
import uuid
from copy import deepcopy
from typing import Any

#: paperId 必须形如 "source:external_id"（含 local:<...>）：
#: 段为字母数字/._-，冒号后非空白且至少一个字符。
PAPER_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]+:[^\s]+$")

VALID_KINDS = ("topic", "paper")


class MindmapError(Exception):
    """结构化导图错误：携带 i18n 键与参数，而非面向用户的成品文案。"""

    def __init__(self, key: str, **params: Any) -> None:
        super().__init__(key)
        self.key = key
        self.params = params
        self.action_index: int | None = None

    def with_index(self, index: int) -> "MindmapError":
        self.action_index = index
        return self


# ---------- 基础构造 ----------
def new_node_id(existing: set[str] | None = None) -> str:
    """生成 ``n_<8 位十六进制>``；极小概率碰撞时重试。"""
    existing = existing if existing is not None else set()
    for _ in range(10):
        candidate = "n_" + uuid.uuid4().hex[:8]
        if candidate not in existing:
            return candidate
    raise MindmapError("mindmap.id_generate_failed")


def make_node(node_id: str, parent_id: str | None, order: int,
              text: str = "", *, kind: str = "topic", paper_id: str | None = None,
              x: float = 0.0, y: float = 0.0, collapsed: bool = False) -> dict:
    return {
        "id": node_id,
        "parentId": parent_id,
        "order": order,
        "text": text,
        "kind": kind,
        "paperId": paper_id,
        "x": x,
        "y": y,
        "collapsed": collapsed,
    }


def new_doc(root_text: str = "", root_id: str | None = None) -> dict:
    """构造仅含一个根节点的新文档。"""
    rid = root_id or new_node_id()
    return {"nodes": [make_node(rid, None, 0, root_text)]}


# ---------- 查询辅助 ----------
def find_root(nodes: list[dict]) -> dict | None:
    roots = [n for n in nodes if n.get("parentId") is None]
    return roots[0] if roots else None


def index_nodes(nodes: list[dict]) -> dict[str, dict]:
    return {n["id"]: n for n in nodes}


def ordered_children(nodes: list[dict], parent_id: str | None) -> list[dict]:
    """同一父节点下的子节点，按 (order, id) 稳定排序。"""
    kids = [n for n in nodes if n.get("parentId") == parent_id]
    return sorted(kids, key=lambda n: (n.get("order", 0), n["id"]))


def descendant_ids(nodes: list[dict], node_id: str) -> list[str]:
    """返回 node 的全部后代 ID（含自身），按先序。"""
    by_parent: dict[str | None, list[str]] = {}
    for n in nodes:
        by_parent.setdefault(n.get("parentId"), []).append(n["id"])
    result: list[str] = []
    stack = [node_id]
    while stack:
        cur = stack.pop()
        result.append(cur)
        for child in reversed(sorted(by_parent.get(cur, []))):
            stack.append(child)
    return result


def validate_paper_id(paper_id: Any) -> str:
    if not isinstance(paper_id, str) or not PAPER_ID_RE.match(paper_id):
        raise MindmapError("mindmap.invalid_paper_id", paper_id=str(paper_id))
    return paper_id


# ---------- 不变量 ----------
def validate_doc(doc: Any) -> None:
    """校验整棵树的不变量；非法时抛 MindmapError，正常返回 None。"""
    if not isinstance(doc, dict) or not isinstance(doc.get("nodes"), list):
        raise MindmapError("mindmap.doc_malformed")
    nodes = doc["nodes"]
    if not nodes:
        raise MindmapError("mindmap.empty_doc")

    seen: set[str] = set()
    for n in nodes:
        if not isinstance(n, dict) or not isinstance(n.get("id"), str) or not n["id"]:
            raise MindmapError("mindmap.id_required")
        if n["id"] in seen:
            raise MindmapError("mindmap.duplicate_id", id=n["id"])
        seen.add(n["id"])

    roots = [n for n in nodes if n.get("parentId") is None]
    if len(roots) == 0:
        raise MindmapError("mindmap.root_missing")
    if len(roots) > 1:
        raise MindmapError("mindmap.multiple_roots",
                           ids=", ".join(n["id"] for n in roots))

    by_id = index_nodes(nodes)
    for n in nodes:
        pid = n.get("parentId")
        if pid is not None and pid not in by_id:
            raise MindmapError("mindmap.dangling_parent", id=n["id"], parent=pid)
        kind = n.get("kind")
        if kind not in VALID_KINDS:
            raise MindmapError("mindmap.invalid_kind", id=n["id"], kind=str(kind))
        if kind == "paper":
            pid_val = n.get("paperId")
            if not isinstance(pid_val, str) or not pid_val:
                raise MindmapError("mindmap.paper_id_required", id=n["id"])
            validate_paper_id(pid_val)
        elif n.get("paperId") not in (None, ""):
            raise MindmapError("mindmap.topic_has_paper_id", id=n["id"])
        order = n.get("order")
        if not isinstance(order, int) or isinstance(order, bool) or order < 0:
            raise MindmapError("mindmap.order_invalid", id=n["id"])
        for coord in ("x", "y"):
            val = n.get(coord, 0)
            if not isinstance(val, (int, float)) or isinstance(val, bool):
                raise MindmapError("mindmap.coordinate_invalid", id=n["id"])
        if "collapsed" in n and not isinstance(n["collapsed"], bool):
            raise MindmapError("mindmap.collapsed_invalid", id=n["id"])

    # 同级 order 唯一性（不要求连续——规范化在动作/边界层做）
    by_parent: dict[str | None, list[dict]] = {}
    for n in nodes:
        by_parent.setdefault(n.get("parentId"), []).append(n)
    for siblings in by_parent.values():
        orders = [n["order"] for n in siblings]
        if len(set(orders)) != len(orders):
            raise MindmapError("mindmap.sibling_order_conflict")

    # 无环（沿父链上溯，重复即环）
    for n in nodes:
        walked: set[str] = set()
        cur: dict | None = n
        while cur is not None and cur.get("parentId") is not None:
            cid = cur["id"]
            if cid in walked:
                raise MindmapError("mindmap.cycle_detected", id=cid)
            walked.add(cid)
            cur = by_id.get(cur["parentId"])


def normalize_orders(doc: dict) -> dict:
    """把每个父节点下的 order 按 (order, id) 顺序重排为 0..n-1（原地）。"""
    nodes = doc["nodes"]
    parents = {None} | {n.get("parentId") for n in nodes}
    for pid in parents:
        for i, child in enumerate(ordered_children(nodes, pid)):
            child["order"] = i
    return doc


# ---------- 动作 ----------
def apply_actions(doc: dict, actions: list[dict]) -> tuple[dict, dict]:
    """对文档顺序应用一批动作，返回 (新文档, 结果信息)。

    - 输入文档不会被修改（内部深拷贝）；
    - 任一动作非法（含动作应用后整树不变量不满足）抛 MindmapError，
      异常带 action_index；
    - 结果信息当前含 ``idMap``：客户端临时 ID → 服务端正式 ID。
    """
    if not isinstance(actions, list):
        raise MindmapError("mindmap.actions_not_list")
    work = deepcopy(doc)
    id_map: dict[str, str] = {}
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            raise MindmapError("mindmap.action_malformed").with_index(index)
        try:
            _apply_one(work, action, id_map)
        except MindmapError as exc:
            raise exc.with_index(index)
    normalize_orders(work)
    validate_doc(work)
    return work, {"idMap": id_map}


def _resolve_id(value: Any, id_map: dict[str, str]) -> str:
    """动作中的节点引用：先查临时 ID 映射，再按字面量。"""
    if not isinstance(value, str) or not value:
        raise MindmapError("mindmap.id_required")
    return id_map.get(value, value)


def _apply_one(doc: dict, action: dict, id_map: dict[str, str]) -> None:
    op = action.get("op")
    by_id = index_nodes(doc["nodes"])

    if op == "add_node":
        _op_add(doc, action, id_map)
    elif op == "update_node":
        _op_update(_require_node(action.get("id"), by_id, id_map), action)
    elif op == "move_node":
        _op_move(doc, _require_node(action.get("id"), by_id, id_map), action, id_map)
    elif op == "delete_node":
        _op_delete(doc, _require_node(action.get("id"), by_id, id_map), action)
    elif op == "set_collapsed":
        node = _require_node(action.get("id"), by_id, id_map)
        collapsed = action.get("collapsed")
        if not isinstance(collapsed, bool):
            raise MindmapError("mindmap.collapsed_invalid", id=node["id"])
        node["collapsed"] = collapsed
    elif op == "attach_paper":
        node = _require_node(action.get("id"), by_id, id_map)
        node["kind"] = "paper"
        node["paperId"] = validate_paper_id(action.get("paperId"))
    else:
        raise MindmapError("mindmap.unknown_op", op=str(op))


def _require_node(raw_id: Any, by_id: dict[str, dict], id_map: dict[str, str]) -> dict:
    node_id = _resolve_id(raw_id, id_map)
    if node_id not in by_id:
        raise MindmapError("mindmap.node_not_found", id=node_id)
    return by_id[node_id]


def _op_add(doc: dict, action: dict, id_map: dict[str, str]) -> None:
    nodes = doc["nodes"]
    raw_parent = action.get("parentId", None)
    if raw_parent is None:
        parent_id: str | None = None
        if find_root(nodes) is not None:
            raise MindmapError("mindmap.root_exists")
    else:
        parent_id = _resolve_id(raw_parent, id_map)
        if parent_id not in index_nodes(nodes):
            raise MindmapError("mindmap.parent_not_found", id=parent_id)

    by_id = index_nodes(nodes)
    # add_node 的 id 永远是"客户端临时 ID"：正式 ID 一律由服务端生成，
    # 再通过返回的 idMap 回填（AI 工具不传 id；解析器直接构造节点不走动作）。
    raw_id = action.get("id")
    if raw_id is not None and (not isinstance(raw_id, str) or not raw_id):
        raise MindmapError("mindmap.id_required")
    if raw_id is not None and raw_id in id_map:
        raise MindmapError("mindmap.duplicate_temp_id", id=raw_id)
    node_id = new_node_id(set(by_id.keys()))
    if raw_id is not None:
        id_map[raw_id] = node_id

    kind = action.get("kind", "topic")
    if kind not in VALID_KINDS:
        raise MindmapError("mindmap.invalid_kind", id=node_id, kind=str(kind))
    paper_id = action.get("paperId")
    if kind == "paper":
        if not isinstance(paper_id, str) or not paper_id:
            raise MindmapError("mindmap.paper_id_required", id=node_id)
        paper_id = validate_paper_id(paper_id)
    elif paper_id not in (None, ""):
        raise MindmapError("mindmap.topic_has_paper_id", id=node_id)

    text = action.get("text", "")
    if not isinstance(text, str):
        raise MindmapError("mindmap.text_invalid", id=node_id)
    x = _as_coord(action.get("x", 0.0), node_id)
    y = _as_coord(action.get("y", 0.0), node_id)

    siblings = ordered_children(nodes, parent_id)
    order = action.get("order", len(siblings))
    if not isinstance(order, int) or isinstance(order, bool) or not 0 <= order <= len(siblings):
        raise MindmapError("mindmap.order_invalid", id=node_id)

    nodes.append(make_node(node_id, parent_id, order, text,
                           kind=kind, paper_id=paper_id, x=x, y=y))
    normalize_orders(doc)


def _as_coord(value: Any, node_id: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise MindmapError("mindmap.coordinate_invalid", id=node_id)
    return float(value)


def _op_update(node: dict, action: dict) -> None:
    if "text" in action:
        if not isinstance(action["text"], str):
            raise MindmapError("mindmap.text_invalid", id=node["id"])
        node["text"] = action["text"]
    if "kind" in action or "paperId" in action:
        kind = action.get("kind", node["kind"])
        if kind not in VALID_KINDS:
            raise MindmapError("mindmap.invalid_kind", id=node["id"], kind=str(kind))
        paper_id = action.get("paperId", node.get("paperId"))
        if kind == "paper":
            if not isinstance(paper_id, str) or not paper_id:
                raise MindmapError("mindmap.paper_id_required", id=node["id"])
            paper_id = validate_paper_id(paper_id)
        else:
            paper_id = None
        node["kind"] = kind
        node["paperId"] = paper_id
    if "x" in action:
        node["x"] = _as_coord(action["x"], node["id"])
    if "y" in action:
        node["y"] = _as_coord(action["y"], node["id"])
    if "collapsed" in action:
        if not isinstance(action["collapsed"], bool):
            raise MindmapError("mindmap.collapsed_invalid", id=node["id"])
        node["collapsed"] = action["collapsed"]


def _op_move(doc: dict, node: dict, action: dict, id_map: dict[str, str]) -> None:
    if node.get("parentId") is None:
        raise MindmapError("mindmap.root_cannot_move", id=node["id"])
    nodes = doc["nodes"]
    raw_target = action.get("newParentId")
    if raw_target is None:
        raise MindmapError("mindmap.cannot_parent_to_root", id=node["id"])
    target_id = _resolve_id(raw_target, id_map)
    by_id = index_nodes(nodes)
    if target_id not in by_id:
        raise MindmapError("mindmap.parent_not_found", id=target_id)
    if target_id == node["id"]:
        raise MindmapError("mindmap.cannot_parent_to_self", id=node["id"])
    if target_id in descendant_ids(nodes, node["id"]):
        raise MindmapError("mindmap.would_create_cycle", id=node["id"])

    siblings = ordered_children(nodes, target_id)
    if node["parentId"] == target_id:
        siblings = [c for c in siblings if c["id"] != node["id"]]
    order = action.get("newOrder", len(siblings))
    if not isinstance(order, int) or isinstance(order, bool) or not 0 <= order <= len(siblings):
        raise MindmapError("mindmap.order_invalid", id=node["id"])

    node["parentId"] = target_id
    normalize_orders(doc)
    kids = [c for c in ordered_children(nodes, target_id) if c["id"] != node["id"]]
    order = min(order, len(kids))
    kids.insert(order, node)
    for i, child in enumerate(kids):
        child["order"] = i


def _op_delete(doc: dict, node: dict, action: dict) -> None:
    if node.get("parentId") is None:
        raise MindmapError("mindmap.root_cannot_delete", id=node["id"])
    strategy = action.get("strategy", "promote")
    if strategy not in ("promote", "delete_branch"):
        raise MindmapError("mindmap.invalid_delete_strategy", strategy=str(strategy))

    nodes = doc["nodes"]
    parent_id = node["parentId"]
    doomed = set(descendant_ids(nodes, node["id"]))
    if strategy == "promote":
        # 直系子节点提升到被删节点的位置（孙辈关系不变）
        for child in ordered_children(nodes, node["id"]):
            child["parentId"] = parent_id
        to_remove = {node["id"]}
    else:
        to_remove = doomed

    doc["nodes"] = [n for n in nodes if n["id"] not in to_remove]
    normalize_orders(doc)
