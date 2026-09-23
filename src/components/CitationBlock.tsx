import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BookOpen, Globe, Loader2, MapPin, Quote } from 'lucide-react';
import { RagSource } from '../types';
import { CitationState } from '../utils/inlineCitations';

interface CitationCardProps {
  state: CitationState;
  /** bound 态出处编号（对应 RagSource.index，1-based） */
  sourceIndex?: number;
  /** 卡片展示的原句（bound=分块真实原句；pending/failed=模型输出文字） */
  quote: string;
  /** 出处元数据（sources 事件先于终态到达；未到时不显示来源名） */
  source?: RagSource;
  /** 点击「定位原文」 */
  onLocate?: () => void;
}

/**
 * 引用卡完整内容（悬浮层内）：三态——
 * pending=核对中（流式中，出处尚未绑定）；
 * bound=已绑定出处（来源名 + 定位原文）；
 * failed=核对失败（材料中找不到该句，只展示模型文字、不可定位）。
 */
export const CitationCard: React.FC<CitationCardProps> = ({
  state, sourceIndex, quote, source, onLocate,
}) => {
  const { t } = useTranslation('assistant');

  if (state === 'failed') {
    return (
      <div className="w-72 rounded-lg border border-amber-500/40 bg-surface px-2.5 py-1.5 shadow-lg">
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3 flex-shrink-0 text-amber-400" />
          <span className="text-xs font-medium text-amber-300">
            {t('citation.failedTitle')}
          </span>
        </div>
        {quote && (
          <p className="mt-1 border-l-2 border-amber-500/40 pl-2 text-xs leading-relaxed text-text/80">
            {quote}
          </p>
        )}
        <p className="mt-1 text-[10px] leading-relaxed text-textSecondary">
          {t('citation.failedNote')}
        </p>
      </div>
    );
  }

  if (state === 'pending') {
    return (
      <div className="w-72 rounded-lg border border-primary/25 bg-surface px-2.5 py-1.5 shadow-lg">
        <div className="flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
          <span className="text-xs font-medium text-primary">
            {t('citation.verifying')}
          </span>
        </div>
        {quote && (
          <p className="mt-1 border-l-2 border-primary/30 pl-2 text-xs leading-relaxed text-text/70">
            {quote}
          </p>
        )}
      </div>
    );
  }

  const locateable = Boolean(source?.paper_id);
  const name = source
    ? `${source.context_id ? `Context #${source.context_id}` : t('sources.currentPaper')}${source.label ? ` · ${source.label}` : ''}`
    : `#${sourceIndex ?? '-'}`;

  return (
    <div className="w-72 rounded-lg border border-primary/25 bg-surface px-2.5 py-1.5 shadow-lg">
      <div className="flex items-center gap-1.5">
        {source?.context_id
          ? <Globe className="h-3 w-3 flex-shrink-0 text-secondary" />
          : <BookOpen className="h-3 w-3 flex-shrink-0 text-primary" />}
        <span className="flex-1 truncate text-xs font-medium text-text/80">{name}</span>
        {locateable && (
          <button
            type="button"
            onClick={onLocate}
            className="flex flex-shrink-0 items-center gap-0.5 rounded border border-primary/40 bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/30"
            title={t('sources.openInReaderTitle')}
          >
            <MapPin className="h-2.5 w-2.5" />
            {t('sources.locateInPaper')}
          </button>
        )}
      </div>
      {quote && (
        <p className="mt-1 border-l-2 border-primary/30 pl-2 text-xs leading-relaxed text-accent/90">
          {quote}
        </p>
      )}
    </div>
  );
};

interface CitationMarkerProps extends CitationCardProps {}

/**
 * 句中行内引用标记：一个融入文字流的小 chip，hover / 键盘聚焦 / 点击
 * 时在上方展开完整引用卡。引用是句子的一部分，不占行、不断句。
 */
const CitationMarker: React.FC<CitationMarkerProps> = (props) => {
  const [pinned, setPinned] = useState(false);
  const tone =
    props.state === 'failed'
      ? 'border-amber-500/50 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
      : props.state === 'pending'
        ? 'border-primary/50 bg-primary/10 text-primary animate-pulse'
        : 'border-primary/50 bg-primary/15 text-primary hover:bg-primary/30';

  return (
    <span
      className={`group/cite relative inline-flex align-baseline ${pinned ? 'z-50' : ''}`}
    >
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        className={`mx-0.5 inline-flex h-[18px] w-[18px] items-center justify-center self-center rounded-full border transition-colors ${tone}`}
        aria-label="citation"
      >
        {props.state === 'failed'
          ? <AlertTriangle className="h-2.5 w-2.5" />
          : <Quote className="h-2.5 w-2.5" />}
      </button>
      <span
        className={`pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2
          transition-opacity duration-150
          ${pinned
            ? 'pointer-events-auto opacity-100'
            : 'opacity-0 group-hover/cite:pointer-events-auto group-hover/cite:opacity-100 group-focus-within/cite:opacity-100'}`}
      >
        <CitationCard {...props} onLocate={() => { props.onLocate?.(); setPinned(false); }} />
      </span>
    </span>
  );
};

export default CitationMarker;
