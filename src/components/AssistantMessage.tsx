import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Brain, Check, Copy, ExternalLink, Globe, Loader2 } from 'lucide-react';
import { ChatMessage, ToolPaper } from '../types';
import ToolStepCard from './ToolStepCard';

interface AssistantMessageProps {
  message: ChatMessage;
  streamStage: string | null;
  copiedId: string | null;
  onCopy: (id: string, content: string) => void;
  /** 点击 [Source N] 或出处条目时回调，请求打开对应论文并定位原文 */
  onOpenSource?: (sourceIndex: number) => void;
  // ---- ReAct 步骤中返回的论文操作 ----
  /** 把工具返回的某篇论文加入上下文库 */
  onAddToContext?: (paper: ToolPaper) => void;
  /** 在阅读器中打开工具返回的某篇论文 */
  onOpenPaper?: (paper: ToolPaper) => void;
}

/** 识别 markdown 文本中的 [Source N] 引用标签（AI 约定格式） */
const SOURCE_TAG_RE = /\[Source\s*(\d+)\]/gi;

/** 把一段纯文本中的 [Source N] 渲染为可点击的引用徽标（与出处区域联动） */
function InlineSourceTags({ text, onTag }: { text: string; onTag: (n: number) => void }) {
  const { t } = useTranslation('assistant');
  const parts = text.split(/(\[Source\s*\d+\])/gi);
  return (
    <>
      {parts.map((part, i) => {
        SOURCE_TAG_RE.lastIndex = 0;
        const m = SOURCE_TAG_RE.exec(part);
        if (m) {
          const n = Number(m[1]);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onTag(n)}
              className="mx-0.5 inline-flex items-center rounded bg-primary/20 px-1 py-px text-[11px] font-semibold text-primary align-baseline hover:bg-primary/30 hover:underline transition-colors"
              title={t('inlineSource.title', { n })}
            >
              [{n}]
            </button>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}

const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message, streamStage, copiedId, onCopy, onOpenSource,
  onAddToContext, onOpenPaper,
}) => {
  const { t } = useTranslation('assistant');

  // 当前展开的出处编号（点击正文 [Source N] 或出处条目联动）
  const [expandedSource, setExpandedSource] = useState<number | null>(null);

  const toggleSource = (n: number) => {
    setExpandedSource((cur) => (cur === n ? null : n));
  };

  const markdownComponents = useMemo<Components>(() => ({
    text: ({ children }) => (
      <InlineSourceTags text={String(children ?? '')} onTag={toggleSource} />
    ),
    p: ({ children }) => <p className="text-sm leading-relaxed my-1.5">{children}</p>,
    h1: ({ children }) => <h1 className="text-lg font-bold text-text mt-3 mb-1.5">{children}</h1>,
    h2: ({ children }) => <h2 className="text-base font-semibold text-text mt-3 mb-1.5">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-semibold text-text mt-2 mb-1">{children}</h3>,
    h4: ({ children }) => <h4 className="text-sm font-medium text-text mt-2 mb-1">{children}</h4>,
    ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border pl-3 my-1.5 text-textSecondary italic">{children}</blockquote>
    ),
    code: ({ className, children }) => (
      <code className={`${className ?? ''} bg-background/80 text-primary px-1 py-px rounded text-xs`}>
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="bg-background/80 rounded-lg p-3 my-2 overflow-auto text-xs leading-relaxed text-textSecondary">
        {children}
      </pre>
    ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-secondary underline hover:text-secondary/80">
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="text-xs border-collapse w-full">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
    hr: () => <hr className="my-2 border-border" />,
  }), []);

  /** ReAct 轨迹统一渲染：生成中实时展开（thinking/running 自动开），结束后折叠为紧凑记录 */
  const renderReactTrail = () => {
    // 实时轨迹（流式生成中，步骤逐个展开）
    if (message.toolCall && message.toolCall.steps.length > 0) {
      const hasRunning = message.toolCall.steps.some(
        (s) => s.status === 'thinking' || s.status === 'running'
      );
      return (
        <div className="mt-2 mb-1 space-y-1.5">
          <div className="flex items-center gap-1.5 px-0.5">
            <Brain className="w-3 h-3 text-primary" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-textSecondary">
              {t('trail.reactTitle')}
            </span>
            <span className="text-[10px] text-textSecondary/70">
              {t('trail.steps', { count: message.toolCall.steps.length })}
            </span>
            {message.toolCall.cancelling ? (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-red-400">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {t('stopping')}
              </span>
            ) : hasRunning ? (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-secondary">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {streamStage || t('trail.thinking')}
              </span>
            ) : null}
          </div>
          {message.toolCall.steps.map((step) => (
            <ToolStepCard
              key={step.id}
              step={step}
              live={Boolean(message.streaming)}
              onAddToContext={onAddToContext}
              onOpenPaper={onOpenPaper}
            />
          ))}
        </div>
      );
    }
    // 完成后的折叠记录（持久化保留）
    if (message.toolLog && message.toolLog.length > 0) {
      return (
        <div className="mt-2 mb-1 space-y-1.5">
          <div className="flex items-center gap-1.5 px-0.5">
            <Brain className="w-3 h-3 text-primary" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-textSecondary">
              {t('trail.aiTitle')}
            </span>
            <span className="text-[10px] text-textSecondary/70">{t('trail.steps', { count: message.toolLog.length })}</span>
            <span className="ml-auto text-[10px] text-textSecondary/60">{t('trail.expandHint')}</span>
          </div>
          {message.toolLog.map((step) => (
            <ToolStepCard
              key={step.id}
              step={step}
              live={false}
              onAddToContext={onAddToContext}
              onOpenPaper={onOpenPaper}
            />
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        <div className="relative px-4 py-2.5 rounded-xl bg-surface text-text rounded-bl-sm border border-border">
          {/* ReAct 轨迹：置于正文之前（思考/动作/观察先于最终回答出现） */}
          {renderReactTrail()}

          {/* 流式：先展示中间过程 / 纯文本增量；完成后切换 markdown 结构化渲染 */}
          {message.streaming ? (
            message.content ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {message.content}
                <span className="inline-block w-[2px] h-4 ml-0.5 bg-primary align-text-bottom animate-pulse" />
              </p>
            ) : (
              <p className="text-sm text-textSecondary flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {message.toolCall?.cancelling ? t('stopping') : (streamStage || t('stream.processing'))}
              </p>
            )
          ) : (
            <div className="assistant-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
            <span className="text-xs text-textSecondary">
              {new Date(message.timestamp).toLocaleTimeString()}
            </span>
            <button
              onClick={() => onCopy(message.id, message.content)}
              className="p-1 rounded hover:bg-white/10 text-textSecondary hover:text-text transition-colors"
            >
              {copiedId === message.id ? (
                <Check className="w-3 h-3 text-accent" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </div>

          {/* 出处区域：与正文 [Source N] 引用标签联动（高亮 + 展开全文） */}
          {message.sourceDetails && message.sourceDetails.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border/50 space-y-1.5">
              <p className="text-[11px] font-medium text-textSecondary uppercase tracking-wide">
                {t('sources.title')}
              </p>
              {message.sourceDetails.map((src) => {
                const isActive = expandedSource === src.index;
                return (
                  <button
                    key={src.index}
                    type="button"
                    onClick={() => toggleSource(src.index)}
                    className={`w-full text-left text-xs rounded-lg px-2 py-1.5 transition-colors ${
                      isActive
                        ? 'bg-primary/10 border border-primary/30'
                        : 'border border-transparent hover:bg-background/60'
                    }`}
                  >
                    <div className="flex items-center gap-1 mb-0.5">
                      {src.context_id
                        ? <Globe className="w-3 h-3 text-secondary flex-shrink-0" />
                        : <BookOpen className="w-3 h-3 text-primary flex-shrink-0" />}
                      <span className="font-medium text-text/80 truncate flex-1">
                        {src.context_id ? `Context #${src.context_id}` : t('sources.currentPaper')}
                        {src.label ? ` · ${src.label}` : ''}
                      </span>
                      <span className="text-textSecondary/70 text-[10px] font-mono flex-shrink-0">[{src.index}]</span>
                    </div>
                    <p className={`text-accent/90 pl-4 ${isActive ? '' : 'line-clamp-2'}`}>{src.text}</p>
                    {src.text.length > 180 && (
                      <span className="mt-0.5 pl-4 inline-block text-[10px] text-textSecondary/60">
                        {isActive ? t('sources.collapse') : t('sources.expandFull')}
                      </span>
                    )}
                    {src.paper_id && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onOpenSource?.(src.index); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpenSource?.(src.index); } }}
                        className="mt-1 ml-4 inline-flex items-center gap-1 text-[10px] text-secondary underline underline-offset-2 hover:text-secondary/80 cursor-pointer"
                        title={t('sources.openInReaderTitle')}
                      >
                        <ExternalLink className="w-2.5 h-2.5" />
                        {t('sources.locateInPaper')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AssistantMessage;
