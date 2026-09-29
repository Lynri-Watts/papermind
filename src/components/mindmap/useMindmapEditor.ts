/**
 * 思维导图编辑器内核（React 绑定）。
 *
 * 职责：
 * - 以 MindmapDoc 为画布唯一真源，RF 的节点/边每次由它派生；
 * - 几何位置不是用户数据：节点不可拖拽，坐标只存在于前端内存，绝不进入
 *   /actions 管线；任何结构变更（增删/移动/改文本/外部 diff/重载）后自动用
 *   mermaid 同源布局重排，折叠等纯显隐变更不重排；
 * - 所有结构编辑先在本地 applyActions 乐观落图（新节点由 tidy-tree 即时补位，
 *   mermaid 结果回来后校正），再进入 600ms 防抖队列批量 POST /actions；
 * - 临时 ID 两段对账：本地生成 provisional ID 即时成图，服务端返回正式 ID 后，
 *   对活动文档与队列中后续动作统一 remap（含在途批次的批内 temp 引用）；
 * - 409（AI/多端并发）：丢弃队列，整份载入服务端 currentMindmap；
 * - 本地 undo/redo：快照栈 + diffDocs 把快照差翻译成同一动作管线（AI 事务除外，
 *   AI 的整事务撤销走 /undo-ai，不进本地栈）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MindmapAction, MindmapDoc, MindmapInfo } from '../../types';
import {
  MindmapError,
  applyActions,
  applyFullLayout,
  applyMissingLayout,
  diffDocs,
  fillForSection,
  indexNodes,
  layoutByMermaid,
  orderedChildren,
  remapIds,
  translateActionIds,
  type MermaidEdgeGeom,
} from '../../lib/mindmap';
import { MindmapConflictError, submitMindmapActions } from '../../api';
import { usePaperMindStore } from '../../store';
import {
  pruneMindmapBuffer,
  subscribeMindmap,
  subscribeMindmapAutoLayout,
  subscribeMindmapReload,
} from '../../lib/mindmap/bridge';

/** 一次提交分组：入队动作（新增节点已回填最终几何）与该组的 temp→provisional 映射 */
interface QueuedGroup {
  actions: MindmapAction[];
  tempToProv: Record<string, string>;
}

type HistoryMode = 'user' | 'undo' | 'redo';
export type MindmapSaveError = 'conflict' | 'saveFailed';
/** mermaid 布局非阻断通知（失败时画布提示，已降级 tidy-tree） */
export type MindmapLayoutNotice = 'layoutFailed';

/** mermaid 同源布局实测的节点视觉几何（画布按官方尺寸/配色渲染的依据） */
export interface MindmapNodeGeom {
  width: number;
  height: number;
  fill: string;
  textColor: string;
  /** root 为 null，其余 0..10 */
  section: number | null;
}

const HISTORY_LIMIT = 50;
const FLUSH_DELAY_MS = 600;

/**
 * 布局结构签名：mermaid 离屏渲染是异步的，结果回来时文档必须仍是同一结构
 * （身份/父子/排序/形状/折叠/文本——文本决定测宽），否则丢弃本次结果，
 * 由更新的一次运行或 tidy 补位兜底，绝不把过期坐标写到新结构上。
 */
function layoutSignature(doc: MindmapDoc): string {
  return JSON.stringify(
    doc.nodes.map((n) => [
      n.id, n.parentId, n.order, n.shape ?? '', n.kind ?? '',
      n.collapsed === true ? 1 : 0, n.text ?? '',
    ])
  );
}

function newClientTempId(): string {
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `tmp_${hex}`;
}

/**
 * 几何坐标是纯前端渲染态：提交服务端前从动作中剥离 x/y
 * （mergeDoc 可能产生坐标差；服务端坐标永远缺省，布局一律以前端 mermaid 为准）。
 * 剥离后为空的 update_node 直接丢弃。
 */
function stripGeomActions(actions: MindmapAction[]): MindmapAction[] {
  const out: MindmapAction[] = [];
  for (const a of actions) {
    if (a.op === 'add_node') {
      // 仅用 rest 剥离 x/y，省略的绑定不会触发 noUnusedLocals
      const { x: _gx, y: _gy, ...rest } = a;
      out.push(rest);
    } else if (a.op === 'update_node') {
      const { x: _gx, y: _gy, ...rest } = a;
      if (Object.keys(rest).length > 1) out.push(rest);
    } else {
      out.push(a);
    }
  }
  return out;
}

export interface UseMindmapEditorOptions {
  mapId: string;
  workspaceId?: string | null;
  /** 初始文档（来自 store 缓存 / GET /mindmaps/<id>） */
  info: MindmapInfo;
  readOnly?: boolean;
}

export interface MindmapEditorApi {
  doc: MindmapDoc;
  version: number;
  selectedId: string | null;
  editingId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  error: MindmapSaveError | null;
  /** mermaid 同源布局进行中（工具栏按钮显示 spinner） */
  layouting: boolean;
  /** mermaid 布局失败等非阻断通知（已降级 tidy-tree） */
  layoutNotice: MindmapLayoutNotice | null;
  clearLayoutNotice: () => void;
  /** 最近一次 mermaid 布局实测的节点几何（id → 尺寸/配色）；结构一变即清空 */
  nodeGeom: Map<string, MindmapNodeGeom>;
  /** 最近一次 mermaid 布局实测的边几何（key=``source->target``）；结构一变即清空 */
  edgeGeom: Map<string, MermaidEdgeGeom>;
  setSelectedId: (id: string | null) => void;
  clearError: () => void;
  retrySave: () => void;
  startEdit: (id: string) => void;
  commitEdit: (id: string, text: string) => void;
  cancelEdit: () => void;
  addChild: (parentId?: string | null) => void;
  addSibling: (nodeId?: string | null) => void;
  deleteNode: (id?: string | null) => void;
  toggleCollapsed: (id: string) => void;
  /** 强制重跑 mermaid 同源布局（失败时 tidy 全布局兜底 + 非阻断提示） */
  relayout: () => void;
  attachPaper: (id: string, paperId: string) => void;
  undo: () => void;
  redo: () => void;
  /** 代码面板「应用」：目标文档已经过 mergeDoc（几何保留），走用户历史 */
  adoptUserTarget: (target: MindmapDoc) => void;
  /** AI SSE mindmap_diff：服务端已落库，仅本地对账落图，不进历史、不入队 */
  applyExternalDiff: (
    actions: MindmapAction[],
    serverIdMap: Record<string, string> | undefined,
    version: number | undefined
  ) => void;
  /** AI 事务撤销成功后全量重载（服务端已落新版本），清空本地队列并对账几何 */
  reloadFromServer: () => Promise<void>;
}

