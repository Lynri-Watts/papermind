/**
 * 思维导图导航页（FR-1 / FR-4）。
 *
 * - 左侧图库：按作用域隔离（工作区 / 全局），支持新建、导入 mermaid、重命名、删除；
 *   当前选中导图随工作区快照独立持久化（store.activeWsMindmapId / activeGlobalMindmapId）。
 * - 右侧主区：选中即全屏挂载 MindmapCanvas（换图整体重挂载，编辑/撤销/队列状态干净）；
 *   未选中显示理念引导空态。
 * - paper 节点点击 → 打开阅读器标签并切到研究页（节点文本即论文标题）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Globe,
  ListTree,
  Loader2,
  PencilLine,
  Plus,
  Trash2,
  Upload,
  Workflow,
  X,
} from 'lucide-react';
import MindmapCanvas from '../components/mindmap/MindmapCanvas';
import { useMindmapScope } from '../components/mindmap/useMindmapScope';
import { ApiRequestError } from '../api';
import {
  MINDMAP_TYPE,
  DIAGRAM_TYPE_CHOICES,
  diagramLabelKey,
  diagramStarter,
} from '../lib/mindmap';
import { usePaperMindStore } from '../store';
import type { MindmapMeta } from '../types';

interface Banner {
  text: string;
}

/** 列表/顶栏的图类型徽标：mindmap 不显示；经典类型显示本地化名称，未知类型显示原始 token */
const DiagramBadge: React.FC<{ type: string }> = ({ type }) => {
  const { t } = useTranslation('mindmap');
  if (!type || type === MINDMAP_TYPE) return null;
  const key = diagramLabelKey(type);
  const label = key ? t(`diagram.kind.${key}`) : type;
  return (
    <span
      title={t('diagram.badgeTitle', { type: label })}
      className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary"
    >
      <Workflow size={9} />
      {label}
    </span>
  );
};

