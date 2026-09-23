import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Check, ChevronDown, ChevronUp, ExternalLink, Eye, FileText, Globe, Pencil, Plus, RefreshCw, Tag, X } from 'lucide-react';
import { ContextItem } from '../types';
import { deleteContextItem, getContextContent, refreshContextItem, retryContextPaperPdf, updateContextItem } from '../api';
import AddToMindmapButton from './mindmap/AddToMindmapButton';

interface ContextItemCardProps {
  item: ContextItem;
  /** 删除后回调（父组件更新 store） */
  onDelete: (id: string) => void;
  /** 编辑/刷新成功后回调（父组件 patch store） */
  onChanged: (item: ContextItem) => void;
  /** 一键插入论文 */
  onInsert?: (item: ContextItem) => void;
  /** 在阅读器中打开（仅 paper 类型条目渲染该按钮） */
  onOpenInReader?: (item: ContextItem) => void;
  onError: (message: string) => void;
}

const ContextItemCard: React.FC<ContextItemCardProps> = ({ item, onDelete, onChanged, onInsert, onOpenInReader, onError }) => {
  const { t } = useTranslation(['contextItem', 'common']);
  const [editing, setEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(item.summary);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** 手动重新尝试获取该 paper 的全文/PDF（与「重新生成摘要」的 busy 区分，图标各自反馈） */
  const [retryingPdf, setRetryingPdf] = useState(false);
  // 全文按需查看（具体内容不常驻，仅展开时从后端拉取）
  const [contentOpen, setContentOpen] = useState(false);
  const [contentText, setContentText] = useState('');
  const [contentLoading, setContentLoading] = useState(false);

  const toggleContent = async () => {
    if (contentOpen) {
      setContentOpen(false);
      return;
    }
    setContentOpen(true);
    if (contentText) return;
    setContentLoading(true);
    try {
      const data = await getContextContent(item.id);
      setContentText(data.text || t('content.empty'));
    } catch (e) {
      setContentText(e instanceof Error ? e.message : t('errors.fetchContentFailed'));
    } finally {
      setContentLoading(false);
    }
  };

  const saveSummary = async () => {
    const summary = summaryDraft.trim();
    setBusy(true);
    try {
      const updated = await updateContextItem(item.id, { summary });
      onChanged(updated);
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : t('errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const addTag = async () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    const next = [...new Set([...item.tags, tag])];
    setBusy(true);
    try {
      const updated = await updateContextItem(item.id, { tags: next });
      onChanged(updated);
      setTagDraft('');
      setAddingTag(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : t('errors.addTagFailed'));
    } finally {
      setBusy(false);
    }
  };

  const removeTag = async (tag: string) => {
    const next = item.tags.filter(existingTag => existingTag !== tag);
    setBusy(true);
    try {
      const updated = await updateContextItem(item.id, { tags: next });
      onChanged(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : t('errors.removeTagFailed'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const updated = await refreshContextItem(item.id);
      onChanged(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : t('errors.refreshFailed'));
    } finally {
      setBusy(false);
    }
  };

  /** 手动重试全文/PDF 获取：失败后唯一的重试入口，成功与否都按最新 pdfStatus 刷新徽标 */
  const retryPdf = async () => {
    if (retryingPdf) return;
    setRetryingPdf(true);
    try {
      const updated = await retryContextPaperPdf(item.id);
      onChanged(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : t('errors.retryPdfFailed'));
    } finally {
      setRetryingPdf(false);
    }
  };

  const remove = async () => {
    try {
      await deleteContextItem(item.id);
      onDelete(item.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : t('errors.deleteFailed'));
    }
  };

  const isPaper = item.type === 'paper';
  /** 该 paper 自动获取全文失败：卡片需标记「无法打开」并提供手动重试 */
  const pdfUnavailable = isPaper && item.pdfStatus === 'unavailable';

  return (
    <div className={`bg-surface border border-border rounded-xl p-4 transition-colors hover:border-primary/50 ${busy || retryingPdf ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`p-2 rounded-lg flex-shrink-0 ${isPaper ? 'bg-primary/10' : 'bg-secondary/10'}`}>
            {isPaper ? <BookOpen className="w-4 h-4 text-primary" /> : <Globe className="w-4 h-4 text-secondary" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-text text-sm">{item.title}</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${isPaper ? 'bg-primary/20 text-primary' : 'bg-secondary/20 text-secondary'}`}>
                {isPaper ? t('type.paper') : t('type.url')}
              </span>
              {item.status !== 'ready' && (
                <span className={`px-2 py-0.5 rounded text-[10px] ${item.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400'}`}>
                  {item.status === 'pending' ? t('status.generating') : t('common:status.failed')}
                </span>
              )}
              {pdfUnavailable && (
                <span
                  className="px-2 py-0.5 rounded text-[10px] bg-red-500/20 text-red-400"
                  title={item.pdfError || t('status.unavailableTitle')}
                >
                  {t('status.unavailable')}
                </span>
              )}
            </div>

            {/* 摘要（可编辑） */}
            {editing ? (
              <div className="mt-2">
                <textarea
                  value={summaryDraft}
                  onChange={(e) => setSummaryDraft(e.target.value)}
                  rows={3}
                  autoFocus
                  className="w-full px-2.5 py-2 bg-background border border-primary/40 rounded-lg text-xs text-text focus:outline-none resize-none"
                />
                <div className="flex gap-2 mt-1.5">
                  <button
                    onClick={saveSummary}
                    disabled={busy}
                    className="flex items-center gap-1 px-2.5 py-1 bg-accent text-white rounded-md text-xs disabled:opacity-50"
                  >
                    <Check className="w-3 h-3" /> {t('common:action.save')}
                  </button>
                  <button
                    onClick={() => { setEditing(false); setSummaryDraft(item.summary); }}
                    className="px-2.5 py-1 bg-surface border border-border rounded-md text-xs text-textSecondary hover:text-text"
                  >
                    {t('common:action.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <p
                className="text-xs text-textSecondary mt-1.5 cursor-pointer hover:text-text line-clamp-4"
                title={t('summary.editTitle')}
                onClick={() => { setSummaryDraft(item.summary); setEditing(true); }}
              >
                {item.summary || t('summary.empty')}
              </p>
            )}

            {/* 出处 */}
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-textSecondary/70">
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-secondary truncate">
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{item.url}</span>
                </a>
              ) : (
                <span className="truncate">{item.paperId || item.source}</span>
              )}
            </div>

            {/* 标签 */}
            <div className="mt-2 flex items-center gap-1.5 flex-wrap">
              <Tag className="w-3 h-3 text-textSecondary/60" />
              {item.tags.map((tag) => (
                <span key={tag} className="flex items-center gap-1 px-2 py-0.5 bg-background border border-border rounded-full text-[10px] text-textSecondary">
                  {tag}
                  <button onClick={() => removeTag(tag)} disabled={busy} className="hover:text-red-400">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
              {addingTag ? (
                <span className="flex items-center gap-1">
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && addTag()}
                    onBlur={() => { if (!tagDraft.trim()) setAddingTag(false); }}
                    autoFocus
                    placeholder={t('tag.placeholder')}
                    className="w-20 px-1.5 py-0.5 bg-background border border-border rounded text-[10px] text-text focus:outline-none"
                  />
                </span>
              ) : (
                <button
                  onClick={() => setAddingTag(true)}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-textSecondary hover:text-primary"
                >
                  <Plus className="w-2.5 h-2.5" /> {t('tag.add')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
          {isPaper && onOpenInReader && (
            <button
              onClick={() => onOpenInReader(item)}
              className="p-1.5 rounded-lg hover:bg-primary/15 text-textSecondary hover:text-primary transition-colors"
              title={t('actions.openInReader')}
            >
              <BookOpen className="w-3.5 h-3.5" />
            </button>
          )}
          {isPaper && item.paperId && (
            <AddToMindmapButton
              paperId={item.paperId}
              paperTitle={item.title}
              defaultMapTitle={t('mindmap:gallery.newMapTitle')}
              className="p-1.5 rounded-lg hover:bg-indigo-100 transition-colors"
              onResult={(r) => {
                if (r.kind === 'error') onError(r.message);
              }}
            />
          )}
          {onInsert && (
            <button
              onClick={() => onInsert(item)}
              className="p-1.5 rounded-lg hover:bg-accent/20 text-textSecondary hover:text-accent transition-colors"
              title={t('actions.insertPaper')}
            >
              <FileText className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={toggleContent}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary hover:text-primary transition-colors"
            title={contentOpen ? t('actions.collapseContent') : t('actions.viewContent')}
          >
            {contentLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : (contentOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />)}
          </button>
          <button
            onClick={() => { setSummaryDraft(item.summary); setEditing(true); }}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary hover:text-primary transition-colors"
            title={t('summary.edit')}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          {pdfUnavailable && (
            <button
              onClick={retryPdf}
              disabled={retryingPdf}
              className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-400 transition-colors disabled:opacity-40"
              title={t('actions.retryPdf')}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${retryingPdf ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={refresh}
            disabled={busy}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary hover:text-primary transition-colors disabled:opacity-40"
            title={t('actions.regenerate')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={remove}
            className="p-1.5 rounded-lg hover:bg-red-500/20 text-textSecondary hover:text-red-400 transition-colors"
            title={t('common:action.delete')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 全文按需展开 */}
      {contentOpen && (
        <div className="mt-3 pt-3 border-t border-border/60">
          <div className="flex items-center gap-1.5 mb-1.5 text-[10px] text-textSecondary/70">
            <Eye className="w-3 h-3" />
            <span>{t('content.label', { kind: item.type === 'url' ? t('content.webText') : t('content.paperFullText') })}</span>
          </div>
          <p className="text-xs text-textSecondary leading-relaxed whitespace-pre-wrap max-h-64 overflow-auto bg-background/60 rounded-lg p-3">
            {contentText || t('content.loading')}
          </p>
        </div>
      )}
    </div>
  );
};

export default ContextItemCard;