export function useMindmapEditor(opts: UseMindmapEditorOptions): MindmapEditorApi {
  const { mapId, workspaceId = null, readOnly = false } = opts;

  const initialDoc = useMemo(
    () => applyMissingLayout(structuredClone({ nodes: opts.info.nodes }) as MindmapDoc),
    // 仅在挂载/换图时初始化；后续内容更新由 publish 与外部 diff 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapId]
  );

  const [doc, setDoc] = useState<MindmapDoc>(initialDoc);
  const docRef = useRef<MindmapDoc>(initialDoc);
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MindmapSaveError | null>(null);
  const [layouting, setLayouting] = useState(false);
  const [layoutNotice, setLayoutNotice] = useState<MindmapLayoutNotice | null>(null);
  const [nodeGeom, setNodeGeom] = useState<Map<string, MindmapNodeGeom>>(new Map());
  const [edgeGeom, setEdgeGeom] = useState<Map<string, MermaidEdgeGeom>>(new Map());

  /** mermaid 异步布局批次令牌：仅最新一批允许落图，过期结果丢弃 */
  const layoutTokenRef = useRef(0);

  const versionRef = useRef<number>(opts.info.version);
  const queueRef = useRef<QueuedGroup[]>([]);
  const inflightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  /** 已确认的 temp/provisional → server 正式 ID 对账表 */
  const aliasRef = useRef<Record<string, string>>({});
  const pastRef = useRef<MindmapDoc[]>([]);
  const futureRef = useRef<MindmapDoc[]>([]);

  // flush 在卸载 effect 中被引用：用 ref 打破声明顺序依赖
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  // runMermaidLayout 与 commit 互相引用：用 ref 打破声明顺序依赖
  const runLayoutRef = useRef<(mode: 'user' | 'auto') => Promise<boolean>>(
    async () => false
  );

  const setSavingSafe = useCallback((v: boolean) => {
    if (mountedRef.current) setSaving(v);
  }, []);
  const setErrorSafe = useCallback((v: MindmapSaveError | null) => {
    if (mountedRef.current) setError(v);
  }, []);
  const setLayoutingSafe = useCallback((v: boolean) => {
    if (mountedRef.current) setLayouting(v);
  }, []);
  const setLayoutNoticeSafe = useCallback((v: MindmapLayoutNotice | null) => {
    if (mountedRef.current) setLayoutNotice(v);
  }, []);

  /**
   * 丢弃最近一次 mermaid 实测几何：任何走常规动作管线的变更（用户编辑、撤销重做、
   * AI 流式增补、整份重载）都意味着结构/几何已偏离 mermaid 结果，边回退为贝塞尔、
   * 节点回退自适应尺寸；新的 mermaid 布局结果由 applyMermaidResult 单独写入。
   */
  const clearMermaidGeom = useCallback(() => {
    setNodeGeom((cur) => (cur.size === 0 ? cur : new Map()));
    setEdgeGeom((cur) => (cur.size === 0 ? cur : new Map()));
  }, []);

  /** 把活动文档同步到 React 状态与 store 缓存（乐观/确认/外部 diff 统一入口） */
  const publish = useCallback((next: MindmapDoc, version?: number) => {
    docRef.current = next;
    if (mountedRef.current) setDoc(next);
    const store = usePaperMindStore.getState();
    const meta = store.mindmapDocs[mapId];
    store.cacheMindmapDoc({
      id: mapId,
      scope: meta?.scope ?? opts.info.scope,
      title: meta?.title ?? opts.info.title,
      version: version ?? versionRef.current,
      created_at: meta?.created_at ?? opts.info.created_at,
      updated_at: meta?.updated_at ?? opts.info.updated_at,
      nodes: next.nodes,
    });
  }, [mapId, opts.info.scope, opts.info.title, opts.info.created_at, opts.info.updated_at]);

  const flush = useCallback(async () => {
    if (inflightRef.current) return;
    const sentGroups = queueRef.current;
    if (sentGroups.length === 0) return;
    queueRef.current = [];
    inflightRef.current = true;
    setSavingSafe(true);

    // 发送前把动作中的 ID 解析为「服务端可解析」形式：
    // 已确认 → server 正式 ID；未确认 → 同批 temp（服务端 idMap 跨动作共享）
    const batchTemps = new Set<string>();
    for (const g of sentGroups) {
      for (const a of g.actions) if (a.op === 'add_node' && a.id) batchTemps.add(a.id);
    }
    const resolver: Record<string, string> = {};
    for (const g of sentGroups) {
      for (const [temp, prov] of Object.entries(g.tempToProv)) {
        if (aliasRef.current[prov]) resolver[prov] = aliasRef.current[prov];
        else if (batchTemps.has(temp)) resolver[prov] = temp;
      }
    }
    const flatActions = sentGroups.flatMap((g) => g.actions);
    const wireActions = translateActionIds(flatActions, resolver);

    let succeeded = false;
    try {
      const res = await submitMindmapActions(mapId, versionRef.current, wireActions, workspaceId);

      // 组装 temp/prov → server 对账表
      const tempToProv = new Map<string, string>();
      for (const g of sentGroups) {
        for (const [temp, prov] of Object.entries(g.tempToProv)) tempToProv.set(temp, prov);
      }
      const alias: Record<string, string> = {};
      for (const [temp, srv] of Object.entries(res.idMap)) {
        alias[temp] = srv;
        const prov = tempToProv.get(temp);
        if (prov) alias[prov] = srv;
      }
      aliasRef.current = { ...aliasRef.current, ...alias };

      // 在途期间新入队的分组：翻译其对已确认 ID 的引用
      queueRef.current = queueRef.current.map((g) => ({
        ...g,
        actions: translateActionIds(g.actions, alias),
      }));

      const remapped = remapIds(docRef.current, alias);
      versionRef.current = res.mindmap.version;
      publish(remapped, res.mindmap.version);
      setErrorSafe(null);
      succeeded = true;
    } catch (e) {
      // 失败分组放回队首，下一次调度（或手动重试）继续
      queueRef.current = [...sentGroups, ...queueRef.current];
      if (e instanceof MindmapConflictError) {
        // 版本冲突（AI/其他端已写入）：放弃在途编辑，整份载入服务端版本
        queueRef.current = [];
        aliasRef.current = {};
        const fresh = applyMissingLayout(
          structuredClone({ nodes: e.currentMindmap.nodes }) as MindmapDoc
        );
        versionRef.current = e.currentMindmap.version;
        publish(fresh, e.currentMindmap.version);
        clearMermaidGeom();
        setErrorSafe('conflict');
        // 服务端权威可能与本地结构完全不同：重新 mermaid 排布
        void runLayoutRef.current('auto');
      } else {
        setErrorSafe('saveFailed');
      }
    } finally {
      inflightRef.current = false;
      // 仅成功后链式发送在途新分组；失败时保留队列等手动重试/下次编辑，避免错误风暴
      if (succeeded && queueRef.current.length > 0) {
        void flushRef.current();
      } else {
        setSavingSafe(false);
      }
    }
  }, [clearMermaidGeom, mapId, publish, setErrorSafe, setSavingSafe, workspaceId]);
  flushRef.current = flush;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      // 离开页面时把未落库编辑立即送走（setState 由 mountedRef 守卫）
      void flushRef.current();
    };
  }, []);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void flushRef.current();
    }, FLUSH_DELAY_MS);
  }, []);

  /**
   * 本地应用一组动作、写历史、入队；返回 temp→provisional（调用方用于选中/编辑新节点）。
   * skipAutoLayout：仅 tidy 降级等「布局内部」路径使用，避免提交后再次触发 mermaid。
   */
  const commit = useCallback((
    actions: MindmapAction[],
    mode: HistoryMode,
    opts?: { skipAutoLayout?: boolean }
  ): Record<string, string> | null => {
    if (readOnly) return null;
    const prev = docRef.current;
    let applied: MindmapDoc;
    let localMap: Record<string, string>;
    try {
      const r = applyActions(prev, actions);
      applied = r.doc;
      localMap = r.idMap;
    } catch (e) {
      // UI 合成的动作理论上恒合法；防御性地提示保存失败，不破坏现场
      console.error('[mindmap] local action rejected', e);
      setErrorSafe('saveFailed');
      return null;
    }
    const next = applyMissingLayout(applied);

    if (mode === 'user') {
      pastRef.current.push(prev);
      if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
      futureRef.current = [];
    } else if (mode === 'undo') {
      futureRef.current.push(prev);
    } else {
      pastRef.current.push(prev);
    }
    setHistoryTick((t) => t + 1);

    publish(next);
    // 结构/几何已变：mermaid 实测边与尺寸失效（坐标-only 的自动布局不走 commit）
    clearMermaidGeom();
    // 几何不随动作提交：x/y 是纯前端渲染态，剥离后为空的批（纯坐标差）不落库
    const wireActions = stripGeomActions(actions);
    if (wireActions.length > 0) {
      queueRef.current.push({ actions: wireActions, tempToProv: localMap });
      scheduleFlush();
    }

    // 几何不可用户编辑：结构一改就自动重排（纯折叠只影响显隐，不重排）
    if (!opts?.skipAutoLayout && !actions.every((a) => a.op === 'set_collapsed')) {
      void runLayoutRef.current('auto');
    }
    return localMap;
  }, [clearMermaidGeom, publish, readOnly, scheduleFlush, setErrorSafe]);

  // ---------- 选择/编辑 ----------
  const setSelectedId = useCallback((id: string | null) => setSelectedIdState(id), []);
  const clearError = useCallback(() => setErrorSafe(null), [setErrorSafe]);
  const retrySave = useCallback(() => {
    setErrorSafe(null);
    void flushRef.current();
  }, [setErrorSafe]);

  const startEdit = useCallback((id: string) => {
    if (readOnly) return;
    setSelectedIdState(id);
    setEditingId(id);
  }, [readOnly]);

  const cancelEdit = useCallback(() => setEditingId(null), []);

  const commitEdit = useCallback((id: string, text: string) => {
    setEditingId((cur) => (cur === id ? null : cur));
    const node = indexNodes(docRef.current.nodes).get(id);
    if (node && node.text !== text) {
      commit([{ op: 'update_node', id, text }], 'user');
    }
  }, [commit]);

  // ---------- 结构编辑 ----------
  const rootId = useMemo(
    () => doc.nodes.find((n) => n.parentId === null)?.id ?? null,
    [doc]
  );

  const addChild = useCallback((parentId?: string | null) => {
    const pid = parentId ?? selectedId ?? rootId;
    if (!pid) return;
    const temp = newClientTempId();
    const map = commit([{ op: 'add_node', id: temp, parentId: pid, text: '' }], 'user');
    const nid = map?.[temp];
    if (nid) {
      setSelectedIdState(nid);
      setEditingId(nid);
    }
  }, [commit, rootId, selectedId]);

  const addSibling = useCallback((nodeId?: string | null) => {
    const id = nodeId ?? selectedId ?? rootId;
    if (!id) return;
    const node = indexNodes(docRef.current.nodes).get(id);
    if (!node) return;
    if (node.parentId === null) {
      addChild(id);
      return;
    }
    // 插在当前节点之后（后端越界自动夹到末尾）
    const index = orderedChildren(docRef.current.nodes, node.parentId).findIndex((n) => n.id === id);
    const temp = newClientTempId();
    const map = commit(
      [{ op: 'add_node', id: temp, parentId: node.parentId, text: '', order: index + 1 }],
      'user'
    );
    const nid = map?.[temp];
    if (nid) {
      setSelectedIdState(nid);
      setEditingId(nid);
    }
  }, [addChild, commit, rootId, selectedId]);

  const deleteNode = useCallback((id?: string | null) => {
    const target = id ?? selectedId;
    if (!target) return;
    const node = indexNodes(docRef.current.nodes).get(target);
    if (!node || node.parentId === null) return; // 根不可删
    setEditingId((cur) => (cur === target ? null : cur));
    setSelectedIdState((cur) => (cur === target ? null : cur));
    // 默认 promote：直系子节点上提（与 Delete 键语义一致）
    commit([{ op: 'delete_node', id: target }], 'user');
  }, [commit, selectedId]);

  const toggleCollapsed = useCallback((id: string) => {
    const node = indexNodes(docRef.current.nodes).get(id);
    if (!node) return;
    commit([{ op: 'set_collapsed', id, collapsed: !(node.collapsed === true) }], 'user');
  }, [commit]);

  // ---------- mermaid 同源布局 ----------
  /**
   * 把 mermaid 实测几何直接写到活动文档坐标与画布视觉状态。
   * 坐标是纯前端渲染态：不进历史、不合成 update_node、不入保存队列。
   */
  const applyMermaidResult = useCallback((
    result: Awaited<ReturnType<typeof layoutByMermaid>>
  ) => {
    const prev = docRef.current;
    let changed = false;
    const nextNodes = prev.nodes.map((n) => {
      const g = result.nodes.get(n.id);
      if (!g) return n;
      const x = Math.round(g.x);
      const y = Math.round(g.y);
      if (Math.abs(n.x - x) <= 0.5 && Math.abs(n.y - y) <= 0.5) return n;
      changed = true;
      return { ...n, x, y };
    });

    if (changed) publish({ nodes: nextNodes });

    const nextNodeGeom = new Map<string, MindmapNodeGeom>();
    result.nodes.forEach((g) => {
      // 个别主题下 default 底色可能解析为 none：回退到结构推导色，保证节点可读
      const fill = /^(none|transparent|rgba\([^)]*,\s*0(?:\.0+)?\))$/i.test(g.fill)
        ? fillForSection(g.section)
        : g.fill;
      nextNodeGeom.set(g.id, {
        width: g.width,
        height: g.height,
        fill,
        textColor: g.textColor || (g.section === null ? '#2C2C2C' : '#D3D3D3'),
        section: g.section,
      });
    });
    const nextEdgeGeom = new Map<string, MermaidEdgeGeom>();
    for (const e of result.edges) nextEdgeGeom.set(`${e.source}->${e.target}`, e);
    setNodeGeom(nextNodeGeom);
    setEdgeGeom(nextEdgeGeom);
  }, [publish]);

  /**
   * 用同一颗 mermaid 引擎对当前文档全量排布（坐标只落前端，从不入库）。
   * - 'user'：工具栏「重新布局」，失败时 tidy 全布局兜底并出非阻断通知；
   * - 'auto'：挂载/结构变更/AI 流结束，失败静默（tidy 补位已在屏）。
   * 返回是否成功落图。结构在渲染期间变化时结果作废（调用方无需重试，后续触发会接管）。
   */
  const runMermaidLayout = useCallback(async (mode: 'user' | 'auto'): Promise<boolean> => {
    if (mode === 'user' && readOnly) return false;
    const token = ++layoutTokenRef.current;
    const signature = layoutSignature(docRef.current);
    setLayoutingSafe(true);
    try {
      const result = await layoutByMermaid(docRef.current);
      if (!mountedRef.current || token !== layoutTokenRef.current) return false;
      if (layoutSignature(docRef.current) !== signature) return false;
      applyMermaidResult(result);
      setLayoutNoticeSafe(null);
      return true;
    } catch (e) {
      if (!mountedRef.current || token !== layoutTokenRef.current) return false;
      console.error('[mindmap] mermaid layout failed, fallback to tidy-tree', e);
      if (mode === 'user') {
        // tidy 降级同样只写前端坐标，不进历史/不入库
        publish(applyFullLayout(docRef.current));
        clearMermaidGeom();
        setLayoutNoticeSafe('layoutFailed');
      }
      return false;
    } finally {
      if (mountedRef.current && token === layoutTokenRef.current) setLayoutingSafe(false);
    }
  }, [
    applyMermaidResult, clearMermaidGeom, publish, readOnly,
    setLayoutingSafe, setLayoutNoticeSafe,
  ]);
  runLayoutRef.current = runMermaidLayout;

  const clearLayoutNotice = useCallback(() => setLayoutNoticeSafe(null), [setLayoutNoticeSafe]);

  const relayout = useCallback(() => {
    if (readOnly) return;
    void runMermaidLayout('user');
  }, [readOnly, runMermaidLayout]);

  const attachPaper = useCallback((id: string, paperId: string) => {
    commit([{ op: 'attach_paper', id, paperId }], 'user');
  }, [commit]);

  // ---------- undo / redo ----------
  const undo = useCallback(() => {
    if (readOnly) return;
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push(docRef.current);
    try {
      commit(diffDocs(docRef.current, prev), 'undo');
    } catch (e) {
      // 快照不兼容时回滚栈指针
      pastRef.current.push(prev);
      futureRef.current.pop();
      if (e instanceof MindmapError) setErrorSafe('saveFailed');
    }
  }, [commit, readOnly, setErrorSafe]);

  const redo = useCallback(() => {
    if (readOnly) return;
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(docRef.current);
    try {
      commit(diffDocs(docRef.current, next), 'redo');
    } catch (e) {
      futureRef.current.push(next);
      pastRef.current.pop();
      if (e instanceof MindmapError) setErrorSafe('saveFailed');
    }
  }, [commit, readOnly, setErrorSafe]);

  // ---------- 代码面板 / AI 外部入口 ----------
  const adoptUserTarget = useCallback((target: MindmapDoc) => {
    if (readOnly) return;
    try {
      // commit 内部已在结构变化后自动触发 mermaid 重排（几何以 mermaid 为准，
      // mergeDoc 保留的画布坐标会被校正）
      commit(diffDocs(docRef.current, target), 'user');
    } catch (e) {
      console.error('[mindmap] adopt target failed', e);
      setErrorSafe('saveFailed');
    }
  }, [commit, readOnly, setErrorSafe]);

  const applyExternalDiff = useCallback((
    actions: MindmapAction[],
    serverIdMap: Record<string, string> | undefined,
    version: number | undefined,
    options?: { intoHistory?: boolean }
  ) => {
    try {
      // 其他界面发起的用户编辑（如 Explore「加入导图」）进入本地撤销栈；AI 编辑不进
      if (options?.intoHistory) {
        pastRef.current.push(docRef.current);
        if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
        futureRef.current = [];
        setHistoryTick((tick) => tick + 1);
      }
      const { doc: applied, idMap: localMap } = applyActions(docRef.current, actions);
      let next = applyMissingLayout(applied);
      if (serverIdMap && Object.keys(serverIdMap).length) {
        const alias: Record<string, string> = {};
        for (const [temp, srv] of Object.entries(serverIdMap)) {
          alias[temp] = srv;
          const prov = localMap[temp];
          if (prov) alias[prov] = srv;
        }
        next = remapIds(next, alias);
      }
      if (typeof version === 'number') versionRef.current = version;
      publish(next, version);
      clearMermaidGeom();
      // 用户在其他界面发起的结构编辑（Explore「加入导图」）立即重排；
      // AI 流式增补由流末 autoLayout 信号统一重排，避免增量期间反复离屏渲染
      if (options?.intoHistory) void runLayoutRef.current('auto');
    } catch (e) {
      // AI 动作与本地状态不兼容（如本地先删了目标节点）：提示冲突，调用方应拉取最新版本
      console.error('[mindmap] external diff rejected, reload required', e);
      setErrorSafe('conflict');
    }
  }, [clearMermaidGeom, publish, setErrorSafe]);

  // ---------- 全量重载（AI 事务撤销等外部非增量变更） ----------
  const reloadFromServer = useCallback(async () => {
    try {
      const info = await usePaperMindStore.getState()
        .loadMindmapDoc(mapId, workspaceId, true);
      // 撤销发生在服务端权威之后：丢弃尚未同步的本地批次，避免过期提交风暴
      queueRef.current = [];
      versionRef.current = info.version;
      const next = applyMissingLayout({ nodes: info.nodes.map((n) => ({ ...n })) });
      publish(next, info.version);
      clearMermaidGeom();
      pruneMindmapBuffer(mapId, info.version);
      setErrorSafe(null);
      // 全量重载后结构可能完全不同（如 AI 事务撤销）：以 mermaid 重新排布
      void runLayoutRef.current('auto');
    } catch (e) {
      console.error('[mindmap] reload from server failed', e);
      setErrorSafe('saveFailed');
    }
  }, [clearMermaidGeom, mapId, workspaceId, publish, setErrorSafe]);

  // 挂载/换图即排布：几何不是用户数据，任何导图（含带历史坐标的旧图）都先以
  // initialDoc 的 tidy 补位即时成图，再异步换用 mermaid 官方排布（不进撤销栈）。
  useEffect(() => {
    if (opts.info.nodes.length > 0) void runLayoutRef.current('auto');
    // 仅挂载/换图执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId]);

  // 订阅外部已提交事件（Explore「加入导图」/ AI SSE）；按 version 去重，用户事件进撤销栈
  useEffect(() => {
    pruneMindmapBuffer(mapId, versionRef.current);
    const offCommit = subscribeMindmap(mapId, (event) => {
      if (event.version <= versionRef.current) return;
      applyExternalDiff(event.actions, event.idMap, event.version, {
        intoHistory: event.origin === 'user',
      });
    });
    const offReload = subscribeMindmapReload(mapId, (version) => {
      if (version > versionRef.current) void reloadFromServer();
    });
    // 一轮 AI 流结束 /「加入导图」：无条件补一次 mermaid 全布局（几何不可手改）
    const offAutoLayout = subscribeMindmapAutoLayout(mapId, () => {
      void runMermaidLayout('auto');
    });
    return () => {
      offCommit();
      offReload();
      offAutoLayout();
    };
  }, [mapId, applyExternalDiff, reloadFromServer, runMermaidLayout]);

  // historyTick 仅用于驱动 canUndo/canRedo 重算
  void historyTick;

  return {
    doc,
    version: versionRef.current,
    selectedId,
    editingId,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    saving,
    error,
    layouting,
    layoutNotice,
    clearLayoutNotice,
    nodeGeom,
    edgeGeom,
    setSelectedId,
    clearError,
    retrySave,
    startEdit,
    commitEdit,
    cancelEdit,
    addChild,
    addSibling,
    deleteNode,
    toggleCollapsed,
    relayout,
    attachPaper,
    undo,
    redo,
    adoptUserTarget,
    applyExternalDiff,
    reloadFromServer,
  };
}
