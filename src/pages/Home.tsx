import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus, FolderOpen, Trash2, FileText, Folder, MessageCircle, ChevronDown, ChevronRight, FileCode2, Loader2, ArrowRight, Info, Check } from 'lucide-react';
import { usePaperMindStore, WRITING_ENABLED } from '../store';
import { createWorkspace, deleteWorkspace, listWorkspaceFiles } from '../api';
import { WorkspaceInfo, WorkspaceFile } from '../types';

/** 文件概览类型图标 */
const KIND_ICON: Record<WorkspaceFile['kind'], React.ReactNode> = {
  pdf: <FileText className="w-3.5 h-3.5 text-red-400" />,
  latex: <FileCode2 className="w-3.5 h-3.5 text-emerald-400" />,
  text: <FileText className="w-3.5 h-3.5 text-sky-400" />,
  other: <FileText className="w-3.5 h-3.5 text-textSecondary" />,
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number, t: TFunction): string {
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3600_000) return t('time.minutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t('time.hoursAgo', { count: Math.floor(diff / 3600_000) });
  return t('time.monthDay', { month: d.getMonth() + 1, day: d.getDate() });
}

/**
 * 主页：工作区引导。
 * 未选择工作区（activeWorkspaceId 为空）时启动即进入本页；
 * 用于创建 / 切换 / 删除工作区，并概览各工作区内的文件。
 */
