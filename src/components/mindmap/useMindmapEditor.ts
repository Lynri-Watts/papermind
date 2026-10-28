/**
 * 思维导图编辑器内核（React 绑定）。
 *
 * 职责：
 * - 以 MindmapDoc 为画布唯一真源，几何布局现在由 mind-elixir DOM 内部管理，
 *   MindmapDoc 中的 x/y 字段固定为 0（仅为类型兼容保留）；
 * - 所有结构编辑先在本地 applyActions 乐观落图，再进入 600ms 防抖队列批量 POST /actions；
 * - 临时 ID 两段对账：本地生成 provisional ID 即时成图，服务端返回正式 ID 后，
 *   对活动文档与队列中后续动作统一 remap（含在途批次的批内 temp 引用）；
 * - 409（AI/多端并发）：丢弃队列，整份载入服务端 currentMindmap；
 * - 本地 undo/redo：快照栈 + diffDocs 把快照差翻译成同一动作管线（AI 事务除外，
 *   AI 的整事务撤销走 /undo-ai，不进本地栈）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MindmapAction, MindmapDoc, MindmapInfo } from '../../types';
import {
  MindmapError,
  applyActions,
  diffDocs,
  indexNodes,
  orderedChildren,
  remapIds,
  translateActionIds,
} from '../../lib/mindmap';
import { MindmapConflictError, submitMindmapActions } from '../../api';
import { usePaperMindStore } from '../../store';
import {
  pruneMindmapBuffer,
  subscribeMindmap,
  subscribeMindmapReload,
} from '../../lib/mindmap/bridge';

/** 一次提交分组：入队动作与该组的 temp→provisional 映射 */
interface QueuedGroup {
  actions: MindmapAction[];
  tempToProv: Record<string, string>;
}

type HistoryMode = 'user' | 'undo' | 'redo';
export type MindmapSaveError = 'conflict' | 'saveFailed';

const HISTORY_LIMIT = 50;
const FLUSH_DELAY_MS = 600;

function newClientTempId(): string {
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `tmp_${hex}`;
}

/**
 * 几何坐标是纯前端渲染态：提交服务端前从动作中剥离 x/y
 * （服务端坐标永远缺省，几何由 mind-elixir 内部管）。
 * 剥离后为空的 update_node 直接丢弃。
 */
