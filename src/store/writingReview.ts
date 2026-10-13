/**
 * AI 写作修订审核状态（独立于主 store 的高内聚模块）。
 *
 * 真源在后端 writing_revisions 表；本模块只缓存「待审（pending）」修订：
 * - SSE document_diff 到达时先放临时候选（id/newText/oldText 齐全，足够内联高亮）；
 * - 挂载工作区、一轮流结束、整事务操作后调 hydrate() 与后端对账（服务端为超集，
 *   直接整体替换，保证跨刷新/多标签页一致）；
 * - 接受/拒绝/回滚的物理结果经 REST 同步，文件内容替换由订阅本 store 的
 *   WritingWorkspace 负责（filePatch 携带回滚后的整文件内容，避免二次请求）。
 */
import { create } from 'zustand';
import type {
  WritingCompileEvent,
  WritingDiffEvent,
  WritingCreatedEvent,
  WritingRevision,
  WritingRejectResult,
  WritingRollbackResult,
} from '../types';
import {
  acceptWritingHunk,
  acceptWritingTransaction,
  listWritingRevisions,
  rejectWritingHunk,
  rollbackWritingTransaction,
} from '../api';

/** 回滚后需要编辑器直接替换的文件补丁（nonce 供 useEffect 消费去重） */
export interface WritingFilePatch {
  nonce: number;
  files: WritingRollbackResult['files'];
  deleted: string[];
  kept: string[];
  /** 部分冲突时的提示文案（ok=false） */
  error?: string;
}

interface WritingReviewState {
  /** wsId → (revId → pending 修订) */
  revisionsByWs: Record<string, Record<number, WritingRevision>>;
  /**
   * 服务端文件相对本地可能出现 AI 新内容的信号（hydrate 对账 / SSE diff 时递增）。
   * WritingWorkspace 订阅后按 pending 修订涉及的路径 re-read 并以远程事务灌入编辑器。
   */
  syncNonceByWs: Record<string, number>;
  /** document_created 信号（文件树刷新去重靠 nonce 递增） */
  createdNonceByWs: Record<string, number>;
  /** compile_document 结果（编译面板/PDF 刷新） */
  compileByWs: Record<string, { nonce: number; event: WritingCompileEvent }>;
  /** 回滚/单块拒绝产生的文件内容补丁（按 ws） */
  filePatchByWs: Record<string, WritingFilePatch>;
  /** 一轮 RAG 流是否进行中（期间挂起写作侧空闲自动编译） */
  aiStreaming: boolean;
  /** 逐块操作进行中的 revId（按钮转圈/禁用） */
  busyHunk: number | null;
  /** 整事务操作进行中的 txn id */
  busyTxn: string | null;
  /** 最近一次审核操作错误（由调用方读取后展示；不自动消失） */
  lastError: string | null;

  hydrate: (wsId: string) => Promise<void>;
  applyDiff: (wsId: string, event: WritingDiffEvent) => void;
  applyCreated: (wsId: string, event: WritingCreatedEvent) => void;
  applyCompile: (wsId: string, event: WritingCompileEvent) => void;
  setAiStreaming: (active: boolean) => void;
  acceptHunk: (wsId: string, revId: number) => Promise<boolean>;
  rejectHunk: (wsId: string, revId: number) => Promise<WritingRejectResult | null>;
  acceptTransaction: (wsId: string, txn: string) => Promise<number>;
  rollbackTransaction: (wsId: string, txn: string) => Promise<WritingRollbackResult | null>;
  /** 切换工作区：清掉旧工作区的缓存（hydrate 会按新 ws 重新拉） */
  resetWs: (wsId: string) => void;
}

