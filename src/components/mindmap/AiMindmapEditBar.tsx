/**
 * 回答末尾的「AI 修改了思维导图」提示条（FR-6.4）。
 *
 * 一问一事务：本次回答对每张导图的编辑共享一个 transactionId，
 * 用户可逐张导图「撤销本次 AI 修改」（服务端字段级逆向，修订表持久化），
 * 或「保留」关闭提示。撤销成功后经 bridge 通知打开的画布全量重载。
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ListTree, Loader2, Undo2, X } from 'lucide-react';
import type { ChatMindmapEdit } from '../../types';
import { undoMindmapAi } from '../../api';
import { mindmapScopeKey, usePaperMindStore } from '../../store';
import { emitMindmapReload } from '../../lib/mindmap/bridge';

export interface AiMindmapEditBarProps {
  edits: ChatMindmapEdit[];
  /** 生成中：只显示「AI 正在编辑」，不允许撤销（事务尚未结束） */
  locked?: boolean;
  /** 本地状态回写（撤销/保留），由父组件落到消息上持久化 */
  onChange: (mapId: string, patch: Partial<ChatMindmapEdit>) => void;
}

const AiMindmapEditBar: React.FC<AiMindmapEditBarProps> = ({ edits, locked = false, onChange }) => {
  const { t } = useTranslation('mindmap');
  const mindmapsByScope = usePaperMindStore((s) => s.mindmapsByScope);
  const setActiveMindmapId = usePaperMindStore((s) => s.setActiveMindmapId);
  const setCurrentView = usePaperMindStore((s) => s.setCurrentView);
  const cacheMindmapDoc = usePaperMindStore((s) => s.cacheMindmapDoc);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});

  const resolveTitle = useCallback((edit: ChatMindmapEdit): string => {
    const key = mindmapScopeKey(edit.workspaceId ?? null);
    return mindmapsByScope[key]?.find((m) => m.id === edit.mapId)?.title
      ?? t('ai.fallbackTitle');
  }, [mindmapsByScope, t]);

  const handleUndo = useCallback(async (edit: ChatMindmapEdit) => {
    setBusyId(edit.mapId);
    setErrorMap((m) => {
      const next = { ...m };
      delete next[edit.mapId];
      return next;
    });
    try {
      const result = await undoMindmapAi(edit.mapId, {
        transactionId: edit.transactionId,
        workspaceId: edit.workspaceId ?? null,
      });
      cacheMindmapDoc(result.mindmap);
      emitMindmapReload(edit.mapId, result.mindmap.version);
      onChange(edit.mapId, { undone: true, version: result.mindmap.version });
    } catch (e) {
      setErrorMap((m) => ({
        ...m,
        [edit.mapId]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusyId(null);
    }
  }, [cacheMindmapDoc, onChange]);

  const handleOpen = useCallback((edit: ChatMindmapEdit) => {
    setActiveMindmapId(edit.workspaceId ?? null, edit.mapId);
    setCurrentView('mindmaps');
  }, [setActiveMindmapId, setCurrentView]);

  const visible = edits.filter((e) => !e.kept);
  if (visible.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {visible.map((edit) => {
        const title = resolveTitle(edit);
        const failed = errorMap[edit.mapId];
        return (
          <div
            key={edit.mapId}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-text"
          >
            <ListTree size={14} className="shrink-0 text-primary" />
            {edit.undone ? (
              <span className="flex items-center gap-1 font-medium text-accent">
                <Check size={13} />
                {t('ai.undone', { title })}
              </span>
            ) : locked ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-primary">
                <Loader2 size={12} className="animate-spin" />
                <span className="truncate">{t('ai.editingLive')}</span>
              </span>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">{t('ai.edited', { title })}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleUndo(edit)}
                    disabled={busyId === edit.mapId}
                    className="flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 font-medium text-primary ring-1 ring-primary/30 transition-colors hover:bg-primary/25 disabled:opacity-50"
                  >
                    {busyId === edit.mapId
                      ? <Loader2 size={12} className="animate-spin" />
                      : <Undo2 size={12} />}
                    {t('ai.undo')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(edit.mapId, { kept: true })}
                    className="rounded-md px-2 py-1 text-textSecondary transition-colors hover:bg-white/10 hover:text-text"
                  >
                    {t('ai.keep')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpen(edit)}
                    className="rounded-md px-2 py-1 text-textSecondary transition-colors hover:bg-white/10 hover:text-text"
                    title={t('ai.openMap')}
                  >
                    {t('ai.open')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(edit.mapId, { kept: true })}
                    className="rounded-md p-1 text-textSecondary/70 transition-colors hover:bg-white/10 hover:text-text"
                    aria-label={t('ai.close')}
                  >
                    <X size={12} />
                  </button>
                </div>
              </>
            )}
            {failed && (
              <span className="w-full text-[11px] text-red-400">
                {t('ai.undoFailed', { message: failed })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default AiMindmapEditBar;
