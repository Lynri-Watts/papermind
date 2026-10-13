/**
 * 写作区左侧文件树：
 * - 列出工作区全部写作文件（隐藏 main.pdf 等编译产物与 aux 中间文件）
 * - 新建文本文件（tex/bib/md/txt）、上传（tex/bib/txt/md 与图片素材）、刷新、删除
 * - 单击文件：文本文件进编辑器标签；图片进预览标签
 * - 图片额外提供「复制 \includegraphics 引用」
 * - 按目录分组、可折叠
 *
 * 文献 PDF 不属于写作目录（存于独立文献库，由阅读页管理），故此处不出现。
 */
import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FileCode2, FileText,
  Image as ImageIcon, FileType, Plus, Upload, RefreshCw, Trash2, Copy, X, Loader2,
} from 'lucide-react';
import type { WorkspaceFile } from '../../types';
import {
  MAIN_TEX, UPLOAD_ACCEPT, CREATABLE_EXTS, baseName, dirName,
  isHiddenArtifact, isImageFile, validateRelPath,
} from './utils';

interface FileTreeProps {
  files: WorkspaceFile[];
  activePath: string | null;
  openTabs: Set<string>;
  loading: boolean;
  uploading: boolean;
  onOpen: (path: string) => void;
  onRefresh: () => void;
  /** 创建文本文件（相对路径）；失败抛 Error(message) 由本组件展示 */
  onCreate: (relPath: string) => Promise<void>;
  onUpload: (files: FileList) => void;
  onDelete: (path: string) => void;
  onCopyImageRef: (path: string) => void;
}

interface TreeNode {
  name: string;
  fullPath: string;
  dirs: Map<string, TreeNode>;
  files: WorkspaceFile[];
}

