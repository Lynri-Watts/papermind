/**
 * 外部结构 → 当前文档的稳定 ID 合入（代码面板「应用」场景）。
 *
 * 真源分工：
 * - ``incoming`` 是**结构真源**：parentId / order / text / kind / paperId 以它为准；
 * - ``current`` 是**折叠态真源**：按稳定 ID 保留 collapsed；
 * - 几何坐标统一归零（mind-elixir 内部管理，MindmapDoc 中 x/y 字段固定为 0）。
 */
import type { MindmapDoc, MindmapNode } from '../../types';
import { indexNodes, normalizeOrders, validateDoc } from './model';

export function mergeDoc(current: MindmapDoc, incoming: MindmapDoc): MindmapDoc {
  const currentById = indexNodes(current.nodes);

  const merged: MindmapNode[] = incoming.nodes.map((n) => {
    const old = currentById.get(n.id);
    if (!old) {
      // 新节点：几何坐标归零（mind-elixir 内部管理）
      return { ...n, x: 0, y: 0, collapsed: n.collapsed === true };
    }
    return {
      ...n,
      // 几何坐标统一归零
      x: 0,
      y: 0,
      // 折叠态以当前画布为准（用户可能折叠了）
      collapsed: old.collapsed !== undefined ? old.collapsed : (n.collapsed ?? false),
    };
  });

  const doc: MindmapDoc = { nodes: merged };
  normalizeOrders(doc);
  validateDoc(doc);
  return doc;
}