export default function Mindmaps() {
  const { t, i18n } = useTranslation('mindmap');
  const activeWorkspaceId = usePaperMindStore((s) => s.activeWorkspaceId);
  const workspaces = usePaperMindStore((s) => s.workspaces);
  const mindmapDocs = usePaperMindStore((s) => s.mindmapDocs);
  const createMindmap = usePaperMindStore((s) => s.createMindmap);
  const importMindmap = usePaperMindStore((s) => s.importMindmap);
  const renameMindmapAction = usePaperMindStore((s) => s.renameMindmap);
  const deleteMindmapAction = usePaperMindStore((s) => s.deleteMindmap);
  const setActiveMindmapId = usePaperMindStore((s) => s.setActiveMindmapId);
  const openReaderTab = usePaperMindStore((s) => s.openReaderTab);
  const setCurrentView = usePaperMindStore((s) => s.setCurrentView);

  // 当前浏览的作用域：默认活跃工作区，可切到全局；工作区切换时跟随
  const [scopeWs, setScopeWs] = useState<string | null>(activeWorkspaceId ?? null);
  useEffect(() => {
    setScopeWs(activeWorkspaceId ?? null);
  }, [activeWorkspaceId]);

  const { scopeKey, metas, activeId: selectedId, activeMeta: selectedMeta, error: loadError } =
    useMindmapScope(scopeWs);

  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [codePanelOpen, setCodePanelOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 新建对话框：kind='mindmap' 或 DIAGRAM_TYPE_CHOICES 的 label key；
  // source 非空时一律按源码 detect 的实际类型创建（下拉仅用于生成骨架）
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createKind, setCreateKind] = useState<string>(MINDMAP_TYPE);
  const [createSource, setCreateSource] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // 切作用域时关闭横幅与重命名态
  useEffect(() => {
    setBanner(null);
    setEditingId(null);
  }, [scopeKey]);

  // 列表加载失败由共享 hook 上报（动作失败走局部 banner）
  useEffect(() => {
    if (loadError) setBanner({ text: loadError });
  }, [loadError]);

  const activeWorkspaceName = useMemo(
    () => workspaces.find((w) => w.id === scopeWs)?.name ?? null,
    [workspaces, scopeWs]
  );

  const failMessage = useCallback((e: unknown) => {
    if (e instanceof ApiRequestError) return e.message;
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

  const handleImportFile = useCallback(async (file: File) => {
    setBusy(true);
    setBanner(null);
    try {
      const mermaid = await file.text();
      await importMindmap({ mermaid, workspaceId: scopeWs });
    } catch (e) {
      setBanner({ text: t('gallery.operationFailed', { message: failMessage(e) }) });
    } finally {
      setBusy(false);
    }
  }, [importMindmap, scopeWs, t, failMessage]);

  const startRename = useCallback((m: MindmapMeta) => {
    setEditingId(m.id);
    setEditingDraft(m.title);
  }, []);

  const commitRename = useCallback(async (m: MindmapMeta) => {
    const title = editingDraft.trim();
    setEditingId(null);
    if (!title || title === m.title) return;
    try {
      await renameMindmapAction(m.id, title);
    } catch (e) {
      setBanner({ text: t('gallery.operationFailed', { message: failMessage(e) }) });
    }
  }, [editingDraft, renameMindmapAction, t, failMessage]);

  const handleDelete = useCallback(async (m: MindmapMeta) => {
    if (!window.confirm(t('gallery.deleteConfirm', { title: m.title }))) return;
    try {
      await deleteMindmapAction(m.id);
    } catch (e) {
      setBanner({ text: t('gallery.operationFailed', { message: failMessage(e) }) });
    }
  }, [deleteMindmapAction, t, failMessage]);

  const handleOpenPaper = useCallback((paperId: string) => {
    const doc = selectedId ? mindmapDocs[selectedId] : null;
    const node = doc?.nodes.find((n) => n.kind === 'paper' && n.paperId === paperId);
    openReaderTab(paperId, node?.text || paperId);
    setCurrentView('research');
  }, [mindmapDocs, openReaderTab, selectedId, setCurrentView]);

  const formatTime = useCallback((iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(i18n.language, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }, [i18n.language]);

  return (
    <div className="flex h-full bg-background">
      {/* ---------- 图库侧栏 ---------- */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-4 pb-3 pt-4">
          <div className="flex items-center gap-2">
            <ListTree size={18} className="text-primary" />
            <h2 className="text-sm font-semibold text-text">{t('gallery.title')}</h2>
          </div>
          <p className="mt-0.5 text-[11px] text-textSecondary">{t('gallery.subtitle')}</p>

          {/* 作用域切换 */}
          <div className="mt-3 flex rounded-lg border border-border p-0.5 text-xs">
            <button
              type="button"
              onClick={() => activeWorkspaceId && setScopeWs(activeWorkspaceId)}
              disabled={!activeWorkspaceId}
              title={!activeWorkspaceId ? t('gallery.scopeWsDisabled') : undefined}
              className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 ${
                scopeWs !== null
                  ? 'bg-primary/15 font-medium text-primary'
                  : 'text-textSecondary hover:text-text disabled:cursor-not-allowed disabled:opacity-40'
              }`}
            >
              <FolderOpen size={12} />
              <span className="truncate">{activeWorkspaceName ?? t('gallery.scopeWs')}</span>
            </button>
            <button
              type="button"
              onClick={() => setScopeWs(null)}
              className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 ${
                scopeWs === null
                  ? 'bg-primary/15 font-medium text-primary'
                  : 'text-textSecondary hover:text-text'
              }`}
            >
              <Globe size={12} />
              {t('gallery.scopeGlobal')}
            </button>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={openCreate}
              disabled={busy}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              {t('gallery.newMap')}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title={t('gallery.importMap')}
              className="flex items-center justify-center rounded-md border border-border px-2 py-1.5 text-textSecondary transition-colors hover:bg-white/5 hover:text-text disabled:opacity-50"
            >
              <Upload size={13} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mmd,.txt,.markdown,.md,text/markdown,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {banner && (
          <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{banner.text}</span>
            <button type="button" onClick={() => setBanner(null)} className="text-amber-400/70 hover:text-amber-300">
              <X size={12} />
            </button>
          </div>
        )}

        {/* 导图列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {metas === undefined ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-textSecondary">
              <Loader2 size={14} className="animate-spin" />
            </div>
          ) : metas.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <ListTree size={26} className="mx-auto text-textSecondary/40" />
              <p className="mt-2 text-xs font-medium text-textSecondary">{t('gallery.empty')}</p>
              <p className="mt-1 text-[11px] leading-5 text-textSecondary/70">{t('gallery.emptyHint')}</p>
            </div>
          ) : (
            metas.map((m) => {
              const isActive = m.id === selectedId;
              const isEditing = editingId === m.id;
              return (
                <div
                  key={m.id}
                  onClick={() => !isEditing && setActiveMindmapId(scopeWs, m.id)}
                  className={`group mx-2 mb-1 cursor-pointer rounded-lg px-3 py-2 ${
                    isActive ? 'bg-primary/10 ring-1 ring-primary/20' : 'hover:bg-white/5'
                  }`}
                >
                  {isEditing ? (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(m);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => void commitRename(m)}
                        className="min-w-0 flex-1 rounded border border-primary/50 bg-background px-1.5 py-0.5 text-xs text-text outline-none"
                      />
                      <button
                        type="button"
                        title={t('gallery.renameHint')}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void commitRename(m)}
                        className="text-accent hover:text-accent/80"
                      >
                        <Check size={13} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <DiagramBadge type={m.diagramType} />
                      <span className={`min-w-0 flex-1 truncate text-xs font-medium ${isActive ? 'text-primary' : 'text-text'}`}>
                        {m.title}
                      </span>
                      <button
                        type="button"
                        title={t('gallery.rename')}
                        onClick={(e) => { e.stopPropagation(); startRename(m); }}
                        className="rounded p-0.5 text-textSecondary/60 opacity-0 hover:text-text group-hover:opacity-100"
                      >
                        <PencilLine size={12} />
                      </button>
                      <button
                        type="button"
                        title={t('gallery.delete')}
                        onClick={(e) => { e.stopPropagation(); void handleDelete(m); }}
                        className="rounded p-0.5 text-textSecondary/60 opacity-0 hover:text-red-400 group-hover:opacity-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                  {!isEditing && (
                    <p className="mt-0.5 truncate text-[10px] text-textSecondary/60">
                      {t('gallery.updatedAt', { time: formatTime(m.updated_at) })}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ---------- 主区 ---------- */}
      <main className="flex min-w-0 flex-1 flex-col">
        {selectedMeta && selectedId ? (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
              <ListTree size={15} className="text-textSecondary" />
              <span className="truncate text-sm font-medium text-text">{selectedMeta.title}</span>
              {selectedMeta.diagramType !== MINDMAP_TYPE && (
                <DiagramBadge type={selectedMeta.diagramType} />
              )}
              <span className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-textSecondary">
                {scopeWs === null ? <Globe size={10} /> : <FolderOpen size={10} />}
                {scopeWs === null ? t('gallery.scopeGlobal') : (activeWorkspaceName ?? t('gallery.scopeWs'))}
              </span>
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
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-textSecondary transition-colors hover:border-primary/40 hover:text-text disabled:opacity-50"
              >
                <Upload size={15} />
                {t('gallery.importMap')}
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
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span className="break-words">{createError}</span>
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
