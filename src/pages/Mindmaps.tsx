/**
 * 思维导图全屏图库页（FR-1 / FR-4）。
 *
 * - 左侧图库：MindmapGallerySidebar（与 Explore 页共用）——按作用域隔离的
 *   导图列表、新建、导入 mermaid、重命名、删除；当前选中导图随工作区快照持久化
 *   （store.activeWsMindmapId / activeGlobalMindmapId）。
 * - 右侧主区：选中即全屏挂载 MindmapCanvas（换图整体重挂载，编辑/撤销/队列状态干净）；
 *   未选中显示理念引导空态。
 * - paper 节点点击 → 打开阅读器标签并切到研究页（节点文本即论文标题）。
 *
 * Explore 页把同一套索引/画布内嵌为常驻三栏；本页保留全屏管理与「粘贴 mermaid
 * 源码建图」的创建对话框。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ListTree,
  Loader2,
  Plus,
  Workflow,
  X,
} from 'lucide-react';
import MindmapCanvas from '../components/mindmap/MindmapCanvas';
import MindmapGallerySidebar from '../components/mindmap/MindmapGallerySidebar';
import { useMindmapScope } from '../components/mindmap/useMindmapScope';
import {
  MINDMAP_TYPE,
  DIAGRAM_TYPE_CHOICES,
  diagramLabelKey,
  diagramStarter,
} from '../lib/mindmap';
import { usePaperMindStore } from '../store';

/** 主区头部的图类型徽标：mindmap 不显示；经典类型显示本地化名称 */
const HeaderDiagramBadge: React.FC<{ type: string }> = ({ type }) => {
  const { t } = useTranslation('mindmap');
  if (!type || type === MINDMAP_TYPE) return null;
  const key = diagramLabelKey(type);
  const label = key ? t(`diagram.kind.${key}`) : type;
  return (
    <span
      title={t('diagram.badgeTitle', { type: label })}
      className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary"
    >
      <Workflow size={11} />
      {label}
    </span>
  );
};

