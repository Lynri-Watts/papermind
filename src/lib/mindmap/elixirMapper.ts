/**
 * MindmapDoc（扁平 nodes[] + parentId） ↔ MindElixirData（嵌套 NodeObj 树） 转换器。
 *
 * - MindElixir NodeObj 的 `metadata` 泛型承载自定义字段：`{ kind: 'topic' | 'paper', paperId?: string }`
 * - `expanded === false` 对应 MindmapDoc 节点的 `collapsed === true`（expanded 默认 true，省略即展开）
 * - NodeObj.parent 是运行时自动注入的，序列化/反序列化时都手动清空
 * - 根节点 `id === root_node_data.id` 且无 parent，MindElixir 会自动识别
 *
 * 后端 ``backend/services/mindmap_elixir.py`` 必须保持逻辑一致。
 */
import type { MindmapDoc, MindmapNode } from '../../types';

/** MindElixir 自定义 metadata（塞进 NodeObj.metadata 泛型）。 */
export interface MindElixirMeta {
  /** 'topic' | 'paper'；paper 节点在前端渲染时显示 paper 元信息 chip */
  kind: 'topic' | 'paper';
  paperId?: string;
}

/** mind-elixir NodeObj（metadata 固定为我们的自定义结构）。 */
export interface MindElixirNodeObj {
  id: string;
  topic: string;
  children?: MindElixirNodeObj[];
  expanded?: boolean;
  direction?: 0 | 1;
  style?: Record<string, string>;
  tags?: (string | { text: string })[];
  metadata?: MindElixirMeta;
  /** 运行时注入，序列化/反序列化时都忽略 */
  parent?: MindElixirNodeObj;
}

export interface MindElixirData {
  nodeData: MindElixirNodeObj;
  arrows?: any[];
  summaries?: any[];
  /** 0=LEFT, 1=RIGHT, 2=SIDE, 3=DOWN（与 mind-elixir 静态常量一致） */
  direction?: 0 | 1 | 2 | 3;
  compact?: boolean;
  meta?: Record<string, unknown>;
}

// ---------- MindmapDoc → MindElixirData ----------

export function docToElixir(doc: MindmapDoc): MindElixirData {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const root = doc.nodes.find((n) => n.parentId === null);
  if (!root) throw new Error('mindmap.root_missing');

  const build = (node: MindmapNode): MindElixirNodeObj => {
    const kind = node.kind ?? 'topic';
    const childNodes = doc.nodes.filter((n) => n.parentId === node.id);
    const elixirNode: MindElixirNodeObj = {
      id: node.id,
      topic: node.text ?? '',
      metadata: { kind, paperId: node.paperId ?? undefined },
    };
    if (node.collapsed) elixirNode.expanded = false;
    if (childNodes.length > 0) elixirNode.children = childNodes.map(build);
    return elixirNode;
  };

  return {
    nodeData: build(root),
    direction: 2,
    compact: false,
    meta: { converter: 'papermind' },
  };
}

// ---------- MindElixirData → MindmapDoc ----------

let _orderCounter = 0;

export function elixirToDoc(data: MindElixirData): MindmapDoc {
  _orderCounter = 0;
  const nodes: MindmapDoc['nodes'] = [];

  const walk = (elixirNode: MindElixirNodeObj, parentId: string | null): string => {
    const order = _orderCounter++;
    const { id, topic, children, expanded, metadata } = elixirNode;
    const kind = metadata?.kind ?? 'topic';
    const node: MindmapNode = {
      id,
      parentId,
      order,
      text: topic ?? '',
      kind,
      collapsed: expanded === false,
      paperId: metadata?.paperId ?? null,
      x: 0,  // 几何坐标由 mind-elixir 内部管理，不再用，但类型必填保留
      y: 0,
    };
    nodes.push(node);
    if (children && children.length > 0) {
      for (const child of children) walk(child, id);
    }
    return id;
  };

  walk(data.nodeData, null);
  return { nodes };
}
