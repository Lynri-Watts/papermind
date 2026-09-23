/**
 * 「加入导图」按钮（Explore 结果卡 / 论文详情 / 上下文卡共用）。
 *
 * - 写入当前作用域的选中导图；没有则按 defaultMapTitle 自动新建；
 * - 已在导图中的论文（本地缓存可判定时）显示为完成态；服务端另有幂等保护；
 * - 成功/失败结果通过 onResult 回传，由宿主决定 toast 等呈现；不耦合任何页面。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ListTree, Loader2 } from 'lucide-react';
import { addPaperToActiveMindmap, type AddPaperOutcome } from '../../lib/mindmap/externalActions';
import { usePaperMindStore } from '../../store';

export interface AddToMindmapResultPayload {
  outcome: AddPaperOutcome | null;
  /** 已本地化、可直接展示的消息 */
  message: string;
  kind: 'added' | 'created' | 'duplicated' | 'error';
}

export interface AddToMindmapButtonProps {
  paperId: string;
  paperTitle: string;
  /** 自动新建导图时的默认标题（如检索词） */
  defaultMapTitle: string;
  onResult?: (payload: AddToMindmapResultPayload) => void;
  /** 图标按钮（默认）或带文字的小按钮 */
  withLabel?: boolean;
  className?: string;
  stopPropagation?: boolean;
}

const AddToMindmapButton: React.FC<AddToMindmapButtonProps> = ({
  paperId,
  paperTitle,
  defaultMapTitle,
  onResult,
  withLabel = false,
  className,
  stopPropagation = true,
}) => {
  const { t } = useTranslation('mindmap');
  const activeWorkspaceId = usePaperMindStore((s) => s.activeWorkspaceId);
  const mindmapDocs = usePaperMindStore((s) => s.mindmapDocs);
  const activeWsMindmapId = usePaperMindStore((s) => s.activeWsMindmapId);
  const activeGlobalMindmapId = usePaperMindStore((s) => s.activeGlobalMindmapId);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // 当前选中导图的文档缓存里已含同一 paperId → 完成态（未缓存时不预判，服务端幂等兜底）
  const alreadyInMap = useMemo(() => {
    const activeId = activeWorkspaceId ? activeWsMindmapId : activeGlobalMindmapId;
    const doc = activeId ? mindmapDocs[activeId] : null;
    return Boolean(doc?.nodes.some((n) => n.kind === 'paper' && n.paperId === paperId));
  }, [activeWorkspaceId, activeWsMindmapId, activeGlobalMindmapId, mindmapDocs, paperId]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await addPaperToActiveMindmap(
        { id: paperId, title: paperTitle },
        { workspaceId: activeWorkspaceId ?? null, defaultMapTitle }
      );
      const kind = outcome.duplicated ? 'duplicated' : outcome.created ? 'created' : 'added';
      const message = t(`addToMap.notify${kind === 'added' ? 'Added' : kind === 'created' ? 'Created' : 'Duplicated'}`, {
        title: outcome.mapTitle,
      });
      if (!outcome.duplicated) {
        setDone(true);
        window.setTimeout(() => setDone(false), 1800);
      }
      onResult?.({ outcome, message, kind });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      onResult?.({ outcome: null, message: t('addToMap.failed', { message: raw }), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }, [busy, paperId, paperTitle, activeWorkspaceId, defaultMapTitle, t, onResult]);

  const resolvedDone = done || alreadyInMap;
  const title = resolvedDone ? t('addToMap.added') : t('addToMap.add');

  if (withLabel) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        title={title}
        className={className ?? 'flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-textSecondary transition-colors hover:border-primary/40 hover:text-text disabled:opacity-50'}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : resolvedDone ? <Check size={14} /> : <ListTree size={14} />}
        {busy ? t('addToMap.adding') : resolvedDone ? t('addToMap.added') : t('addToMap.add')}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={title}
      aria-label={title}
      className={className ?? 'p-1 rounded-lg transition-colors disabled:opacity-40'}
    >
      {busy
        ? <Loader2 size={16} className="animate-spin text-primary" />
        : resolvedDone
          ? <ListTree size={16} className="text-accent" />
          : <ListTree size={16} className="text-textSecondary hover:text-primary" />}
    </button>
  );
};

export default AddToMindmapButton;
