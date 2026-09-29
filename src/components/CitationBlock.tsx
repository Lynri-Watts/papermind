import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BookOpen, Globe, Loader2, MapPin } from 'lucide-react';
import { RagSource } from '../types';
import { CitationState } from '../utils/inlineCitations';

interface CitationCardProps {
  state: CitationState;
  /** bound 态出处编号（对应 RagSource.index，1-based） */
  sourceIndex?: number;
  /** 悬浮卡展示的逐字原句（bound=核对通过的原句；pending/failed=模型输出文字） */
  quote: string;
  /** 出处元数据（sources 事件先于终态到达；未到时不显示来源名） */
  source?: RagSource;
  /** 点击「定位原文」 */
  onLocate?: () => void;
}

/**
 * 引用卡完整内容（悬停窗口内）：三态——
 * pending=核对中（流式中，出处尚未绑定）；
 * bound=已绑定出处（来源名 + 逐字原句 + 定位原文）；
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

interface CitationMarkerProps extends CitationCardProps {
  /** 行内显示文字（模型随引用生成的短转述/中心句）；空串时回退为显示逐字原句 */
  display: string;
}

/** 鼠标从行内文字移到悬浮窗之间允许的空档（毫秒） */
const HOVER_CLOSE_DELAY_MS = 160;
/** 悬浮窗与视口边缘的安全距离（像素） */
const VIEWPORT_MARGIN_PX = 8;
/** 悬浮窗与锚点之间的间距（像素） */
const ANCHOR_GAP_PX = 6;

/**
 * 句中行内引用：直接把**行内文字**显示在回答里（主色 + 淡底，与正文颜色区分），
 * 读起来是句子的一部分；鼠标悬停（或键盘聚焦）时才展开窗口显示**逐字原句**、
 * 出处名与「定位原文」。
 *
 * 悬浮窗经 portal 挂到 body 并用 fixed 定位（按锚点矩形上下翻转、水平钳制在
 * 视口内）：此前的 absolute 方案会被问答区的滚动容器（overflow-auto）从边界
 * 裁掉，长引文显示不全。点击页面其他任意位置或按 Esc 关闭。
 */
const CitationMarker: React.FC<CitationMarkerProps> = (props) => {
  const { state, sourceIndex, quote, display, source, onLocate } = props;
  const inlineText = display || quote;

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const anchorRef = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  // 延时关闭/文档级监听读最新固定态，避免闭包陈旧
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closeNow = useCallback(() => {
    cancelClose();
    setPinned(false);
    setOpen(false);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    if (pinnedRef.current) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);

  const handleOpen = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  /** 按锚点矩形定位悬浮窗：优先上方，空间不足翻到下方，最后整体钳制在视口内。 */
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return;
    const a = anchor.getBoundingClientRect();
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const above = a.top - VIEWPORT_MARGIN_PX;
    const below = vh - a.bottom - VIEWPORT_MARGIN_PX;
    let top = above >= h + ANCHOR_GAP_PX || above >= below
      ? a.top - ANCHOR_GAP_PX - h
      : a.bottom + ANCHOR_GAP_PX;
    top = Math.max(VIEWPORT_MARGIN_PX, Math.min(top, vh - h - VIEWPORT_MARGIN_PX));
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(a.left + a.width / 2 - w / 2, vw - w - VIEWPORT_MARGIN_PX),
    );
    setPos({ top, left });
  }, []);

  // layout effect：绘制前完成测量定位，首次展开不会在错误位置闪一帧
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, quote, display, state, sourceIndex, source]);

  // 展开期间跟随滚动（含内层容器，用捕获阶段）与窗口缩放
  useEffect(() => {
    if (!open) return;
    const onChange = () => updatePosition();
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [open, updatePosition]);

  // 点击其他任意位置（捕获阶段先于内部按钮的 click）/ Esc 关闭悬浮窗
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      closeNow();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNow();
    };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeNow]);

  // 关闭后丢弃坐标：下次展开重新测量（避免用旧位置渲染一帧）
  useEffect(() => {
    if (!open) setPos((p) => (p === null ? p : null));
  }, [open]);

  const handleClick = () => {
    // 拖选文本时浏览器也会补一个 click：此时不视为"点击引用"，不固定悬浮窗
    if (!window.getSelection()?.isCollapsed) return;
    if (pinned) {
      setPinned(false);
      scheduleClose();
      return;
    }
    cancelClose();
    setPinned(true);
    setOpen(true);
  };

  const stateTone =
    state === 'failed'
      ? 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'
      : state === 'pending'
        ? 'text-primary bg-primary/10 animate-pulse'
        : 'text-primary bg-primary/10 hover:bg-primary/20';
  const underline = open
    ? 'underline decoration-dotted decoration-current underline-offset-2'
    : 'hover:underline decoration-dotted underline-offset-2';

  return (
    <>
      <span
        ref={anchorRef}
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onMouseEnter={handleOpen}
        onMouseLeave={scheduleClose}
        onFocus={handleOpen}
        onBlur={scheduleClose}
        className={`mx-0.5 inline cursor-pointer rounded px-1 py-px align-baseline transition-colors ${stateTone} ${underline}`}
      >
        {state === 'failed' && (
          <AlertTriangle className="mr-0.5 inline-block h-3 w-3 -translate-y-px" />
        )}
        {inlineText}
      </span>
      {open && createPortal(
        <div
          ref={popupRef}
          className="fixed z-[60]"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? 'visible' : 'hidden',
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <CitationCard
            state={state}
            sourceIndex={sourceIndex}
            quote={quote}
            source={source}
            onLocate={() => {
              onLocate?.();
              closeNow();
            }}
          />
        </div>,
        document.body,
      )}
    </>
  );
};

export default CitationMarker;
