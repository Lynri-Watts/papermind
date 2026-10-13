/**
 * 思维导图工作区（填充父容器的非模态主区）。
 *
 * 由原 MindmapDock 浮层主体抽出，供 Explore 中栏常驻使用：
 * - 有选中导图：直接进入可编辑画布（工具栏/代码面板/AI 落图能力与图库页一致）；
 * - 无选中：快速新建入口；
 * - paper 节点点击行为由父级决定（Explore 内弹论文详情）。
 *
 * 作用域数据（列表/选中项/加载错误）由父级通过 ``useMindmapScope`` 统一持有，
 * 与左侧 MindmapGallerySidebar 共享同一份状态。
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, FolderOpen, Globe, ListTree, Loader2, Plus, Workflow, X } from 'lucide-react';
import MindmapCanvas from './MindmapCanvas';
import type { MindmapScopeState } from './useMindmapScope';
import { MINDMAP_TYPE, diagramLabelKey } from '../../lib/mindmap';
import { usePaperMindStore } from '../../store';

export interface MindmapWorkAreaProps {
  /** 作用域：当前工作区 id 或 null=全局 */
  scopeWs: string | null;
  /** useMindmapScope(scopeWs) 的返回（与侧栏共享） */
  scope: MindmapScopeState;
  /** 快速新建导图的默认标题（通常是检索词/工作区名） */
  defaultMapTitle: string;
  /** 点击 paper 节点 */
  onOpenPaper: (paperId: string) => void;
  /** 可选：跳转全屏图库页（Explore 顶栏「图库」按钮） */
  onOpenGallery?: () => void;
  /** 容器附加类名 */
  className?: string;
}

const MindmapWorkArea: React.FC<MindmapWorkAreaProps> = ({
  scopeWs,
  scope,
  defaultMapTitle,
  onOpenPaper,
  onOpenGallery,
  className = '',
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  const { metas, activeId, activeMeta, error, reload } = scope;
  const workspaces = usePaperMindStore((s) => s.workspaces);
  const createMindmap = usePaperMindStore((s) => s.createMindmap);
  const setActiveMindmapId = usePaperMindStore((s) => s.setActiveMindmapId);

  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

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

  const headerError = error ?? actionError;

  return (
    <div className={`flex h-full min-w-0 flex-col bg-background ${className}`}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <ListTree size={15} className="shrink-0 text-textSecondary" />
        {activeMeta ? (
          <span className="min-w-0 truncate text-sm font-medium text-text">{activeMeta.title}</span>
        ) : (
          <span className="text-sm font-medium text-text">{t('dock.title')}</span>
        )}
        {activeMeta?.diagramType && activeMeta.diagramType !== MINDMAP_TYPE && (
          <Workflow
            size={12}
            className="shrink-0 text-primary"
            aria-label={t('mindmap:diagram.badgeTitle', {
              type: (diagramLabelKey(activeMeta.diagramType)
                ? t(`mindmap:diagram.kind.${diagramLabelKey(activeMeta.diagramType)}`)
                : activeMeta.diagramType),
            })}
          />
        )}
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
                        {m.diagramType && m.diagramType !== MINDMAP_TYPE ? (
                          <Workflow
                            size={12}
                            className="shrink-0 text-primary"
                            aria-label={t('mindmap:diagram.badgeTitle', {
                              type: (diagramLabelKey(m.diagramType)
                                ? t(`mindmap:diagram.kind.${diagramLabelKey(m.diagramType)}`)
                                : m.diagramType),
                            })}
                          />
                        ) : (
                          <ListTree size={12} className="shrink-0 opacity-60" />
                        )}
                        <span className="truncate">{m.title}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {onOpenGallery && (
            <button
              type="button"
              onClick={onOpenGallery}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-textSecondary transition-colors hover:bg-white/5 hover:text-text"
            >
              {t('dock.openGallery')}
            </button>
          )}
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
            onOpenPaper={onOpenPaper}
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
  );
};

export default MindmapWorkArea;
