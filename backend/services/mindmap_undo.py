"""AI 编辑事务的逆向恢复（服务端）。

不是简单地把整个导图回滚到事务前快照——那会丢掉用户在事务**期间与之后**
对手动结构的编辑。策略是基于三个快照做**字段级逆向**：

- ``pre``：事务开始前一版的文档快照；
- ``end``：事务最后一版的文档快照；
- ``current``：导图当前最新文档（撤销起点）。

推导并逆向：

1. 事务新增节点（end 有、pre 无）：从 current 移除；若其下已挂有非事务
   产生的后代，则把这些后代提升到最近的非事务祖先（而非整枝删除）；
2. 事务删除节点（pre 有、end 无）：按 pre 快照原样重建（含坐标/类型），
   原父节点已不存在时挂到根下；current 中已被用户用同 ID 重建的跳过；
3. 事务改动字段（两快照共有节点但 tracked 字段不同）：仅当 current 中
   该字段仍等于 end 值（用户没有再动过）才恢复为 pre 值，否则逐项跳过；
   父节点恢复还要额外做不成环检查。

调用方负责快照的获取与持久化；本模块为纯函数，输出经树不变量校验。
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from .mindmap_doc import (
    MindmapError,
    descendant_ids,
    index_nodes,
    normalize_orders,
    ordered_children,
    validate_doc,
)

#: 参与"事务是否动过"比较的字段（ID/父子归属外的可恢复属性）
TRACKED_FIELDS = ("text", "kind", "paperId", "x", "y", "collapsed", "parentId", "order")
_PARENT_FIELDS = ("parentId", "order")


def _by_id(doc: dict) -> dict[str, dict]:
    return index_nodes(doc["nodes"])


def _snapshot(node: dict | None, field: str) -> Any:
    if node is None:
        return None
    return node.get(field)


def revert_transaction(current: dict, pre: dict, end: dict) -> tuple[dict, dict]:
    """把 ``end`` 相对 ``pre`` 的变化从 ``current`` 中逆向掉。

    返回 (新文档, 统计 {removed, restored, fields_restored, fields_skipped})。
    """
    for name, doc in (("pre", pre), ("end", end), ("current", current)):
        try:
            validate_doc(doc)
        except MindmapError as exc:
            raise MindmapError("mindmap.doc_malformed") from exc

    work = deepcopy(current)
    pre_nodes = _by_id(pre)
    end_nodes = _by_id(end)
    cur_nodes = _by_id(work)

    pre_ids = set(pre_nodes)
    end_ids = set(end_nodes)
    cur_ids = set(cur_nodes)

    added = end_ids - pre_ids            # 事务新增（且事务结束时仍在）
    deleted = pre_ids - end_ids          # 事务删除
    stats = {"removed": 0, "restored": 0, "fields_restored": 0, "fields_skipped": 0}

    # 1) 恢复被事务删除的节点（按 pre 的先序，保证父先于子）
    pre_order: list[str] = []
    root = next(n for n in pre["nodes"] if n.get("parentId") is None)

    def collect(nid: str) -> None:
        pre_order.append(nid)
        for ch in ordered_children(pre["nodes"], nid):
            collect(ch["id"])

    collect(root["id"])
    live = _by_id(work)
    for nid in pre_order:
        if nid not in deleted or nid in live:
            continue  # 非事务删除节点，或用户已用同 ID 重建
        src = pre_nodes[nid]
        parent_id = src.get("parentId")
        if parent_id not in live:
            # 原父也没了（被用户删除/本就未恢复）→ 挂根
            root_now = next(n for n in work["nodes"] if n.get("parentId") is None)
            parent_id = root_now["id"]
        clone = deepcopy(src)
        clone["parentId"] = parent_id
        work["nodes"].append(clone)
        live[nid] = clone
        stats["restored"] += 1
    normalize_orders(work)

    # 2) 恢复被事务修改的字段（结构字段最后处理）
    common = pre_ids & end_ids
    touched = [nid for nid in common
               if any(pre_nodes[nid].get(f) != end_nodes[nid].get(f) for f in TRACKED_FIELDS)]
    structural_restore: list[str] = []
    live = _by_id(work)
    for nid in touched:
        node = live.get(nid)
        if node is None:
            continue  # 用户后来删了它
        for field in TRACKED_FIELDS:
            old_val = pre_nodes[nid].get(field)
            ai_val = end_nodes[nid].get(field)
            if old_val == ai_val:
                continue
            if field in _PARENT_FIELDS:
                structural_restore.append(nid)  # 去重在下方处理
                continue
            if node.get(field) == ai_val:
                node[field] = old_val
                stats["fields_restored"] += 1
            else:
                stats["fields_skipped"] += 1

    # 2b) 父归属/顺序：仅在目标父存在且不成环时恢复
    for nid in dict.fromkeys(structural_restore):
        node = live.get(nid)
        if node is None:
            continue
        old_parent = pre_nodes[nid].get("parentId")
        ai_parent = end_nodes[nid].get("parentId")
        if old_parent == ai_parent:
            # 仅 order 变化：父相同则直接恢复顺序资格
            if node.get("parentId") == old_parent and node.get("order") == end_nodes[nid].get("order"):
                node["order"] = pre_nodes[nid].get("order", 0)
                stats["fields_restored"] += 1
            else:
                stats["fields_skipped"] += 1
            continue
        if node.get("parentId") != ai_parent:
            stats["fields_skipped"] += 2  # 用户已改父：父与序都保留
            continue
        if old_parent not in live:
            stats["fields_skipped"] += 2
            continue
        # 成环检查：目标父不能是当前节点的后代
        if old_parent in set(descendant_ids(work["nodes"], nid)):
            stats["fields_skipped"] += 2
            continue
        node["parentId"] = old_parent
        node["order"] = pre_nodes[nid].get("order", 0)
        stats["fields_restored"] += 2
    normalize_orders(work)

    # 3) 移除事务新增节点；非事务后代提升到最近的存活祖先
    live = _by_id(work)
    remove = {nid for nid in added if nid in live}
    for node in work["nodes"]:
        if node["id"] in remove:
            continue
        pid = node.get("parentId")
        if pid in remove:
            nearest = pid
            while nearest in remove:
                up = live[nearest].get("parentId")
                if up is None:
                    break
                nearest = up
            node["parentId"] = nearest if nearest not in remove else None
    # 根不允许被删：若意外出现 parentId=None 的被删节点（事务建图极端情况），
    # 它的非事务后代已上提；被删集合本身直接移除
    work["nodes"] = [n for n in work["nodes"] if n["id"] not in remove]
    stats["removed"] = len(remove)

    normalize_orders(work)
    validate_doc(work)
    return work, stats