let patchNonce = 0;
let syncNonce = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useWritingReviewStore = create<WritingReviewState>((set, get) => ({
  revisionsByWs: {},
  syncNonceByWs: {},
  createdNonceByWs: {},
  compileByWs: {},
  filePatchByWs: {},
  aiStreaming: false,
  busyHunk: null,
  busyTxn: null,
  lastError: null,

  hydrate: async (wsId) => {
    try {
      const rows = await listWritingRevisions(wsId);
      const map: Record<number, WritingRevision> = {};
      for (const r of rows) map[r.id] = r;
      syncNonce += 1;
      set((state) => ({
        revisionsByWs: { ...state.revisionsByWs, [wsId]: map },
        // 跨刷新/多标签页对账后，若存在 pending 修订，磁盘内容可能新于本地缓冲区
        syncNonceByWs: { ...state.syncNonceByWs, [wsId]: syncNonce },
      }));
    } catch (err) {
      // 后端离线等：保留现有缓存，只记录错误，不清空待审标记
      set({ lastError: errorMessage(err) });
    }
  },

  applyDiff: (wsId, event) => {
    syncNonce += 1;
    set((state) => {
      const prev = state.revisionsByWs[wsId] ?? {};
      const next = { ...prev };
      for (const hunk of event.hunks) {
        // SSE 只够渲染所需字段；seq/hash 缺失的部分用占位，hydrate 后以服务端为准
        if (next[hunk.id]) continue;
        next[hunk.id] = {
          id: hunk.id,
          runId: '',
          transactionId: event.transactionId,
          seq: 0,
          kind: hunk.kind,
          path: event.path,
          oldText: hunk.oldText,
          newText: hunk.newText,
          baseHash: '',
          newHash: event.newHash,
          status: 'pending',
          createdAt: '',
        };
      }
      return {
        revisionsByWs: { ...state.revisionsByWs, [wsId]: next },
        // AI 已把该文件新内容落盘：通知 WritingWorkspace re-read 后远程灌入编辑器
        syncNonceByWs: { ...state.syncNonceByWs, [wsId]: syncNonce },
      };
    });
  },

  applyCreated: (wsId) => {
    set((state) => ({
      createdNonceByWs: {
        ...state.createdNonceByWs,
        [wsId]: (state.createdNonceByWs[wsId] ?? 0) + 1,
      },
    }));
  },

  applyCompile: (wsId, event) => {
    set((state) => {
      const prev = state.compileByWs[wsId]?.nonce ?? 0;
      return {
        compileByWs: {
          ...state.compileByWs,
          [wsId]: { nonce: prev + 1, event },
        },
      };
    });
  },

  setAiStreaming: (active) => set({ aiStreaming: active }),

  acceptHunk: async (wsId, revId) => {
    set({ busyHunk: revId, lastError: null });
    try {
      await acceptWritingHunk(wsId, revId);
      set((state) => {
        const prev = state.revisionsByWs[wsId];
        if (!prev?.[revId]) return {};
        const next = { ...prev };
        delete next[revId];
        return { revisionsByWs: { ...state.revisionsByWs, [wsId]: next } };
      });
      return true;
    } catch (err) {
      set({ lastError: errorMessage(err) });
      return false;
    } finally {
      set({ busyHunk: null });
    }
  },

  rejectHunk: async (wsId, revId) => {
    set({ busyHunk: revId, lastError: null });
    try {
      const result = await rejectWritingHunk(wsId, revId);
      set((state) => {
        const prev = state.revisionsByWs[wsId];
        if (!prev?.[revId]) return {};
        const next = { ...prev };
        delete next[revId];
        return { revisionsByWs: { ...state.revisionsByWs, [wsId]: next } };
      });
      return result;
    } catch (err) {
      set({ lastError: errorMessage(err) });
      return null;
    } finally {
      set({ busyHunk: null });
    }
  },

  acceptTransaction: async (wsId, txn) => {
    set({ busyTxn: txn, lastError: null });
    try {
      const result = await acceptWritingTransaction(wsId, txn);
      set((state) => {
        const prev = state.revisionsByWs[wsId];
        if (!prev) return {};
        const next: Record<number, WritingRevision> = {};
        for (const [id, rev] of Object.entries(prev)) {
          if (rev.transactionId !== txn) next[Number(id)] = rev;
        }
        return { revisionsByWs: { ...state.revisionsByWs, [wsId]: next } };
      });
      return result.count;
    } catch (err) {
      set({ lastError: errorMessage(err) });
      // 乐观删除可能与服务端不一致，对账兜底
      await get().hydrate(wsId);
      return 0;
    } finally {
      set({ busyTxn: null });
    }
  },

  rollbackTransaction: async (wsId, txn) => {
    set({ busyTxn: txn, lastError: null });
    try {
      const result = await rollbackWritingTransaction(wsId, txn);
      // 物理补丁先放（编辑器据此替换缓冲区），再与服务端对账剩余 pending
      patchNonce += 1;
      set((state) => ({
        filePatchByWs: {
          ...state.filePatchByWs,
          [wsId]: {
            nonce: patchNonce,
            files: result.files,
            deleted: result.deleted,
            kept: result.kept,
            ...(result.error ? { error: result.error } : {}),
          },
        },
      }));
      await get().hydrate(wsId);
      return result;
    } catch (err) {
      set({ lastError: errorMessage(err) });
      return null;
    } finally {
      set({ busyTxn: null });
    }
  },

  resetWs: (wsId) => {
    set((state) => {
      const revisionsByWs = { ...state.revisionsByWs };
      delete revisionsByWs[wsId];
      const syncNonceByWs = { ...state.syncNonceByWs };
      delete syncNonceByWs[wsId];
      const compileByWs = { ...state.compileByWs };
      delete compileByWs[wsId];
      const filePatchByWs = { ...state.filePatchByWs };
      delete filePatchByWs[wsId];
      const createdNonceByWs = { ...state.createdNonceByWs };
      delete createdNonceByWs[wsId];
      return {
        revisionsByWs, syncNonceByWs, compileByWs, filePatchByWs, createdNonceByWs,
      };
    });
  },
}));

/** 取某工作区某文件的待审修订（按 SSE 行号/seq 排序，稳定渲染） */
export function selectRevisionsForFile(
  wsId: string,
  path: string,
): WritingRevision[] {
  const map = useWritingReviewStore.getState().revisionsByWs[wsId];
  if (!map) return [];
  return Object.values(map)
    .filter((r) => r.path === path)
    .sort((a, b) => a.id - b.id);
}
