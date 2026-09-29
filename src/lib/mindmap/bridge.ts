/**
 * 思维导图外部事件总线。
 *
 * 画布之外的写入方（Explore「加入导图」、Task 11 的 AI SSE）不能直接接触画布内的
 * useMindmapEditor 状态，但它们的编辑已经提交到服务端；打开的画布需要即时跟上。
 *
 * 约定：
 * - 写入方先正常走 /actions 提交并更新 store 缓存，再 emit 一个「已提交事件」；
 * - 事件带服务端版本号：画布按 version 去重（强制刷新/后挂载的画布文档已包含该版本）；
 * - 事件按 mapId 缓冲最近 20 条，画布挂载订阅时回放（同样按 version 过滤），
 *   这样「先加入导图、后打开页面」也不会重复添加。
 */
import type { MindmapAction } from '../../types';

export interface CommittedMindmapEvent {
  /** 事件提交后的服务端文档版本；画布版本 ≥ 它即跳过 */
  version: number;
  actions: MindmapAction[];
  /** add_node 临时 ID → 服务端正式 ID（本地即时应用后做 ID 对账） */
  idMap?: Record<string, string>;
  /** user=界面发起（进用户撤销栈）；ai=AI 事务编辑（不进栈，可按事务撤销） */
  origin: 'user' | 'ai';
}

type Listener = (event: CommittedMindmapEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const buffers = new Map<string, CommittedMindmapEvent[]>();
const BUFFER_LIMIT = 20;

/** 提交成功后广播；缓冲一份供后挂载的画布回放。 */
export function emitMindmapCommitted(mapId: string, event: CommittedMindmapEvent): void {
  const arr = buffers.get(mapId) ?? [];
  arr.push(event);
  if (arr.length > BUFFER_LIMIT) arr.splice(0, arr.length - BUFFER_LIMIT);
  buffers.set(mapId, arr);
  listeners.get(mapId)?.forEach((cb) => cb(event));
}

/** 订阅某张导图的已提交事件；立即回放缓冲（处理函数须按 version 去重）。 */
export function subscribeMindmap(mapId: string, listener: Listener): () => void {
  let set = listeners.get(mapId);
  if (!set) {
    set = new Set();
    listeners.set(mapId, set);
  }
  set.add(listener);
  for (const event of buffers.get(mapId) ?? []) listener(event);
  return () => {
    set?.delete(listener);
  };
}

/** 画布文档已到达/超过某版本后，清理更旧的缓冲。 */
export function pruneMindmapBuffer(mapId: string, version: number): void {
  const arr = buffers.get(mapId);
  if (!arr) return;
  const kept = arr.filter((e) => e.version > version);
  if (kept.length === 0) buffers.delete(mapId);
  else if (kept.length !== arr.length) buffers.set(mapId, kept);
}

/**
 * 自动布局信号（一轮 AI 流式编辑结束）。
 *
 * 流式增补期间画布用同步 tidy-tree 即时补位（不打断打字机式落图）；一轮结束后
 * QAPanel 对本次涉及的导图发此信号，已挂载且「本会话挂载时全节点无坐标、用户
 * 未手动动过几何」的画布再用 mermaid 引擎做一次全量排布。不缓冲：后挂载画布
 * 由挂载时的「全零检测」覆盖，旧导图有历史坐标不应被信号重排。
 */
export type MindmapAutoLayoutListener = () => void;

const autoLayoutListeners = new Map<string, Set<MindmapAutoLayoutListener>>();

export function emitMindmapAutoLayout(mapId: string): void {
  autoLayoutListeners.get(mapId)?.forEach((cb) => cb());
}

export function subscribeMindmapAutoLayout(mapId: string, listener: MindmapAutoLayoutListener): () => void {
  let set = autoLayoutListeners.get(mapId);
  if (!set) {
    set = new Set();
    autoLayoutListeners.set(mapId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/**
 * 全量重载信号（AI 事务撤销等无法用前向动作表达的外部变更）。
 * 画布收到后强制拉取服务端文档并对账；后挂载的画布本就会读最新文档，无需缓冲。
 */
export type MindmapReloadListener = (version: number) => void;

const reloadListeners = new Map<string, Set<MindmapReloadListener>>();

export function emitMindmapReload(mapId: string, version: number): void {
  reloadListeners.get(mapId)?.forEach((cb) => cb(version));
}

export function subscribeMindmapReload(mapId: string, listener: MindmapReloadListener): () => void {
  let set = reloadListeners.get(mapId);
  if (!set) {
    set = new Set();
    reloadListeners.set(mapId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}
