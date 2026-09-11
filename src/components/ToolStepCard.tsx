import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Plus, X,
} from 'lucide-react';
import { ReactStep, ToolPaper } from '../types';

interface ToolStepCardProps {
  /** 一个 ReAct 步骤（Thought → Action → Observation；纯思考/工具调用均支持） */
  step: ReactStep;
  /** 该步骤所属消息是否仍在流式生成：是则自动展开实时内容，消息结束自动折叠 */
  live?: boolean;
  /** 论文行内操作（加入上下文库 / 在阅读器打开）；传入才显示 */
  onAddToContext?: (paper: ToolPaper) => void;
  onOpenPaper?: (paper: ToolPaper) => void;
}

/** 工具参数 → 文案键的映射（与后端 PaperSearchTool 的字段对应） */
const ARG_LABEL_KEYS: Record<string, string> = {
  title: 'arg.title',
  abstract: 'arg.abstract',
  keywords: 'arg.keywords',
  author: 'arg.author',
  fulltext: 'arg.fulltext',
  year_from: 'arg.yearFrom',
  year_to: 'arg.yearTo',
  limit: 'arg.limit',
  paper_ids: 'arg.paperIds',
};

/** 把工具参数渲染为可读的条件标签 */
function ArgumentChips({ args }: { args: Record<string, unknown> | undefined }) {
  const { t } = useTranslation('toolStep');
  const entries = Object.entries(args ?? {}).filter(
    ([k, v]) => v !== undefined && v !== null && String(v).trim() !== ''
  );
  if (entries.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {entries.map(([k, v]) => {
        const raw = Array.isArray(v) ? v.join(t('argListSeparator')) : String(v);
        return (
          <span
            key={k}
            className="px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] text-textSecondary max-w-full truncate"
            title={raw}
          >
            {ARG_LABEL_KEYS[k] ? t(ARG_LABEL_KEYS[k]) : k}: {raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}
          </span>
        );
      })}
    </div>
  );
}

/** 渲染单个 ReAct 步骤卡片：思考（可点击展开）+ 动作徽标 + 观察结果（论文列表/摘要）。
 * 生成中（thinking/running）自动展开、实时滚动；完成后自动折叠成紧凑卡片。 */
const ToolStepCard: React.FC<ToolStepCardProps> = ({
  step, live, onAddToContext, onOpenPaper,
}) => {
  const { t } = useTranslation('toolStep');
  const papers = step.papers ?? [];
  const autoOpen = step.status === 'thinking' || step.status === 'running';
  const [open, setOpen] = useState(autoOpen);

  // 流式中保持展开；消息整体结束后折叠（live=false）为紧凑卡片
  useEffect(() => {
    if (autoOpen) setOpen(true);
    else if (!live) setOpen(false);
  }, [autoOpen, live]);

  const rejected = step.status === 'rejected';
  const failed = step.status === 'error';
  const thinking = step.status === 'thinking';
  const running = step.status === 'running';
  const hasThought = Boolean((step.thought ?? '').trim());
  const obsText = step.observation ?? (step as unknown as { toolMessage?: string }).toolMessage;
  const isPureThought = !step.toolName; // 纯思考步骤（如 READY 直接回答）
  const hasAction = Boolean(onAddToContext || onOpenPaper);

  const toolName = step.toolLabel || step.toolName || '';
  const headerTitle = rejected
    ? t('title.skipped', { tool: toolName })
    : isPureThought
      ? (thinking ? t('title.thinking') : t('title.thought'))
      : running
        ? t('title.running', { tool: toolName })
        : toolName;

  const expandable = hasThought || Boolean(step.arguments && Object.keys(step.arguments).length > 0)
    || (!rejected && (obsText || papers.length > 0));

  return (
    <div className={`rounded-lg border bg-background/60 ${failed ? 'border-red-500/30' : 'border-border'}`}>
      {/* 头部：状态图标 + 标题 + 折叠开关 */}
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${expandable ? '' : 'cursor-default'}`}
      >
        <span
          className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded ${
            thinking ? 'bg-primary/15' : running ? 'bg-secondary/15' : failed ? 'bg-red-500/10' : rejected ? 'bg-red-500/10' : 'bg-primary/10'
          }`}
        >
          {thinking ? (
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
          ) : running ? (
            <Loader2 className="w-3 h-3 text-secondary animate-spin" />
          ) : rejected ? (
            <X className="w-3 h-3 text-red-400" />
          ) : failed ? (
            <X className="w-3 h-3 text-red-400" />
          ) : (
            <Check className="w-3 h-3 text-primary" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-textSecondary">
          <span className="font-medium text-text">{headerTitle}</span>
          {rejected && <span className="ml-1 text-textSecondary/60">{t('title.rejectedHint')}</span>}
        </span>
        {expandable && (
          open
            ? <ChevronDown className="w-3 h-3 text-textSecondary flex-shrink-0" />
            : <ChevronRight className="w-3 h-3 text-textSecondary flex-shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-2.5 pb-2 pt-0.5 space-y-1.5 border-t border-border/50 mt-1 pt-1.5">
          {/* Thought：AI 思考原文 */}
          {hasThought && (
            <div className="text-[11px] text-textSecondary/90 leading-relaxed whitespace-pre-wrap border-l-2 border-primary/30 pl-2">
              {step.thought}
              {thinking && <span className="inline-block w-[2px] h-3 ml-0.5 bg-primary align-text-bottom animate-pulse" />}
            </div>
          )}
          {/* Action：工具参数 */}
          {!isPureThought && !rejected && <ArgumentChips args={step.arguments} />}
          {/* Observation：结果 */}
          {!rejected && papers.length > 0 && (
            <ul className="space-y-1">
              {papers.map((p) => (
                <li key={p.id} className="flex items-start gap-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="text-[11px] text-text leading-snug line-clamp-1">{p.title}</span>
                    {(p.authors?.length || p.year || p.citation_count != null) && (
                      <span className="block text-[10px] text-textSecondary/70 truncate">
                        {p.authors?.slice(0, 3).join(', ') || t('paper.unknownAuthors')}
                        {p.year ? ` · ${p.year}` : ''}
                        {p.citation_count != null ? ` · ${t('paper.citationCount', { count: p.citation_count })}` : ''}
                      </span>
                    )}
                  </span>
                  {hasAction && (
                    <span className="flex flex-shrink-0 items-center gap-2 mt-0.5">
                      {onOpenPaper && (
                        <button
                          type="button"
                          onClick={() => onOpenPaper(p)}
                          className="text-[10px] text-secondary underline underline-offset-2 hover:text-secondary/80"
                          title={t('paper.openInReader')}
                        >
                          <ExternalLink className="w-2.5 h-2.5 inline-block" />
                        </button>
                      )}
                      {onAddToContext && (
                        <button
                          type="button"
                          onClick={() => onAddToContext(p)}
                          className="text-[10px] text-accent underline underline-offset-2 hover:text-accent/80"
                          title={t('paper.addToContext')}
                        >
                          <Plus className="w-2.5 h-2.5 inline-block" />
                        </button>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!rejected && papers.length === 0 && obsText && (
            <p className="text-[11px] text-textSecondary/80 leading-relaxed whitespace-pre-wrap line-clamp-4">
              {obsText}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolStepCard;