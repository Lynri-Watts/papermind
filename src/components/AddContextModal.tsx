import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Globe, Loader2, Search, X } from 'lucide-react';
import { ContextItem, Paper } from '../types';
import { createPaperContext, createUrlContext, searchPapers } from '../api';
import { usePaperMindStore } from '../store';
import { SourceBadge } from './SourceBadge';

interface AddContextModalProps {
  open: boolean;
  onClose: () => void;
  /** 导入成功后回调（父组件负责写入 store + 提示） */
  onAdded: (item: ContextItem) => void;
  /** 打开弹窗时默认停留在哪个导入页（外部入口可直接特化为网页链接） */
  initialMode?: 'paper' | 'url';
}

const AddContextModal: React.FC<AddContextModalProps> = ({ open, onClose, onAdded, initialMode = 'paper' }) => {
  const { t } = useTranslation('addContext');
  const [mode, setMode] = useState<'paper' | 'url'>('paper');
  const [paperQuery, setPaperQuery] = useState('');
  const [paperResults, setPaperResults] = useState<Paper[]>([]);
  const [paperLoading, setPaperLoading] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都回到入口指定的导入页并清空上次输入/错误
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setPaperQuery('');
      setPaperResults([]);
      setUrlInput('');
      setError(null);
    }
  }, [open, initialMode]);

  // 论文搜索防抖（复用 Explore 同一数据源）
  useEffect(() => {
    const q = paperQuery.trim();
    if (!q) {
      setPaperResults([]);
      return;
    }
    const timer = setTimeout(() => {
      setPaperLoading(true);
      searchPapers(q, 1, 8)
        .then(res => setPaperResults(res.papers))
        .catch(() => setPaperResults([]))
        .finally(() => setPaperLoading(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [paperQuery]);

  if (!open) return null;

  const importPaper = async (paper: Paper) => {
    if (importing) return;
    setImporting(true);
    setError(null);
    try {
      // 上下文库按工作区隔离：归属当前活跃工作区
      const item = await createPaperContext(paper.id, undefined,
        usePaperMindStore.getState().activeWorkspaceId ?? undefined);
      onAdded(item);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.importFailed'));
    } finally {
      setImporting(false);
    }
  };

  const importUrl = async () => {
    const url = urlInput.trim();
    if (!url || importing) return;
    setImporting(true);
    setError(null);
    try {
      const item = await createUrlContext(url,
        usePaperMindStore.getState().activeWorkspaceId ?? undefined);
      onAdded(item);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('errors.importFailed'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border border-border rounded-xl w-[540px] max-h-[82vh] flex flex-col shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="font-semibold text-text">{t('title')}</h3>
          <button onClick={onClose} className="p-1 hover:bg-surface rounded">
            <X className="w-5 h-5 text-textSecondary" />
          </button>
        </div>

        <div className="p-5 flex-1 overflow-auto">
          {/* 类型切换 */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => { setMode('paper'); setError(null); }}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                mode === 'paper'
                  ? 'bg-primary/20 text-primary border border-primary/30'
                  : 'bg-surface text-textSecondary border border-border hover:border-primary/30'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              {t('mode.paper')}
            </button>
            <button
              onClick={() => { setMode('url'); setError(null); }}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                mode === 'url'
                  ? 'bg-primary/20 text-primary border border-primary/30'
                  : 'bg-surface text-textSecondary border border-border hover:border-primary/30'
              }`}
            >
              <Globe className="w-4 h-4" />
              {t('mode.url')}
            </button>
          </div>

          {mode === 'paper' ? (
            <div>
              <p className="text-xs text-textSecondary mb-2">
                {t('paper.hint')}
              </p>
              <div className="relative">
                <Search className="w-4 h-4 text-textSecondary absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={paperQuery}
                  onChange={(e) => setPaperQuery(e.target.value)}
                  placeholder={t('paper.searchPlaceholder')}
                  className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-text placeholder-textSecondary focus:outline-none focus:border-primary text-sm"
                  autoFocus
                />
              </div>

              <div className="mt-3 space-y-2 max-h-[300px] overflow-auto">
                {paperLoading && (
                  <div className="flex items-center justify-center py-6 text-textSecondary">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                    <span className="text-xs">{t('paper.searching')}</span>
                  </div>
                )}
                {!paperLoading && paperQuery.trim() && paperResults.length === 0 && (
                  <p className="text-center text-xs text-textSecondary py-6">{t('paper.empty')}</p>
                )}
                {paperResults.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => importPaper(p)}
                    disabled={importing}
                    className="w-full text-left bg-surface border border-border rounded-lg p-3 hover:border-primary/50 transition-colors disabled:opacity-60"
                  >
                    <p className="text-sm text-text font-medium line-clamp-2">{p.title}</p>
                    <p className="text-[11px] text-textSecondary mt-1 line-clamp-2">{p.abstract || t('paper.noAbstract')}</p>
                    {/* 多源聚合结果：标注每篇论文的数据来源 */}
                    <div className="flex items-center gap-2 mt-1.5">
                      <SourceBadge provider={p.source} />
                      {p.year ? <span className="text-[11px] text-textSecondary">{p.year}</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <p className="text-xs text-textSecondary mb-2">
                {t('url.hint')}
              </p>
              <div className="relative">
                <Globe className="w-4 h-4 text-textSecondary absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && importUrl()}
                  placeholder="https://..."
                  className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-text placeholder-textSecondary focus:outline-none focus:border-primary text-sm"
                  autoFocus
                />
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  onClick={importUrl}
                  disabled={!urlInput.trim() || importing}
                  className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded-lg text-sm transition-colors disabled:opacity-50"
                >
                  {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                  {importing ? t('url.importing') : t('url.import')}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default AddContextModal;
