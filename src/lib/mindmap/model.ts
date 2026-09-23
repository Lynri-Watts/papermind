/**
 * 思维导图文档内核（前端一份）：节点树模型、不变量校验、动作批量应用。
 *
 * 与后端 ``backend/services/mindmap_doc.py`` 语义逐行对齐（改一边必须同步另一边）：
 * - 动作在深拷贝上顺序应用，任一非法即整体拒绝（原文档不变，无半截写入）；
 * - add_node 的 id 永远是客户端临时 ID，正式 ID 一律由应用方生成并通过 idMap 回填；
 * - 错误携带 i18n 键（``mindmap.xxx``，后端 locales/mindmap.py 有同款键）与行号等参数。
 *
 * 服务端是最终权威；本地应用用于画布乐观更新与 AI diff 的即时落图，
 * 提交响应用于临时/正式 ID 对账（见 remapIds）。
 */
import type {
  MindmapDoc,
  MindmapNode,
  MindmapNodeKind,
  MindmapAction,
  MindmapDeleteStrategy,
} from '../../types';

/** paperId 必须形如 "source:external_id"（含 local:<...>），与后端 PAPER_ID_RE 一致。 */
const PAPER_ID_RE = /^[A-Za-z0-9_.\-]+:[^\s]+$/;
const VALID_KINDS: MindmapNodeKind[] = ['topic', 'paper'];

/** 结构化导图错误：携带 i18n 键与插值参数（对齐后端 MindmapError）。 */
export class MindmapError extends Error {
  key: string;
  params: Record<string, unknown>;
  /** 动作批次中的序号（0-based）；路由/UI 展示时 +1。null=非批次错误。 */
  actionIndex: number | null;

  constructor(key: string, params: Record<string, unknown> = {}) {
    super(key);
    this.name = 'MindmapError';
    this.key = key;
    this.params = params;
    this.actionIndex = null;
  }

  withIndex(index: number): this {
    this.actionIndex = index;
    return this;
  }
}

