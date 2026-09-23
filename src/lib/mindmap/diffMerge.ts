/**
 * 外部结构 → 当前文档的稳定 ID 合入（代码面板「应用」/ 外部 mermaid 导入后增量更新）。
 *
 * 真源分工（FR-3.3）：
 * - ``incoming`` 是**结构真源**：parentId / order / text / kind / paperId 以它为准；
 * - ``current`` 是**几何真源**：按稳定 ID 保留 x / y / collapsed；
 * - incoming 新节点：丢弃解析器线性占位坐标，置 (0,0) 后交 layoutMissing 补位；
 * - current 独有节点（incoming 已删除）：移除；
 * - 不做全图重排：已有坐标的保留节点一律不动；未布局过的保留节点（0,0）才补位。
 *
 * AI 实时编辑不走本函数（走 actions 增量应用）；本函数服务「整段文本 → 文档」场景。
 */
import type { MindmapDoc, MindmapNode } from '../../types';
import { indexNodes, normalizeOrders, validateDoc } from './model';
import { applyMissingLayout } from './layout';

export function mergeDoc(current: MindmapDoc, incoming: MindmapDoc): MindmapDoc {
  const currentById = indexNodes(current.nodes);

  const merged: MindmapNode[] = incoming.nodes.map((n) => {
    const old = currentById.get(n.id);
    if (!old) {
      // 新节点：坐标归零，布局引擎按全树理想位置给它补位（不挪动任何已有节点）
      return { ...n, x: 0, y: 0, collapsed: n.collapsed === true };
    }
    return {
      ...n,
      // 几何与折叠态永远以用户画布为准
      x: old.x,
      y: old.y,
      collapsed: old.collapsed !== undefined ? old.collapsed : (n.collapsed ?? false),
    };
  });

  const doc: MindmapDoc = { nodes: merged };
  normalizeOrders(doc);
  validateDoc(doc);
  // 新节点（以及双方都未布局过的节点）获得 tidy 坐标；手动坐标不受影响
  return applyMissingLayout(doc);
}
