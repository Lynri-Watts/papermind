/**
 * 思维导图图库侧栏（全屏图库页与 Explore 页共用，高内聚低耦合）。
 *
 * 从 pages/Mindmaps 抽出的索引栏：
 * - 作用域切换（当前工作区 / 全局）；
 * - 新建（行为由父级决定：图库页弹创建对话框，Explore 内快速建图）、导入 .md/.mmd；
 * - 导图列表：单击切换、悬停重命名/删除；
 * - 加载/操作失败横幅与重试。
 *
 * 列表真源与选中态由 ``useMindmapScope`` 在父级统一持有（画布主区也要用），
 * 经 props 传入，避免两个组件各自请求。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
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
import {
  MINDMAP_TYPE,
  diagramLabelKey,
} from '../../lib/mindmap';
import { usePaperMindStore } from '../../store';
import type { MindmapMeta } from '../../types';
import { ApiRequestError } from '../../api';

/** 列表项的图类型徽标：mindmap 不显示；经典类型显示本地化名称 */
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

export interface MindmapGallerySidebarProps {
  /** 当前作用域：工作区 id 或 null=全局 */
  scopeWs: string | null;
  onScopeChange: (ws: string | null) => void;
  /** undefined=尚未加载；空数组=已加载但为空（来自 useMindmapScope） */
  metas: MindmapMeta[] | undefined;
  activeId: string | null;
  /** 作用域列表加载失败信息（横幅内置「重试」） */
  loadError: string | null;
  onReload: () => void;
  /** 「新建」按钮点击：图库页打开创建对话框，Explore 直接快速建图 */
  onCreate: () => void;
  /** 外部动作忙碌态（如快速建图中），禁用新建/导入按钮 */
  creating?: boolean;
  /** 容器附加类名（宽度由使用方决定，图库页 w-72、Explore w-60） */
  className?: string;
}

const MindmapGallerySidebar: React.FC<MindmapGallerySidebarProps> = ({
  scopeWs,
  onScopeChange,
  metas,
  activeId,
  loadError,
  onReload,
  onCreate,
  creating = false,
  className = '',
}) => {
  const { t, i18n } = useTranslation('mindmap');
  const activeWorkspaceId = usePaperMindStore((s) => s.activeWorkspaceId);
  const workspaces = usePaperMindStore((s) => s.workspaces);
  const setActiveMindmapId = usePaperMindStore((s) => s.setActiveMindmapId);
  const importMindmap = usePaperMindStore((s) => s.importMindmap);
  const renameMindmapAction = usePaperMindStore((s) => s.renameMindmap);
  const deleteMindmapAction = usePaperMindStore((s) => s.deleteMindmap);

  const [importing, setImporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeWorkspaceName = useMemo(
    () => workspaces.find((w) => w.id === scopeWs)?.name ?? null,
    [workspaces, scopeWs],
  );

  const failMessage = useCallback((e: unknown) => {
    if (e instanceof ApiRequestError) return e.message;
    if (e instanceof Error) return e.message;
    return String(e);
  }, []);

  const handleImportFile = useCallback(async (file: File) => {
    setImporting(true);
    setActionError(null);
    try {
      const mermaid = await file.text();
      await importMindmap({ mermaid, workspaceId: scopeWs });
    } catch (e) {
      setActionError(t('gallery.operationFailed', { message: failMessage(e) }));
    } finally {
      setImporting(false);
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
    setActionError(null);
    try {
      await renameMindmapAction(m.id, title);
    } catch (e) {
      setActionError(t('gallery.operationFailed', { message: failMessage(e) }));
    }
  }, [editingDraft, renameMindmapAction, t, failMessage]);

  const handleDelete = useCallback(async (m: MindmapMeta) => {
    if (!window.confirm(t('gallery.deleteConfirm', { title: m.title }))) return;
    setActionError(null);
    try {
      await deleteMindmapAction(m.id);
    } catch (e) {
      setActionError(t('gallery.operationFailed', { message: failMessage(e) }));
    }
  }, [deleteMindmapAction, t, failMessage]);

  const formatTime = useCallback((iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(i18n.language, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }, [i18n.language]);

  const busy = creating || importing;
  const banner = loadError ?? actionError;

  return (
    <aside className={`flex shrink-0 flex-col border-r border-border bg-surface ${className}`}>
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
            onClick={() => onScopeChange(activeWorkspaceId)}
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
            onClick={() => onScopeChange(null)}
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
            onClick={onCreate}
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
          <span className="min-w-0 flex-1 break-words">{banner}</span>
          {loadError && (
            <button type="button" onClick={() => void onReload()} className="font-medium underline">
              {t('retry')}
            </button>
          )}
          {actionError && (
            <button type="button" onClick={() => setActionError(null)} className="text-amber-400/70 hover:text-amber-300">
              <X size={12} />
            </button>
          )}
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
            const isActive = m.id === activeId;
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
  );
};

export default MindmapGallerySidebar;
