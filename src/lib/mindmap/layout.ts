/**
 * 水平向右的 tidy-tree 布局（自研，不引 dagre/elkjs）。
 *
 * 算法：「叶子在轨」(leaves-on-rails) —— 可见叶子按视觉先序依次占据整数行，
 * 父节点纵向居中于其叶子行带 [minRow, maxRow]，x = 深度 * hGap。
 * 相邻子树的叶子行带互不相交，因此**子树永不重叠**（无需轮廓补偿迭代，
 * O(n) 且确定性）；折叠节点当作叶子，其后代不参与布局。
 *
 * 几何语义（FR-3.3）：
 * - 只有 x===0 && y===0 的「无坐标节点」才会被自动布局补位；
 * - 已有坐标的节点（用户拖拽 / 上一轮布局结果）绝不移动，禁止全图重排；
 * - 工具栏「重新布局」显式对全图重排（applyFullLayout），是用户主动行为。
 */
import type { MindmapDoc, MindmapNode } from '../../types';
import { LEVEL_X, ROW_Y } from './mmdParser';
import { MindmapError, descendantIds, findRoot, orderedChildren } from './model';

export interface MindmapLayoutOptions {
  /** 层级水平间距（默认与后端线性占位一致 240） */
  hGap?: number;
  /** 叶子行垂直间距（默认 72） */
  vGap?: number;
  /** true（默认）时 collapsed 节点视为叶子，其后代从布局中排除 */
  honorCollapsed?: boolean;
}

export interface LayoutPoint {
  x: number;
  y: number;
}

/** 计算全树（可见部分）的理想坐标，返回 id → 坐标。折叠掉的后代不在结果中。 */
export function layoutTree(
  nodes: MindmapNode[],
  opts: MindmapLayoutOptions = {}
): Map<string, LayoutPoint> {
  const hGap = opts.hGap ?? LEVEL_X;
  const vGap = opts.vGap ?? ROW_Y;
  const honorCollapsed = opts.honorCollapsed ?? true;

  const root = findRoot(nodes);
  if (!root) throw new MindmapError('mindmap.root_missing');

  // 折叠分支的后代（不含折叠节点自身）对布局不可见
  const hidden = new Set<string>();
  if (honorCollapsed) {
    for (const n of nodes) {
      if (n.collapsed === true) {
        const family = descendantIds(nodes, n.id);
        for (const id of family) if (id !== n.id) hidden.add(id);
      }
    }
  }
  const visibleKids = (parentId: string | null): MindmapNode[] =>
    orderedChildren(nodes, parentId).filter((c) => !hidden.has(c.id));

  let nextRow = 0;
  const positions = new Map<string, LayoutPoint>();

  const place = (node: MindmapNode, depth: number): { min: number; max: number } => {
    const kids = visibleKids(node.id);
    if (kids.length === 0) {
      const row = nextRow++;
      positions.set(node.id, { x: depth * hGap, y: row * vGap });
      return { min: row, max: row };
    }
    let minRow = 0;
    let maxRow = 0;
    kids.forEach((kid, i) => {
      const band = place(kid, depth + 1);
      if (i === 0) minRow = band.min;
      maxRow = band.max;
    });
    positions.set(node.id, { x: depth * hGap, y: ((minRow + maxRow) / 2) * vGap });
    return { min: minRow, max: maxRow };
  };

  place(root, 0);
  return positions;
}

/**
 * 仅为无坐标节点（x===0 && y===0）补布局坐标；已布局/手动节点保持不动。
 * 折叠隐藏的无坐标节点跳过（不可见，展开后下一轮再补）。
 */
export function layoutMissing(
  nodes: MindmapNode[],
  opts: MindmapLayoutOptions = {}
): Map<string, LayoutPoint> {
  const full = layoutTree(nodes, opts);
  const out = new Map<string, LayoutPoint>();
  for (const n of nodes) {
    if (n.x === 0 && n.y === 0) {
      const p = full.get(n.id);
      if (p) out.set(n.id, p);
    }
  }
  return out;
}

/** 返回新文档：无坐标节点补位，其余不动（导入/AI diff/新建节点后的主入口）。 */
export function applyMissingLayout(
  doc: MindmapDoc,
  opts: MindmapLayoutOptions = {}
): MindmapDoc {
  const missing = layoutMissing(doc.nodes, opts);
  if (missing.size === 0) return doc;
  return {
    nodes: doc.nodes.map((n) => {
      const p = missing.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }),
  };
}

/** 全图重新布局（用户显式触发）：折叠分支外的每个节点都采用理想坐标。 */
export function applyFullLayout(
  doc: MindmapDoc,
  opts: MindmapLayoutOptions = {}
): MindmapDoc {
  const positions = layoutTree(doc.nodes, opts);
  return {
    nodes: doc.nodes.map((n) => {
      const p = positions.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }),
  };
}
