/**
 * 思维导图作用域数据 hook（图库页 / Explore 中栏共用，高内聚低耦合）。
 *
 * 封装：按作用域（工作区 / 全局）读取图库列表、当前选中项、首次加载与重试。
 * 列表与选中项的真源在 store（服务端为权威，选中态随工作区快照持久化）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MindmapMeta } from '../../types';
import { mindmapScopeKey, usePaperMindStore } from '../../store';
import { ApiRequestError } from '../../api';

export interface MindmapScopeState {
  scopeKey: string;
  /** undefined=尚未加载；空数组=已加载但为空 */
  metas: MindmapMeta[] | undefined;
  activeId: string | null;
  activeMeta: MindmapMeta | null;
  error: string | null;
  /** 强制重新拉取（错误条「重试」用） */
  reload: () => Promise<void>;
}

export function useMindmapScope(scopeWs: string | null): MindmapScopeState {
  const { t } = useTranslation('mindmap');
  const mindmapsByScope = usePaperMindStore((s) => s.mindmapsByScope);
  const activeWsMindmapId = usePaperMindStore((s) => s.activeWsMindmapId);
  const activeGlobalMindmapId = usePaperMindStore((s) => s.activeGlobalMindmapId);
  const refreshMindmaps = usePaperMindStore((s) => s.refreshMindmaps);

  const scopeKey = mindmapScopeKey(scopeWs);
  const metas = mindmapsByScope[scopeKey];
  const activeId = scopeWs ? activeWsMindmapId : activeGlobalMindmapId;
  const activeMeta = useMemo(
    () => (metas ?? []).find((m) => m.id === activeId) ?? null,
    [metas, activeId]
  );

  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setError(null);
    if (loadedRef.current.has(scopeKey)) return;
    loadedRef.current.add(scopeKey);
    let cancelled = false;
    void refreshMindmaps(scopeWs).catch((e: unknown) => {
      if (!cancelled) {
        const message = e instanceof ApiRequestError ? e.message : String(e);
        setError(t('gallery.operationFailed', { message }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, scopeWs, refreshMindmaps, t]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      await refreshMindmaps(scopeWs);
    } catch (e) {
      const message = e instanceof ApiRequestError ? e.message : String(e);
      setError(t('gallery.operationFailed', { message }));
    }
  }, [refreshMindmaps, scopeWs, t]);

  return { scopeKey, metas, activeId, activeMeta, error, reload };
}