const Home: React.FC = () => {
  const { t } = useTranslation(['home', 'common']);
  const { workspaces, setWorkspaces, activeWorkspaceId, switchWorkspace, setActiveWorkspaceId, setCurrentView } = usePaperMindStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在切换为当前工作区的 id（卡片显示「切换中」并禁止重复点击） */
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  /** 选择工作区失败时列表上方的错误条 */
  const [switchError, setSwitchError] = useState<string | null>(null);
  // 展开的工作区 id → 其文件列表缓存
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filesMap, setFilesMap] = useState<Record<string, WorkspaceFile[]>>({});
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({});

  const toggleFiles = useCallback(async (wsId: string) => {
    const willExpand = !expanded[wsId];
    setExpanded((prev) => ({ ...prev, [wsId]: willExpand }));
    if (!willExpand) return;
    if (filesMap[wsId]) return;  // 已有缓存不再请求
    setLoadingFiles((prev) => ({ ...prev, [wsId]: true }));
    try {
      const files = await listWorkspaceFiles(wsId);
      setFilesMap((prev) => ({ ...prev, [wsId]: files }));
    } catch (e) {
      setFilesMap((prev) => ({ ...prev, [wsId]: [] }));
    } finally {
      setLoadingFiles((prev) => ({ ...prev, [wsId]: false }));
    }
  }, [expanded, filesMap]);

  /**
   * 把指定工作区切换为「当前工作区」（阅读/探索/上传文献/问答均以它为作用域）。
   * 创作模块下线期间只切换、停留在主页；上线后同时进入创作页。
   * 两个入口（创建成功、点击卡片）共用，保证状态反馈一致。
   */
  const selectWorkspace = async (wsId: string) => {
    if (wsId === activeWorkspaceId || switchingId) return;
    setSwitchingId(wsId);
    setSwitchError(null);
    try {
      await switchWorkspace(wsId);
      if (WRITING_ENABLED) setCurrentView('workspace');
    } catch (e) {
      setSwitchError(e instanceof Error ? e.message : t('errors.selectFailed'));
    } finally {
      setSwitchingId(null);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t('errors.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ws = await createWorkspace(name.trim(), description.trim());
      setWorkspaces([...workspaces, ws]);
      setCreating(false);
      setName('');
      setDescription('');
      // 创建后选定为当前工作区（创作模块上线时 selectWorkspace 会自动进入创作页）
      await selectWorkspace(ws.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleEnter = (ws: WorkspaceInfo) => {
    void selectWorkspace(ws.id);
  };

  const handleDelete = async (ws: WorkspaceInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(t('confirm.delete', { name: ws.name }))) return;
    try {
      await deleteWorkspace(ws.id);
      setWorkspaces(workspaces.filter((w) => w.id !== ws.id));
      setFilesMap((prev) => {
        const next = { ...prev };
        delete next[ws.id];
        return next;
      });
      if (activeWorkspaceId === ws.id) {
        setActiveWorkspaceId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.deleteFailed'));
    }
  };

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="max-w-3xl mx-auto px-8 py-12">
        {/* 标题区 */}
        <div className="flex items-center gap-4 mb-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
            <MessageCircle className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-text">PaperMind</h1>
            <p className="text-sm text-textSecondary">{t('subtitle')}</p>
          </div>
        </div>

        {/* 创建表单 */}
        <div className="mt-8 bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" />
              <span className="font-medium text-text">{t('create.title')}</span>
            </div>
            {creating && (
              <button onClick={() => setCreating(false)} className="text-xs text-textSecondary hover:text-text">
                {t('common:action.collapse')}
              </button>
            )}
          </div>
          {creating ? (
            <div className="space-y-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('create.namePlaceholder')}
                autoFocus
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text placeholder-textSecondary focus:outline-none focus:border-primary"
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('create.descriptionPlaceholder')}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text placeholder-textSecondary focus:outline-none focus:border-primary"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => setCreating(false)}
                  className="px-4 py-2 rounded-lg text-sm text-textSecondary hover:text-text hover:bg-background transition-colors"
                >
                  {t('common:action.cancel')}
                </button>
                <button
                  onClick={handleCreate}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('create.submit')}
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setCreating(true);
                setError(null);
              }}
              className="w-full py-6 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-primary/5 transition-colors flex flex-col items-center gap-2 text-textSecondary hover:text-text"
            >
              <FolderOpen className="w-6 h-6" />
              <span className="text-sm">{t('create.prompt')}</span>
              <span className="text-xs opacity-70">{t('create.promptHint')}</span>
            </button>
          )}
        </div>

        {/* 工作区列表 */}
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-textSecondary uppercase tracking-wide mb-3">
            {t('list.heading', { count: workspaces.length })}
          </h2>
          {switchError && (
            <p className="mb-3 text-xs text-red-400">{switchError}</p>
          )}
          {workspaces.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-10 text-center text-textSecondary">
              <Folder className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t('list.empty')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {workspaces.map((ws) => {
                const isActive = ws.id === activeWorkspaceId;
                const isSwitching = switchingId === ws.id;
                /** 已选定或切换中的卡片不再作为可点击按钮 */
                const isSelectLocked = isActive || isSwitching;
                const isExpanded = expanded[ws.id];
                const files = filesMap[ws.id] ?? [];
                return (
                  <div
                    key={ws.id}
                    className={`bg-surface border rounded-xl overflow-hidden transition-colors ${
                      isActive ? 'border-primary/50' : 'border-border'
                    }`}
                  >
                    <div
                      role={isSelectLocked ? undefined : 'button'}
                      tabIndex={isSelectLocked ? -1 : 0}
                      aria-disabled={isSelectLocked || undefined}
                      onClick={() => !isSelectLocked && handleEnter(ws)}
                      onKeyDown={(e) => {
                        if (!isSelectLocked && e.key === 'Enter') handleEnter(ws);
                      }}
                      className={`w-full text-left p-4 flex items-center gap-3 transition-colors ${
                        isSelectLocked ? 'cursor-default' : 'hover:bg-primary/5 cursor-pointer'
                      }`}
                    >
                      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Folder className="w-5 h-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-text truncate">{ws.name}</p>
                          {isSwitching && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface text-textSecondary border border-border flex-shrink-0">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              {t('list.selecting')}
                            </span>
                          )}
                          {isActive && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/15 text-primary flex-shrink-0">
                              <Check className="w-3 h-3" />
                              {t('list.selected')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-textSecondary truncate">
                          {ws.description || t('list.fileCount', { count: ws.file_count ?? 0 })}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFiles(ws.id);
                          }}
                          className="p-2 rounded-lg hover:bg-background text-textSecondary hover:text-text transition-colors"
                          title={t('list.viewFiles')}
                        >
                          {loadingFiles[ws.id] ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={(e) => handleDelete(ws, e)}
                          className="p-2 rounded-lg hover:bg-red-500/10 text-textSecondary hover:text-red-400 transition-colors"
                          title={t('list.deleteWorkspace')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* 文件概览 */}
                    {isExpanded && (
                      <div className="border-t border-border px-4 py-3 bg-background/40">
                        <p className="text-xs font-medium text-textSecondary mb-2">{t('list.filesHeading', { count: files.length })}</p>
                        {files.length === 0 ? (
                          <p className="text-xs text-textSecondary/70">{t('list.filesEmpty')}</p>
                        ) : (
                          <ul className="space-y-1.5 max-h-64 overflow-auto pr-1">
                            {files.map((f) => (
                              <li key={f.path} className="flex items-center gap-2 text-xs">
                                {KIND_ICON[f.kind]}
                                <span className="text-text truncate flex-1">{f.path}</span>
                                <span className="text-textSecondary flex-shrink-0">{formatSize(f.size)}</span>
                                <span className="text-textSecondary/60 flex-shrink-0 w-14 text-right">{formatTime(f.mtime, t)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Home;