export default function Mindmaps() {
  const { t } = useTranslation('mindmap');
  const activeWorkspaceId = usePaperMindStore((s) => s.activeWorkspaceId);
  const mindmapDocs = usePaperMindStore((s) => s.mindmapDocs);
  const createMindmap = usePaperMindStore((s) => s.createMindmap);
  const importMindmap = usePaperMindStore((s) => s.importMindmap);
  const openReaderTab = usePaperMindStore((s) => s.openReaderTab);
  const setCurrentView = usePaperMindStore((s) => s.setCurrentView);

  // 当前浏览的作用域：默认活跃工作区，可切到全局；工作区切换时跟随
  const [scopeWs, setScopeWs] = useState<string | null>(activeWorkspaceId ?? null);
  useEffect(() => {
    setScopeWs(activeWorkspaceId ?? null);
  }, [activeWorkspaceId]);

  const {
    metas, activeId: selectedId, activeMeta: selectedMeta, error: loadError, reload,
  } = useMindmapScope(scopeWs);

  const [busy, setBusy] = useState(false);
  const [codePanelOpen, setCodePanelOpen] = useState(false);

  // 新建对话框：kind='mindmap' 或 DIAGRAM_TYPE_CHOICES 的 label key；
  // source 非空时一律按源码 detect 的实际类型创建（下拉仅用于生成骨架）
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createKind, setCreateKind] = useState<string>(MINDMAP_TYPE);
  const [createSource, setCreateSource] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const failMessage = useCallback((e: unknown) => {
    if (e instanceof Error) return e.message;
    return String(e);
  }, []);

  const openCreate = useCallback(() => {
    setCreateTitle(t('gallery.newMapTitle'));
    setCreateKind(MINDMAP_TYPE);
    setCreateSource('');
    setCreateError(null);
    setShowCreate(true);
  }, [t]);

  const submitCreate = useCallback(async () => {
    const title = createTitle.trim();
    if (!title) {
      setCreateError(t('gallery.titleRequired'));
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      const src = createSource.trim();
      if (src) {
        // 粘贴了源码：图类型以源码首声明为准（下拉只作骨架生成，不参与提交）
        await importMindmap({ mermaid: createSource, title, workspaceId: scopeWs });
      } else if (createKind === MINDMAP_TYPE) {
        await createMindmap({ title, rootText: title, workspaceId: scopeWs });
      } else {
        const starter = diagramStarter(createKind, title);
        if (!starter) {
          setCreateError(t('gallery.createKindUnsupported'));
          return;
        }
        await importMindmap({ mermaid: starter, title, workspaceId: scopeWs });
      }
      setShowCreate(false);
    } catch (e) {
      setCreateError(t('gallery.operationFailed', { message: failMessage(e) }));
    } finally {
      setBusy(false);
    }
  }, [
    createTitle, createSource, createKind, createMindmap, importMindmap,
    scopeWs, t, failMessage,
  ]);

  const handleOpenPaper = useCallback((paperId: string) => {
    const doc = selectedId ? mindmapDocs[selectedId] : null;
    const node = doc?.nodes.find((n) => n.kind === 'paper' && n.paperId === paperId);
    openReaderTab(paperId, node?.text || paperId);
    setCurrentView('research');
  }, [mindmapDocs, openReaderTab, selectedId, setCurrentView]);

  return (
    <div className="flex h-full bg-background">
      <MindmapGallerySidebar
        className="w-72"
        scopeWs={scopeWs}
        onScopeChange={setScopeWs}
        metas={metas}
        activeId={selectedId}
        loadError={loadError}
        onReload={reload}
        onCreate={openCreate}
      />

      {/* ---------- 主区 ---------- */}
      <main className="flex min-w-0 flex-1 flex-col">
        {selectedMeta && selectedId ? (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
              <ListTree size={15} className="text-textSecondary" />
              <span className="truncate text-sm font-medium text-text">{selectedMeta.title}</span>
              {selectedMeta.diagramType !== MINDMAP_TYPE && (
                <HeaderDiagramBadge type={selectedMeta.diagramType} />
              )}
            </div>
            <div className="min-h-0 flex-1">
              <MindmapCanvas
                key={selectedId}
                mapId={selectedId}
                workspaceId={scopeWs}
                showCodePanel={codePanelOpen}
                onToggleCodePanel={() => setCodePanelOpen((v) => !v)}
                onOpenPaper={handleOpenPaper}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
              <ListTree size={30} className="text-primary" />
            </div>
            <h3 className="mt-5 text-lg font-semibold text-text">{t('gallery.heroTitle')}</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-textSecondary">{t('gallery.heroDesc')}</p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={openCreate}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                {t('gallery.newMap')}
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ---------- 新建导图对话框 ---------- */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => { if (!busy) setShowCreate(false); }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-text">{t('gallery.createTitle')}</h3>
              <button
                type="button"
                onClick={() => { if (!busy) setShowCreate(false); }}
                className="rounded p-1 text-textSecondary hover:text-text"
              >
                <X size={15} />
              </button>
            </div>
            <div className="space-y-3 px-4 py-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-textSecondary">
                  {t('gallery.createTitleLabel')}
                </label>
                <input
                  autoFocus
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate(); }}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-text outline-none focus:border-primary/50"
                  placeholder={t('gallery.newMapTitle')}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-textSecondary">
                  {t('gallery.createKindLabel')}
                </label>
                <select
                  value={createKind}
                  onChange={(e) => {
                    const kind = e.target.value;
                    setCreateKind(kind);
                    if (kind === MINDMAP_TYPE) {
                      setCreateSource('');
                    } else {
                      setCreateSource(
                        diagramStarter(kind, createTitle.trim() || t('gallery.newMapTitle')) ?? ''
                      );
                    }
                  }}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-text outline-none focus:border-primary/50"
                >
                  <option value={MINDMAP_TYPE}>{t('diagram.kind.mindmap')}</option>
                  {DIAGRAM_TYPE_CHOICES.map(([key]) => (
                    <option key={key} value={key}>{t(`diagram.kind.${key}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-textSecondary">
                  {t('gallery.createSourceLabel')}
                </label>
                <textarea
                  value={createSource}
                  onChange={(e) => setCreateSource(e.target.value)}
                  spellCheck={false}
                  rows={8}
                  placeholder={t('gallery.createSourcePlaceholder')}
                  className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs leading-5 text-text outline-none focus:border-primary/50"
                />
                <p className="mt-1 text-[11px] leading-4 text-textSecondary/70">
                  {t('gallery.createSourceHint')}
                </p>
              </div>
              {createError && (
                <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-300">
                  {createError}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-textSecondary transition-colors hover:bg-white/5 hover:text-text disabled:opacity-50"
              >
                {t('gallery.createCancel')}
              </button>
              <button
                type="button"
                onClick={() => void submitCreate()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                {t('gallery.createSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