function buildTree(files: WorkspaceFile[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', dirs: new Map(), files: [] };
  for (const f of files) {
    if (isHiddenArtifact(f.path)) continue;
    const dir = dirName(f.path);
    let node = root;
    if (dir) {
      for (const seg of dir.split('/')) {
        let child = node.dirs.get(seg);
        if (!child) {
          child = {
            name: seg,
            fullPath: node.fullPath ? `${node.fullPath}/${seg}` : seg,
            dirs: new Map(),
            files: [],
          };
          node.dirs.set(seg, child);
        }
        node = child;
      }
    }
    node.files.push(f);
  }
  const sortNode = (n: TreeNode) => {
    n.files.sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    Array.from(n.dirs.values()).forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function fileIcon(path: string): React.ReactNode {
  if (isImageFile(path)) return <ImageIcon size={14} className="text-violet-400 flex-shrink-0" />;
  if (path.endsWith('.pdf')) return <FileType size={14} className="text-red-400 flex-shrink-0" />;
  if (path.endsWith('.tex') || path.endsWith('.bib')) {
    return <FileCode2 size={14} className="text-emerald-400 flex-shrink-0" />;
  }
  return <FileText size={14} className="text-sky-400 flex-shrink-0" />;
}

const FileTree: React.FC<FileTreeProps> = ({
  files, activePath, openTabs, loading, uploading,
  onOpen, onRefresh, onCreate, onUpload, onDelete, onCopyImageRef,
}) => {
  const { t } = useTranslation('writing');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newExt, setNewExt] = useState<string>(CREATABLE_EXTS[0]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => buildTree(files), [files]);
  const visibleCount = useMemo(
    () => files.filter((f) => !isHiddenArtifact(f.path)).length,
    [files],
  );

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submitCreate = async () => {
    const relPath = `${newName.trim()}${newExt}`;
    const errKey = validateRelPath(relPath);
    if (errKey) {
      setCreateError(t(errKey));
      return;
    }
    if (files.some((f) => f.path === relPath)) {
      setCreateError(t('files.errExists'));
      return;
    }
    setCreating(true);
    try {
      await onCreate(relPath);
      setShowCreate(false);
      setNewName('');
      setCreateError(null);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t('files.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const dirs = Array.from(node.dirs.values());
    return (
      <React.Fragment key={node.fullPath || 'root'}>
        {dirs.map((dir) => {
          const isCollapsed = collapsed.has(dir.fullPath);
          return (
            <React.Fragment key={dir.fullPath}>
              <button
                type="button"
                onClick={() => toggleDir(dir.fullPath)}
                className="w-full flex items-center gap-1 py-1 pr-2 text-xs text-textSecondary hover:text-text transition-colors"
                style={{ paddingLeft: `${8 + depth * 12}px` }}
              >
                {isCollapsed
                  ? <ChevronRight size={12} className="flex-shrink-0" />
                  : <ChevronDown size={12} className="flex-shrink-0" />}
                {isCollapsed
                  ? <Folder size={13} className="text-amber-400/80 flex-shrink-0" />
                  : <FolderOpen size={13} className="text-amber-400/80 flex-shrink-0" />}
                <span className="truncate">{dir.name}</span>
              </button>
              {!isCollapsed && renderNode(dir, depth + 1)}
            </React.Fragment>
          );
        })}
        {node.files.map((f) => {
          const isActive = f.path === activePath;
          const isOpen = openTabs.has(f.path);
          const isMain = f.path === MAIN_TEX;
          return (
            <div
              key={f.path}
              role="button"
              tabIndex={0}
              title={f.path}
              onClick={() => onOpen(f.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onOpen(f.path);
              }}
              className={[
                'group w-full flex items-center gap-1.5 py-1 pr-1.5 text-xs cursor-pointer rounded-sm',
                isActive
                  ? 'bg-accent/15 text-text'
                  : 'text-textSecondary hover:bg-white/5 hover:text-text',
              ].join(' ')}
              style={{ paddingLeft: `${8 + depth * 12 + 16}px` }}
            >
              {fileIcon(f.path)}
              <span className="truncate flex-1 text-left">{baseName(f.path)}</span>
              {isOpen && !isActive && <span className="w-1 h-1 rounded-full bg-textSecondary/60" />}
              {isImageFile(f.path) && (
                <button
                  type="button"
                  title={t('files.copyImageRef')}
                  aria-label={t('files.copyImageRef')}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/10 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyImageRef(f.path);
                  }}
                >
                  <Copy size={11} />
                </button>
              )}
              {!isMain && (
                <button
                  type="button"
                  title={t('files.delete')}
                  aria-label={t('files.delete')}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/20 hover:text-red-400 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(f.path);
                  }}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          );
        })}
      </React.Fragment>
    );
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-border">
        <span className="text-xs font-medium text-textSecondary tracking-wide">
          {t('files.title')}
          <span className="ml-1.5 text-textSecondary/60">{visibleCount}</span>
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title={t('files.create')}
            aria-label={t('files.create')}
            className="p-1 rounded text-textSecondary hover:text-text hover:bg-white/10 transition-colors"
            onClick={() => {
              setCreateError(null);
              setShowCreate(true);
            }}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            title={t('files.upload')}
            aria-label={t('files.upload')}
            disabled={uploading}
            className="p-1 rounded text-textSecondary hover:text-text hover:bg-white/10 disabled:opacity-50 transition-colors"
            onClick={() => uploadRef.current?.click()}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          </button>
          <button
            type="button"
            title={t('files.refresh')}
            aria-label={t('files.refresh')}
            disabled={loading}
            className="p-1 rounded text-textSecondary hover:text-text hover:bg-white/10 disabled:opacity-50 transition-colors"
            onClick={onRefresh}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) onUpload(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5">
        {visibleCount === 0 && !loading ? (
          <p className="px-3 py-6 text-xs text-textSecondary/60 leading-relaxed">
            {t('files.empty')}
          </p>
        ) : (
          renderNode(tree, 0)
        )}
      </div>

      {/* 新建文件弹层 */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => !creating && setShowCreate(false)}
        >
          <div
            className="w-[340px] rounded-lg bg-background border border-border shadow-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-text">{t('files.createTitle')}</h3>
              <button
                type="button"
                className="text-textSecondary hover:text-text"
                onClick={() => setShowCreate(false)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitCreate();
                  if (e.key === 'Escape') setShowCreate(false);
                }}
                placeholder={t('files.namePlaceholder')}
                className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded bg-surface border border-border text-text placeholder:text-textSecondary/60 focus:outline-none focus:border-accent"
              />
              <select
                value={newExt}
                onChange={(e) => setNewExt(e.target.value)}
                className="px-1.5 py-1.5 text-xs rounded bg-surface border border-border text-text focus:outline-none focus:border-accent"
              >
                {CREATABLE_EXTS.map((ext) => (
                  <option key={ext} value={ext}>{ext}</option>
                ))}
              </select>
            </div>
            {createError && (
              <p className="mt-2 text-xs text-red-400 break-words">{createError}</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded text-textSecondary hover:bg-white/10 transition-colors"
                onClick={() => setShowCreate(false)}
                disabled={creating}
              >
                {t('files.cancel')}
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-60"
                onClick={submitCreate}
                disabled={creating}
              >
                {creating && <Loader2 size={12} className="animate-spin" />}
                {t('files.confirmCreate')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FileTree;
