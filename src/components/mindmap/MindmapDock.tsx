/**
 * 思维导图浮层（Explore 内按需呼出的辅助工具，不常驻、不占分栏）。
 *
 * 与图库页（pages/Mindmaps）共享 useMindmapScope 的作用域数据与 MindmapCanvas，
 * 形态是一个居中的轻量浮层：
 * - 有选中导图：直接进入可编辑画布（工具栏/代码面板/AI 落图能力与图库页完全一致）；
 * - 无选中：新建入口 + 作用域内导图快速选择；
 * - paper 节点点击跳阅读器；
 * - 「图库」跳转全屏管理页并关闭浮层。
 * 本组件被 Explore 以 React.lazy 引入，React Flow 不进首屏主包。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, FolderOpen, Globe, ListTree, Loader2, Plus, X } from 'lucide-react';
import MindmapCanvas from './MindmapCanvas';
import { useMindmapScope } from './useMindmapScope';
import { usePaperMindStore } from '../../store';

export interface MindmapDockProps {
  /** 是否展开（关闭时不挂载画布，状态干净） */
  open: boolean;
  onClose: () => void;
  /** 作用域：当前工作区 id 或 null=全局 */
  scopeWs: string | null;
  /** 新建导图的默认标题（通常是检索词/工作区名） */
  defaultMapTitle: string;
}

const MindmapDock: React.FC<MindmapDockProps> = ({ open, onClose, scopeWs, defaultMapTitle }) => {
  const { t } = useTranslation(['mindmap', 'common']);
  const { metas, activeId, activeMeta, error, reload } = useMindmapScope(scopeWs);
  const workspaces = usePaperMindStore((s) => s.workspaces);
  const mindmapDocs = usePaperMindStore((s) => s.mindmapDocs);
  const createMindmap = usePaperMindStore((s) => s.createMindmap);
  const setActiveMindmapId = usePaperMindStore((s) => s.setActiveMindmapId);
  const openReaderTab = usePaperMindStore((s) => s.openReaderTab);
  const setCurrentView = usePaperMindStore((s) => s.setCurrentView);

  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Esc 关闭；打开时锁页面滚动
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const scopeName = scopeWs
    ? (workspaces.find((w) => w.id === scopeWs)?.name ?? t('gallery.scopeWs'))
    : t('gallery.scopeGlobal');

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setActionError(null);
    try {
      await createMindmap({ workspaceId: scopeWs, title: defaultMapTitle, rootText: defaultMapTitle });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [createMindmap, scopeWs, defaultMapTitle]);

  const handleOpenPaper = useCallback((paperId: string) => {
    const doc = activeId ? mindmapDocs[activeId] : null;
    const node = doc?.nodes.find((n) => n.kind === 'paper' && n.paperId === paperId);
    openReaderTab(paperId, node?.text || paperId);
    setCurrentView('research');
    onClose();
  }, [mindmapDocs, openReaderTab, activeId, setCurrentView, onClose]);

  const handleOpenGallery = useCallback(() => {
    onClose();
    setCurrentView('mindmaps');
  }, [onClose, setCurrentView]);

  if (!open) return null;

  const headerError = error ?? actionError;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={onClose}
    >
      <div
        className="flex h-[84vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
          <ListTree size={15} className="shrink-0 text-textSecondary" />
          <span className="text-sm font-medium text-text">{t('dock.title')}</span>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-textSecondary">
            {scopeWs === null ? <Globe size={10} /> : <FolderOpen size={10} />}
            <span className="max-w-[120px] truncate">{scopeName}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            {metas && metas.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((v) => !v)}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-textSecondary transition-colors hover:bg-white/5 hover:text-text"
                >
                  <span className="max-w-[120px] truncate">{activeMeta?.title ?? t('dock.pick')}</span>
                  <ChevronDown size={11} />
                </button>
                {switcherOpen && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setSwitcherOpen(false)} />
                    <div className="absolute right-0 top-full z-30 mt-1 max-h-72 w-56 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-xl">
                      {metas.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => { setActiveMindmapId(scopeWs, m.id); setSwitcherOpen(false); }}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/5 ${
                            m.id === activeId ? 'font-medium text-primary' : 'text-textSecondary'
                          }`}
                        >
                          <ListTree size={12} className="shrink-0 opacity-60" />
                          <span className="truncate">{m.title}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handleOpenGallery}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-textSecondary transition-colors hover:bg-white/5 hover:text-text"
            >
              {t('dock.openGallery')}
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t('common:action.close')}
              className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/5 hover:text-text"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {headerError && (
          <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{headerError}</span>
            {error && (
              <button type="button" onClick={() => void reload()} className="font-medium underline">
                {t('retry')}
              </button>
            )}
            <button type="button" onClick={() => setActionError(null)} className="text-amber-400/70 hover:text-amber-300">
              <X size={11} />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1">
          {activeMeta && activeId ? (
            <MindmapCanvas
              key={activeId}
              mapId={activeId}
              workspaceId={scopeWs}
              onOpenPaper={handleOpenPaper}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center bg-background px-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                <ListTree size={26} className="text-primary" />
              </div>
              <p className="mt-4 text-sm font-medium text-text">{t('dock.empty')}</p>
              <p className="mt-1 max-w-[240px] text-xs leading-5 text-textSecondary">{t('dock.emptyHint')}</p>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating}
                className="mt-4 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                {t('dock.newMap')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MindmapDock;
