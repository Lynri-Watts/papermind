import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, Check, Copy, Info, Loader2 } from 'lucide-react';
import { ChatMessage, ChatMindmapEdit, RagSource, ToolPaper } from '../types';
import ToolStepCard from './ToolStepCard';
import AiMindmapEditBar from './mindmap/AiMindmapEditBar';
import CitationMarker from './CitationBlock';
import {
  protectCitations,
  remarkCitationCards,
  splitInlineCitations,
  stripInlineCitations,
  stripLegacySourceTags,
} from '../utils/inlineCitations';

interface AssistantMessageProps {
  message: ChatMessage;
  streamStage: string | null;
  copiedId: string | null;
  onCopy: (id: string, content: string) => void;
  /** 点击引用卡「定位原文」：sourceIndex 对应 RagSource.index，quote 为卡片原句 */
  onOpenSource?: (sourceIndex: number, quote?: string) => void;
  // ---- ReAct 步骤中返回的论文操作 ----
  /** 把工具返回的某篇论文加入上下文库 */
  onAddToContext?: (paper: ToolPaper) => void;
  /** 在阅读器中打开工具返回的某篇论文 */
  onOpenPaper?: (paper: ToolPaper) => void;
  /** 撤销/保留本次回答对某张导图的 AI 编辑 */
  onMindmapEditChange?: (messageId: string, mapId: string, patch: Partial<ChatMindmapEdit>) => void;
}

/** remark 自定义节点 <citecard> 透传来的属性（hast 属性名为全小写） */
interface CiteCardNodeProps {
  state: 'pending' | 'bound' | 'failed';
  sourceindex?: number;
  quote?: string;
}

const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message, streamStage, copiedId, onCopy, onOpenSource,
  onAddToContext, onOpenPaper, onMindmapEditChange,
}) => {
  const { t } = useTranslation('assistant');

  /**
   * 行内分段：把正文按 [Q]...[/Q] / [Q+n]...[/Q] / [Q!]...[/Q] 切成
   * 「正文段 / 引用段」。流式中以纯文本 + 行内标记渲染（标记可位于句中）；
   * 完成后整段正文走 markdown 管线（标记经 remark 插件替换为同样的组件）。
   */
  const segments = useMemo(
    () => splitInlineCitations(message.content),
    [message.content],
  );

  // 序号 -> 出处元数据（sources 事件先于 delta 到达，生成中即可定位/显名）
  const sourceMap = useMemo(() => {
    const map = new Map<number, RagSource>();
    for (const src of message.sourceDetails ?? []) map.set(src.index, src);
    return map;
  }, [message.sourceDetails]);

  /**
   * 终态 markdown：先剔除旧版 [Source N]，再把引用块替换为 PUA 占位符
   * （摘录内的 markdown 敏感字符不会破坏解析），remark 插件在 AST 内
   * 把占位符替换成 <citecard> 自定义节点 → CitationMarker。
   */
  const protectedMd = useMemo(
    () => protectCitations(stripLegacySourceTags(message.content)),
    [message.content],
  );
  const remarkPlugins = useMemo<
    NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']>
  >(
    // 元组形式 [plugin, options]：unified 以 registry 为参数调用 attacher
    () => [remarkGfm, [remarkCitationCards, protectedMd.registry]],
    [protectedMd.registry],
  );

  const renderMarker = (
    key: React.Key,
    cite: { state: 'pending' | 'bound' | 'failed'; sourceIndex?: number; quote: string },
  ) => (
    <CitationMarker
      key={key}
      state={cite.state}
      sourceIndex={cite.sourceIndex}
      quote={cite.quote}
      source={cite.sourceIndex != null ? sourceMap.get(cite.sourceIndex) : undefined}
      onLocate={
        cite.sourceIndex != null
          ? () => onOpenSource?.(cite.sourceIndex!, cite.quote)
          : undefined
      }
    />
  );

  const markdownComponents = useMemo(() => ({
    // 自定义节点：行内引用标记（可出现在句子中间、列表项、表格单元格内）
    citecard: (props: CiteCardNodeProps) => renderMarker(
      `cite-${props.state}-${props.sourceindex ?? 'x'}-${props.quote}`,
      {
        state: props.state,
        sourceIndex: typeof props.sourceindex === 'number' ? props.sourceindex : undefined,
        quote: props.quote ?? '',
      },
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
  // citecard 是 remark 插件注入的自定义标签，不在 Components 已知标签联合内
  }) as Components, [sourceMap, onOpenSource]);

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

  const hasBody = segments.some((s) =>
    s.type === 'cite' || stripLegacySourceTags(s.text).length > 0
  );

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        <div className="relative px-4 py-2.5 rounded-xl bg-surface text-text rounded-bl-sm border border-border">
          {/* ReAct 轨迹：置于正文之前（思考/动作/观察先于最终回答出现） */}
          {renderReactTrail()}

          {/* 非阻断提示：如本次问答无可用文献材料、已降级为通用知识回答 */}
          {message.notice && (
            <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300">
              <Info className="mt-px h-3 w-3 flex-shrink-0" />
              <span>{message.notice}</span>
            </div>
          )}

          {/* 正文：流式中为纯文本流 + 句中行内引用标记；完成后整段 markdown
              （引用标记经 remark 插件内联注入，markdown 语法可跨标记成对） */}
          {message.streaming && !hasBody ? (
            <p className="text-sm text-textSecondary flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {message.toolCall?.cancelling ? t('stopping') : (streamStage || t('stream.processing'))}
            </p>
          ) : message.streaming ? (
            <div className="text-sm leading-relaxed whitespace-pre-wrap">
              {segments.map((seg, i) =>
                seg.type === 'text' ? (
                  <React.Fragment key={i}>{stripLegacySourceTags(seg.text)}</React.Fragment>
                ) : (
                  renderMarker(i, seg.citation)
                ),
              )}
              <span className="inline-block w-[2px] h-4 ml-0.5 bg-primary align-text-bottom animate-pulse" />
            </div>
          ) : (
            <div className="assistant-markdown">
              <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                {protectedMd.markdown}
              </ReactMarkdown>
            </div>
          )}

          {/* AI 思维导图编辑：一问一事务的撤销/保留条 */}
          {message.mindmapEdits && message.mindmapEdits.length > 0 && onMindmapEditChange && (
            <AiMindmapEditBar
              edits={message.mindmapEdits}
              locked={Boolean(message.streaming)}
              onChange={(mapId, patch) => onMindmapEditChange(message.id, mapId, patch)}
            />
          )}

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
            <span className="text-xs text-textSecondary">
              {new Date(message.timestamp).toLocaleTimeString()}
            </span>
            <button
              onClick={() => onCopy(message.id, stripInlineCitations(message.content))}
              className="p-1 rounded hover:bg-white/10 text-textSecondary hover:text-text transition-colors"
            >
              {copiedId === message.id ? (
                <Check className="w-3 h-3 text-accent" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AssistantMessage;