function stripGeomActions(actions: MindmapAction[]): MindmapAction[] {
  const out: MindmapAction[] = [];
  for (const a of actions) {
    if (a.op === 'add_node') {
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
  attachPaper: (id: string, paperId: string) => void;
  undo: () => void;
  redo: () => void;
  /** mind-elixir onChangeData 回写（防抖 1.5s，合并高频操作） */
  adoptUserTarget: (target: MindmapDoc) => void;
  /** 源码面板"应用"按钮走这条，显式用户动作立即 commit */
  applyCodeTarget: (target: MindmapDoc) => void;
  /** AI SSE mindmap_diff：服务端已落库，仅本地对账落图，不进历史、不入队 */
  applyExternalDiff: (
    actions: MindmapAction[],
    serverIdMap: Record<string, string> | undefined,
    version: number | undefined,
  ) => void;
  /** AI 事务撤销成功后全量重载（服务端已落新版本） */
  reloadFromServer: () => Promise<void>;
}

export function useMindmapEditor(opts: UseMindmapEditorOptions): MindmapEditorApi {
  const { mapId, workspaceId = null, readOnly = false } = opts;

  const initialDoc: MindmapDoc = { nodes: opts.info.nodes.map((n) => ({ ...n, x: 0, y: 0 })) };

  const [doc, setDoc] = useState<MindmapDoc>(initialDoc);
  const docRef = useRef<MindmapDoc>(initialDoc);
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MindmapSaveError | null>(null);

  const versionRef = useRef<number>(opts.info.version);
  const queueRef = useRef<QueuedGroup[]>([]);
  const inflightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const aliasRef = useRef<Record<string, string>>({});
  const pastRef = useRef<MindmapDoc[]>([]);
  const futureRef = useRef<MindmapDoc[]>([]);

  /** adoptUserTarget 专用防抖：MindElixir operation 高频触发时只存最新目标，
   *  防抖到期后一次性 commit，避免 queue 堆多批递增版本导致后端 409 conflict */
  const pendingDocRef = useRef<MindmapDoc | null>(null);
  const pendingCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ADOPT_DEBOUNCE_MS = 1500;

  const flushRef = useRef<() => Promise<void>>(async () => undefined);

  const setSavingSafe = useCallback((v: boolean) => {
    if (mountedRef.current) setSaving(v);
  }, []);
  const setErrorSafe = useCallback((v: MindmapSaveError | null) => {
    if (mountedRef.current) setError(v);
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

    // 发送前把动作中的 ID 解析为「服务端可解析」形式
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
      queueRef.current = [...sentGroups, ...queueRef.current];
      if (e instanceof MindmapConflictError) {
        queueRef.current = [];
        aliasRef.current = {};
        const fresh: MindmapDoc = { nodes: e.currentMindmap.nodes.map((n) => ({ ...n, x: 0, y: 0 })) };
        versionRef.current = e.currentMindmap.version;
        publish(fresh, e.currentMindmap.version);
        setErrorSafe('conflict');
      } else {
        setErrorSafe('saveFailed');
      }
    } finally {
      inflightRef.current = false;
      if (succeeded && queueRef.current.length > 0) {
        void flushRef.current();
      } else {
        setSavingSafe(false);
      }
    }
  }, [mapId, publish, setErrorSafe, setSavingSafe, workspaceId]);
  flushRef.current = flush;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingCommitTimerRef.current) clearTimeout(pendingCommitTimerRef.current);
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
   * 本地应用一组动作、写历史、入队；返回 temp→provisional。
   */
  const commit = useCallback((
    actions: MindmapAction[],
    mode: HistoryMode,
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
      console.error('[mindmap] local action rejected', e);
      setErrorSafe('saveFailed');
      return null;
    }

    // 几何坐标统一归零（mind-elixir 内部管理）
    const normalizedDoc: MindmapDoc = {
      nodes: applied.nodes.map((n) => ({ ...n, x: 0, y: 0 })),
    };

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

    publish(normalizedDoc);
    const wireActions = stripGeomActions(actions);
    if (wireActions.length > 0) {
      queueRef.current.push({ actions: wireActions, tempToProv: localMap });
      scheduleFlush();
    }

    return localMap;
  }, [publish, readOnly, scheduleFlush, setErrorSafe]);

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
  const rootId = useRef(doc.nodes.find((n) => n.parentId === null)?.id ?? null);

  // 同步 rootId
  useEffect(() => {
    rootId.current = doc.nodes.find((n) => n.parentId === null)?.id ?? null;
  }, [doc]);

  const addChild = useCallback((parentId?: string | null) => {
    const pid = parentId ?? selectedId ?? rootId.current;
    if (!pid) return;
    const temp = newClientTempId();
    const map = commit([{ op: 'add_node', id: temp, parentId: pid, text: '' }], 'user');
    const nid = map?.[temp];
    if (nid) {
      setSelectedIdState(nid);
      setEditingId(nid);
    }
  }, [commit, selectedId]);

  const addSibling = useCallback((nodeId?: string | null) => {
    const id = nodeId ?? selectedId ?? rootId.current;
    if (!id) return;
    const node = indexNodes(docRef.current.nodes).get(id);
    if (!node) return;
    if (node.parentId === null) {
      addChild(id);
      return;
    }
    const index = orderedChildren(docRef.current.nodes, node.parentId).findIndex((n) => n.id === id);
    const temp = newClientTempId();
    const map = commit(
      [{ op: 'add_node', id: temp, parentId: node.parentId, text: '', order: index + 1 }],
      'user',
    );
    const nid = map?.[temp];
    if (nid) {
      setSelectedIdState(nid);
      setEditingId(nid);
    }
  }, [addChild, commit, selectedId]);

  const deleteNode = useCallback((id?: string | null) => {
    const target = id ?? selectedId;
    if (!target) return;
    const node = indexNodes(docRef.current.nodes).get(target);
    if (!node || node.parentId === null) return;
    setEditingId((cur) => (cur === target ? null : cur));
    setSelectedIdState((cur) => (cur === target ? null : cur));
    commit([{ op: 'delete_node', id: target }], 'user');
  }, [commit, selectedId]);

  const toggleCollapsed = useCallback((id: string) => {
    const node = indexNodes(docRef.current.nodes).get(id);
    if (!node) return;
    commit([{ op: 'set_collapsed', id, collapsed: !(node.collapsed === true) }], 'user');
  }, [commit]);

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

  // ---------- mind-elixir onChangeData（防抖）/ 代码面板（立即）入口 ----------
  const normalizeDoc = useCallback((target: MindmapDoc): MindmapDoc => ({
    nodes: target.nodes.map((n) => ({ ...n, x: 0, y: 0 })),
  }), []);

  const adoptUserTarget = useCallback((target: MindmapDoc) => {
    if (readOnly) return;
    const normalized = normalizeDoc(target);
    // 缓存最新目标，防抖到期后一次性 commit（合并高频 operation 噪声）
    pendingDocRef.current = normalized;
    if (pendingCommitTimerRef.current) clearTimeout(pendingCommitTimerRef.current);
    pendingCommitTimerRef.current = setTimeout(() => {
      const latest = pendingDocRef.current;
      pendingDocRef.current = null;
      if (!latest) return;
      try {
        commit(diffDocs(docRef.current, latest), 'user');
      } catch (e) {
        console.error('[mindmap] adopt target failed', e);
        setErrorSafe('saveFailed');
      }
    }, ADOPT_DEBOUNCE_MS);
  }, [commit, normalizeDoc, readOnly, setErrorSafe]);

  const applyCodeTarget = useCallback((target: MindmapDoc) => {
    if (readOnly) return;
    // 代码面板"应用"是显式用户操作，立即 commit；同时取消任何 pending 的防抖 commit
    if (pendingCommitTimerRef.current) {
      clearTimeout(pendingCommitTimerRef.current);
      pendingCommitTimerRef.current = null;
    }
    const normalized = normalizeDoc(target);
    try {
      commit(diffDocs(docRef.current, normalized), 'user');
    } catch (e) {
      console.error('[mindmap] apply code target failed', e);
      setErrorSafe('saveFailed');
    }
  }, [commit, normalizeDoc, readOnly, setErrorSafe]);

  const applyExternalDiff = useCallback((
    actions: MindmapAction[],
    serverIdMap: Record<string, string> | undefined,
    version: number | undefined,
    options?: { intoHistory?: boolean },
  ) => {
    try {
      if (options?.intoHistory) {
        pastRef.current.push(docRef.current);
        if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
        futureRef.current = [];
        setHistoryTick((tick) => tick + 1);
      }
      const { doc: applied, idMap: localMap } = applyActions(docRef.current, actions);
      let next: MindmapDoc = { nodes: applied.nodes.map((n) => ({ ...n, x: 0, y: 0 })) };
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
    } catch (e) {
      console.error('[mindmap] external diff rejected, reload required', e);
      setErrorSafe('conflict');
    }
  }, [publish, setErrorSafe]);

  // ---------- 全量重载（AI 事务撤销等外部非增量变更） ----------
  const reloadFromServer = useCallback(async () => {
    try {
      const info = await usePaperMindStore.getState()
        .loadMindmapDoc(mapId, workspaceId, true);
      queueRef.current = [];
      versionRef.current = info.version;
      const next: MindmapDoc = { nodes: info.nodes.map((n) => ({ ...n, x: 0, y: 0 })) };
      publish(next, info.version);
      pruneMindmapBuffer(mapId, info.version);
      setErrorSafe(null);
    } catch (e) {
      console.error('[mindmap] reload from server failed', e);
      setErrorSafe('saveFailed');
    }
  }, [mapId, workspaceId, publish, setErrorSafe]);

  // 订阅外部已提交事件（Explore「加入导图」/ AI SSE）
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
    return () => {
      offCommit();
      offReload();
    };
  }, [mapId, applyExternalDiff, reloadFromServer]);

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
    attachPaper,
    undo,
    redo,
    adoptUserTarget,
    applyCodeTarget,
    applyExternalDiff,
    reloadFromServer,
  };
}