// ---------- 基础构造 ----------
/** 生成 n_<8 位十六进制>；极小概率碰撞时重试。浏览器/Node 均可用全局 crypto。 */
export function newNodeId(existing: Set<string> = new Set()): string {
  for (let i = 0; i < 10; i++) {
    const buf = new Uint8Array(4);
    globalThis.crypto.getRandomValues(buf);
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    const candidate = `n_${hex}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new MindmapError('mindmap.id_generate_failed');
}

export interface MakeNodeOptions {
  kind?: MindmapNodeKind;
  paperId?: string | null;
  x?: number;
  y?: number;
  collapsed?: boolean;
}

export function makeNode(
  id: string,
  parentId: string | null,
  order: number,
  text = '',
  opts: MakeNodeOptions = {}
): MindmapNode {
  return {
    id,
    parentId,
    order,
    text,
    kind: opts.kind ?? 'topic',
    paperId: opts.paperId ?? null,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    collapsed: opts.collapsed ?? false,
  };
}

/** 构造仅含一个根节点的新文档。 */
export function newDoc(rootText = '', rootId?: string): MindmapDoc {
  const rid = rootId ?? newNodeId();
  return { nodes: [makeNode(rid, null, 0, rootText)] };
}

// ---------- 查询辅助 ----------
export function findRoot(nodes: MindmapNode[]): MindmapNode | undefined {
  return nodes.find((n) => n.parentId === null);
}

export function indexNodes(nodes: MindmapNode[]): Map<string, MindmapNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** 同一父节点下的子节点，按 (order, id) 稳定排序（id 仅含 ASCII，排序结果与 Python 一致）。 */
export function orderedChildren(
  nodes: MindmapNode[],
  parentId: string | null
): MindmapNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .slice()
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 返回节点全部后代 ID（含自身），按先序。 */
export function descendantIds(nodes: MindmapNode[], nodeId: string): string[] {
  const byParent = new Map<string | null, string[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n.id);
    byParent.set(n.parentId, list);
  }
  const result: string[] = [];
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop() as string;
    result.push(cur);
    const kids = (byParent.get(cur) ?? []).slice().sort().reverse();
    for (const child of kids) stack.push(child);
  }
  return result;
}

export function validatePaperId(paperId: unknown): string {
  if (typeof paperId !== 'string' || !PAPER_ID_RE.test(paperId)) {
    throw new MindmapError('mindmap.invalid_paper_id', { paper_id: String(paperId) });
  }
  return paperId;
}

// ---------- 不变量 ----------
/** 校验整棵树的不变量；非法抛 MindmapError。 */
export function validateDoc(doc: unknown): asserts doc is MindmapDoc {
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as MindmapDoc).nodes)) {
    throw new MindmapError('mindmap.doc_malformed');
  }
  const nodes = (doc as MindmapDoc).nodes;
  if (nodes.length === 0) throw new MindmapError('mindmap.empty_doc');

  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id) {
      throw new MindmapError('mindmap.id_required');
    }
    if (seen.has(n.id)) throw new MindmapError('mindmap.duplicate_id', { id: n.id });
    seen.add(n.id);
  }

  const roots = nodes.filter((n) => n.parentId === null);
  if (roots.length === 0) throw new MindmapError('mindmap.root_missing');
  if (roots.length > 1) {
    throw new MindmapError('mindmap.multiple_roots', {
      ids: roots.map((n) => n.id).join(', '),
    });
  }

  const byId = indexNodes(nodes);
  for (const n of nodes) {
    if (n.parentId !== null && !byId.has(n.parentId)) {
      throw new MindmapError('mindmap.dangling_parent', { id: n.id, parent: n.parentId });
    }
    if (!VALID_KINDS.includes(n.kind)) {
      throw new MindmapError('mindmap.invalid_kind', { id: n.id, kind: String(n.kind) });
    }
    if (n.kind === 'paper') {
      if (typeof n.paperId !== 'string' || !n.paperId) {
        throw new MindmapError('mindmap.paper_id_required', { id: n.id });
      }
      validatePaperId(n.paperId);
    } else if (n.paperId !== null && n.paperId !== undefined && n.paperId !== '') {
      throw new MindmapError('mindmap.topic_has_paper_id', { id: n.id });
    }
    if (typeof n.order !== 'number' || !Number.isInteger(n.order) || n.order < 0) {
      throw new MindmapError('mindmap.order_invalid', { id: n.id });
    }
    for (const coord of ['x', 'y'] as const) {
      const v = n[coord];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new MindmapError('mindmap.coordinate_invalid', { id: n.id });
      }
    }
    if (n.collapsed !== undefined && typeof n.collapsed !== 'boolean') {
      throw new MindmapError('mindmap.collapsed_invalid', { id: n.id });
    }
  }

  // 同级 order 唯一性（不要求连续——规范化在动作/边界层做）
  const byParent = new Map<string | null, MindmapNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const siblings of byParent.values()) {
    const orders = siblings.map((n) => n.order);
    if (new Set(orders).size !== orders.length) {
      throw new MindmapError('mindmap.sibling_order_conflict');
    }
  }

  // 无环：沿父链上溯，重复即环
  for (const n of nodes) {
    const walked = new Set<string>();
    let cur: MindmapNode | undefined = n;
    while (cur && cur.parentId !== null) {
      if (walked.has(cur.id)) {
        throw new MindmapError('mindmap.cycle_detected', { id: cur.id });
      }
      walked.add(cur.id);
      cur = byId.get(cur.parentId ?? '');
    }
  }
}

/** 把每个父节点下的 order 按 (order, id) 重排为 0..n-1（原地）。 */
export function normalizeOrders(doc: MindmapDoc): MindmapDoc {
  const parents = new Set<string | null>([null]);
  for (const n of doc.nodes) parents.add(n.parentId);
  for (const pid of parents) {
    orderedChildren(doc.nodes, pid).forEach((child, i) => {
      child.order = i;
    });
  }
  return doc;
}

// ---------- 动作 ----------
type RawAction = MindmapAction & Record<string, unknown>;

function resolveId(value: unknown, idMap: Record<string, string>): string {
  if (typeof value !== 'string' || !value) throw new MindmapError('mindmap.id_required');
  return idMap[value] ?? value;
}

function requireNode(
  rawId: unknown,
  byId: Map<string, MindmapNode>,
  idMap: Record<string, string>
): MindmapNode {
  const nodeId = resolveId(rawId, idMap);
  const node = byId.get(nodeId);
  if (!node) throw new MindmapError('mindmap.node_not_found', { id: nodeId });
  return node;
}

function asCoord(value: unknown, nodeId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MindmapError('mindmap.coordinate_invalid', { id: nodeId });
  }
  return value;
}

function opAdd(
  doc: MindmapDoc,
  action: RawAction,
  idMap: Record<string, string>
): void {
  const nodes = doc.nodes;
  let parentId: string | null;
  const rawParent = action.parentId ?? null;
  if (rawParent === null || rawParent === undefined) {
    parentId = null;
    if (findRoot(nodes)) throw new MindmapError('mindmap.root_exists');
  } else {
    parentId = resolveId(rawParent, idMap);
    if (!indexNodes(nodes).has(parentId)) {
      throw new MindmapError('mindmap.parent_not_found', { id: parentId });
    }
  }

  // add_node 的 id 永远是客户端临时 ID：正式 ID 一律由应用方生成，再经 idMap 回填。
  const rawId = action.id;
  if (rawId !== undefined && (typeof rawId !== 'string' || !rawId)) {
    throw new MindmapError('mindmap.id_required');
  }
  if (rawId !== undefined && Object.prototype.hasOwnProperty.call(idMap, rawId)) {
    throw new MindmapError('mindmap.duplicate_temp_id', { id: rawId });
  }
  const nodeId = newNodeId(new Set(indexNodes(nodes).keys()));
  if (rawId !== undefined) idMap[rawId] = nodeId;

  const kind: MindmapNodeKind = (action.kind as MindmapNodeKind) ?? 'topic';
  if (!VALID_KINDS.includes(kind)) {
    throw new MindmapError('mindmap.invalid_kind', { id: nodeId, kind: String(kind) });
  }
  const rawPaperId = action.paperId ?? null;
  let paperId: string | null = null;
  if (kind === 'paper') {
    if (typeof rawPaperId !== 'string' || !rawPaperId) {
      throw new MindmapError('mindmap.paper_id_required', { id: nodeId });
    }
    paperId = validatePaperId(rawPaperId);
  } else if (rawPaperId !== null && rawPaperId !== '') {
    throw new MindmapError('mindmap.topic_has_paper_id', { id: nodeId });
  }

  const text = action.text ?? '';
  if (typeof text !== 'string') {
    throw new MindmapError('mindmap.text_invalid', { id: nodeId });
  }
  const x = asCoord(action.x ?? 0, nodeId);
  const y = asCoord(action.y ?? 0, nodeId);

  const siblings = orderedChildren(nodes, parentId);
  const order = action.order ?? siblings.length;
  if (
    typeof order !== 'number' ||
    !Number.isInteger(order) ||
    order < 0 ||
    order > siblings.length
  ) {
    throw new MindmapError('mindmap.order_invalid', { id: nodeId });
  }

  nodes.push(makeNode(nodeId, parentId, order, text, { kind, paperId, x, y }));
  normalizeOrders(doc);
}

function opUpdate(node: MindmapNode, action: RawAction): void {
  if (Object.prototype.hasOwnProperty.call(action, 'text')) {
    if (typeof action.text !== 'string') {
      throw new MindmapError('mindmap.text_invalid', { id: node.id });
    }
    node.text = action.text;
  }
  if (
    Object.prototype.hasOwnProperty.call(action, 'kind') ||
    Object.prototype.hasOwnProperty.call(action, 'paperId')
  ) {
    const kind = (action.kind as MindmapNodeKind) ?? node.kind;
    if (!VALID_KINDS.includes(kind)) {
      throw new MindmapError('mindmap.invalid_kind', { id: node.id, kind: String(kind) });
    }
    let paperId: string | null = action.paperId !== undefined
      ? (action.paperId as string | null)
      : node.paperId;
    if (kind === 'paper') {
      if (typeof paperId !== 'string' || !paperId) {
        throw new MindmapError('mindmap.paper_id_required', { id: node.id });
      }
      paperId = validatePaperId(paperId);
    } else {
      paperId = null;
    }
    node.kind = kind;
    node.paperId = paperId;
  }
  if (Object.prototype.hasOwnProperty.call(action, 'x')) {
    node.x = asCoord(action.x, node.id);
  }
  if (Object.prototype.hasOwnProperty.call(action, 'y')) {
    node.y = asCoord(action.y, node.id);
  }
  if (Object.prototype.hasOwnProperty.call(action, 'collapsed')) {
    if (typeof action.collapsed !== 'boolean') {
      throw new MindmapError('mindmap.collapsed_invalid', { id: node.id });
    }
    node.collapsed = action.collapsed;
  }
}

function opMove(
  doc: MindmapDoc,
  node: MindmapNode,
  action: RawAction,
  idMap: Record<string, string>
): void {
  if (node.parentId === null) {
    throw new MindmapError('mindmap.root_cannot_move', { id: node.id });
  }
  const nodes = doc.nodes;
  const rawTarget = action.newParentId;
  if (rawTarget === null || rawTarget === undefined) {
    throw new MindmapError('mindmap.cannot_parent_to_root', { id: node.id });
  }
  const targetId = resolveId(rawTarget, idMap);
  const byId = indexNodes(nodes);
  if (!byId.has(targetId)) {
    throw new MindmapError('mindmap.parent_not_found', { id: targetId });
  }
  if (targetId === node.id) {
    throw new MindmapError('mindmap.cannot_parent_to_self', { id: node.id });
  }
  if (descendantIds(nodes, node.id).includes(targetId)) {
    throw new MindmapError('mindmap.would_create_cycle', { id: node.id });
  }

  let siblings = orderedChildren(nodes, targetId);
  if (node.parentId === targetId) {
    siblings = siblings.filter((c) => c.id !== node.id);
  }
  const order = action.newOrder ?? siblings.length;
  if (
    typeof order !== 'number' ||
    !Number.isInteger(order) ||
    order < 0 ||
    order > siblings.length
  ) {
    throw new MindmapError('mindmap.order_invalid', { id: node.id });
  }

  node.parentId = targetId;
  normalizeOrders(doc);
  const kids = orderedChildren(nodes, targetId).filter((c) => c.id !== node.id);
  const finalOrder = Math.min(order, kids.length);
  kids.splice(finalOrder, 0, node);
  kids.forEach((child, i) => {
    child.order = i;
  });
}

function opDelete(doc: MindmapDoc, node: MindmapNode, action: RawAction): void {
  if (node.parentId === null) {
    throw new MindmapError('mindmap.root_cannot_delete', { id: node.id });
  }
  const strategy = (action.strategy as MindmapDeleteStrategy | undefined) ?? 'promote';
  if (strategy !== 'promote' && strategy !== 'delete_branch') {
    throw new MindmapError('mindmap.invalid_delete_strategy', { strategy: String(strategy) });
  }

  const nodes = doc.nodes;
  const parentId = node.parentId;
  const doomed = new Set(descendant_ids(nodes, node.id));
  let toRemove: Set<string>;
  if (strategy === 'promote') {
    // 直系子节点提升到被删节点的位置（孙辈关系不变）
    for (const child of orderedChildren(nodes, node.id)) {
      child.parentId = parentId;
    }
    toRemove = new Set([node.id]);
  } else {
    toRemove = doomed;
  }
  doc.nodes = nodes.filter((n) => !toRemove.has(n.id));
  normalizeOrders(doc);
}

/** apply_actions 的本地名（保留后端 snake 语义，避免调用方心智负担）。 */
function descendant_ids(nodes: MindmapNode[], nodeId: string): string[] {
  return descendantIds(nodes, nodeId);
}

function applyOne(
  doc: MindmapDoc,
  action: RawAction,
  idMap: Record<string, string>
): void {
  const byId = indexNodes(doc.nodes);
  switch (action.op) {
    case 'add_node':
      opAdd(doc, action, idMap);
      break;
    case 'update_node':
      opUpdate(requireNode(action.id, byId, idMap), action);
      break;
    case 'move_node':
      opMove(doc, requireNode(action.id, byId, idMap), action, idMap);
      break;
    case 'delete_node':
      opDelete(doc, requireNode(action.id, byId, idMap), action);
      break;
    case 'set_collapsed': {
      const node = requireNode(action.id, byId, idMap);
      if (typeof action.collapsed !== 'boolean') {
        throw new MindmapError('mindmap.collapsed_invalid', { id: node.id });
      }
      node.collapsed = action.collapsed;
      break;
    }
    case 'attach_paper': {
      const node = requireNode(action.id, byId, idMap);
      node.kind = 'paper';
      node.paperId = validatePaperId(action.paperId);
      break;
    }
    default:
      throw new MindmapError('mindmap.unknown_op', { op: String((action as { op?: unknown }).op) });
  }
}

/**
 * 对文档顺序应用一批动作：
 * - 输入文档不被修改（结构化克隆）；
 * - 任一动作非法即抛带 actionIndex 的 MindmapError（无半截写入）；
 * - 返回新文档与 idMap（临时 ID → 本地生成的正式 ID）。
 */
export function applyActions(
  doc: MindmapDoc,
  actions: MindmapAction[]
): { doc: MindmapDoc; idMap: Record<string, string> } {
  if (!Array.isArray(actions)) throw new MindmapError('mindmap.actions_not_list');
  const work = structuredClone(doc) as MindmapDoc;
  const idMap: Record<string, string> = {};
  actions.forEach((action, index) => {
    if (!action || typeof action !== 'object') {
      throw new MindmapError('mindmap.action_malformed').withIndex(index);
    }
    try {
      applyOne(work, action as RawAction, idMap);
    } catch (exc) {
      if (exc instanceof MindmapError) throw exc.withIndex(index);
      throw exc;
    }
  });
  normalizeOrders(work);
  validateDoc(work);
  return { doc: work, idMap };
}

/**
 * 用服务端 idMap 把本地文档里的临时/本地正式 ID 全部替换为服务端正式 ID。
 * parentId 为 null 保持不变。提交 /actions 成功后对账用。
 */
export function remapIds(doc: MindmapDoc, idMap: Record<string, string>): MindmapDoc {
  const mapId = (id: string): string => idMap[id] ?? id;
  return {
    nodes: doc.nodes.map((n) => ({
      ...n,
      id: mapId(n.id),
      parentId: n.parentId === null ? null : mapId(n.parentId),
    })),
  };
}

/**
 * 把一批动作里出现的节点 ID（id / parentId / newParentId）按映射表改写。
 * 提交成功后对仍在队列中的后续批次做临时/本地 ID → 服务端 ID 对账。
 * parentId 为 null 保持不变。
 */
export function translateActionIds(
  actions: MindmapAction[],
  idMap: Record<string, string>
): MindmapAction[] {
  const mapId = (id: string): string => idMap[id] ?? id;
  return actions.map((raw) => {
    const action = structuredClone(raw) as MindmapAction;
    switch (action.op) {
      case 'add_node':
        if (action.id !== undefined) action.id = mapId(action.id);
        action.parentId = action.parentId === null ? null : mapId(action.parentId);
        break;
      case 'update_node':
      case 'delete_node':
      case 'set_collapsed':
      case 'attach_paper':
        action.id = mapId(action.id);
        break;
      case 'move_node':
        action.id = mapId(action.id);
        action.newParentId = mapId(action.newParentId);
        break;
    }
    return action;
  });
}

/**
 * 计算两个**同根**文档快照之间的最小合法动作批次（from → to）。
 *
 * 本地 undo/redo、mermaid 代码面板「应用」、全图重排都通过本函数把"目标文档状态"
 * 翻译成服务端已有的 6 个动作，复用乐观更新 + /actions 管线，无需文档替换端点。
 *
 * 分阶段（每阶段后在本地模拟文档上校验，保证批次顺序合法）：
 * 1. 新增：先序 add_node（to 的 ID 作批内临时 ID，父先于子）；
 * 2. 移动：所有 parentId 变化的公共节点——删除导致的"孩子上提"也表现为显式 move，
 *    因此删除永远可以退化为 delete_branch（存活后代此前已全部移出子树）；
 * 3. 删除：仅删"顶层被删节点"（其父不在被删集合），整支删除；
 * 4. 排序：逐父节点按 to 顺序做同父 move_node 校正；
 * 5. 字段：text / kind+paperId / x,y / collapsed 差异的 update_node。
 *
 * 根身份不同（代码整段替换改变了根路径 ID）时，先把 to 的根 ID 改写为 from 根 ID，
 * 使根替换表现为根字段更新而不是"删根+加根"（两者都会被内核拒绝）。
 */
export function diffDocs(from: MindmapDoc, to: MindmapDoc): MindmapAction[] {
  let target = to;
  const fromRoot = findRoot(from.nodes);
  const toRoot = findRoot(target.nodes);
  if (!fromRoot || !toRoot) throw new MindmapError('mindmap.empty_doc');
  if (fromRoot.id !== toRoot.id) {
    target = remapIds(target, { [toRoot.id]: fromRoot.id });
  }

  const fromById = indexNodes(from.nodes);
  const toById = indexNodes(target.nodes);
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const n of target.nodes) if (!fromById.has(n.id)) added.add(n.id);
  for (const n of from.nodes) if (!toById.has(n.id)) deleted.add(n.id);

  const actions: MindmapAction[] = [];

  // 1) 新增（先序，兄弟按 to 顺序追加；坐标带入，服务端文档即最终几何）
  const addedPreorder: MindmapNode[] = [];
  const collectAdds = (parentId: string | null): void => {
    for (const n of orderedChildren(target.nodes, parentId)) {
      if (added.has(n.id)) addedPreorder.push(n);
      collectAdds(n.id);
    }
  };
  collectAdds(null);
  for (const n of addedPreorder) {
    actions.push({
      op: 'add_node',
      id: n.id,
      parentId: n.parentId,
      text: n.text,
      kind: n.kind,
      paperId: n.paperId,
      x: n.x,
      y: n.y,
    });
  }

  // 2) 父节点变化（含删除上提：to 中孩子挂到了祖父名下，本质就是一次 move）
  for (const n of target.nodes) {
    if (added.has(n.id)) continue;
    const old = fromById.get(n.id);
    if (!old || old.parentId === n.parentId || n.parentId === null) continue;
    actions.push({ op: 'move_node', id: n.id, newParentId: n.parentId });
  }

  // 3) 顶层被删节点整支删除（存活后代在第 2 阶段已移出）
  for (const n of from.nodes) {
    if (!deleted.has(n.id)) continue;
    if (n.parentId !== null && deleted.has(n.parentId)) continue;
    if (n.parentId === null) continue; // 根已在前置归一，理论不可达
    actions.push({ op: 'delete_node', id: n.id, strategy: 'delete_branch' });
  }

  // 在 from 上模拟前三阶段，得到当前中间态，供 4/5 阶段精确生成动作。
  // applyActions 会把新增节点的临时 ID 重新生成；这里反转回目标 ID，
  // 让后续模拟与目标文档处在同一 ID 空间（服务端执行时 idMap 跨动作共享，
  // move/update 引用临时 ID 仍可解析，模拟必须对齐这一事实）。
  const structural = applyActions(from, actions);
  const freshToTarget: Record<string, string> = {};
  for (const [tempId, freshId] of Object.entries(structural.idMap)) {
    freshToTarget[freshId] = tempId;
  }
  let sim = remapIds(structural.doc, freshToTarget);

  // 4) 同父排序校正：逐位置把 want[i] move 到 i（每次立即模拟，下标基于真实状态）
  const parents = new Set<string | null>();
  for (const n of target.nodes) parents.add(n.parentId);
  for (const pid of parents) {
    if (pid === null) continue;
    const want = orderedChildren(target.nodes, pid).map((n) => n.id);
    for (let i = 0; i < want.length; i++) {
      const current = orderedChildren(sim.nodes, pid).map((n) => n.id);
      if (current[i] === want[i]) continue;
      const action: MindmapAction = {
        op: 'move_node',
        id: want[i],
        newParentId: pid,
        newOrder: i,
      };
      sim = applyActions(sim, [action]).doc;
      actions.push(action);
    }
  }

  // 5) 字段差异
  const fieldActions: MindmapAction[] = [];
  const simById = indexNodes(sim.nodes);
  for (const n of target.nodes) {
    const cur = toById.get(n.id);
    const old = simById.get(n.id);
    if (!cur || !old) continue;
    const patch: Extract<MindmapAction, { op: 'update_node' }> = { op: 'update_node', id: n.id };
    let dirty = false;
    if (cur.text !== old.text) { patch.text = cur.text; dirty = true; }
    if (cur.kind !== old.kind || cur.paperId !== old.paperId) {
      patch.kind = cur.kind;
      patch.paperId = cur.paperId;
      dirty = true;
    }
    if (cur.x !== old.x) { patch.x = cur.x; dirty = true; }
    if (cur.y !== old.y) { patch.y = cur.y; dirty = true; }
    if ((cur.collapsed ?? false) !== (old.collapsed ?? false)) {
      patch.collapsed = cur.collapsed ?? false;
      dirty = true;
    }
    if (dirty) fieldActions.push(patch);
  }
  if (fieldActions.length) {
    sim = applyActions(sim, fieldActions).doc;
    actions.push(...fieldActions);
  }

  // 终态校验：生成的动作必须精确复现 to（结构与字段；order 经规范化不参与比对）
  const verify = applyActions(from, actions);
  const backToTarget: Record<string, string> = {};
  for (const [tempId, generatedId] of Object.entries(verify.idMap)) {
    backToTarget[generatedId] = tempId;
  }
  const reached = remapIds(verify.doc, backToTarget);
  // 节点数组顺序无语义（顺序由 (order,id) 定义）：按 ID 排序后规范化比较
  if (canonicalNodes(reached) !== canonicalNodes(target)) {
    throw new MindmapError('mindmap.diff_mismatch');
  }
  return actions;
}

/** 规范化节点集合：按 ID 排序序列化（节点数组排列顺序无语义；order 字段参与比较）。 */
function canonicalNodes(doc: MindmapDoc): string {
  return JSON.stringify(
    doc.nodes
      .slice()
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  );
}
