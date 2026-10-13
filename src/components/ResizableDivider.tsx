import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ResizableDividerProps {
  /**
   * 被控制面板相对分隔条的位置（决定拖拽方向与尺寸的映射）：
   * - left：面板在分隔条左侧（分隔条是面板的右边缘），向右拖变宽
   * - right：面板在分隔条右侧、贴容器右缘，向右拖变窄
   * - top：面板在分隔条上方，向下拖变高
   * - bottom：面板在分隔条下方、贴容器底缘，向下拖变矮
   */
  placement: 'left' | 'right' | 'top' | 'bottom';
  /** 当前面板尺寸（px），受控 */
  size: number;
  min?: number;
  max?: number;
  /** 拖拽中高频回调；值已按 placement 换算为面板尺寸并完成 clamp/取整 */
  onResize: (nextSize: number) => void;
  /** 拖拽开始/结束（调用方可用于暂停关联重排） */
  onDraggingChange?: (dragging: boolean) => void;
  /** 提供后双击分隔条触发（通常恢复默认尺寸） */
  onDoubleClickReset?: () => void;
  className?: string;
}

/** 命中热区厚度（px）：可见分隔条仅 1px，透明热区向两侧扩展 */
const HIT_AREA = 7;
/** 键盘方向键单步（按住 Shift 时 ×5） */
const KEYBOARD_STEP = 10;

/**
 * 可拖拽分隔条（Pointer Events 实现）。
 *
 * 可靠性要点（替代旧版 window mouse 监听方案）：
 * 1. setPointerCapture：拖拽期间指针事件强制投递给分隔条本身，指针移入
 *    <iframe>（如写作页 PDF 预览）也不会丢 move/up，根除"拖到 PDF 上卡死、
 *    鼠标松手后宽度仍随手移动"的问题；
 * 2. 拖拽时在 body 渲染全屏透明遮罩，双保险阻断 iframe/内容区吞事件与文本选区；
 * 3. 尺寸由"拖拽起点指针位置 + 起点尺寸"绝对计算，不逐帧累加，无丢帧漂移、
 *    不依赖调用方 useRef 或函数式更新规避陈旧闭包；
 * 4. 方向语义由 placement 声明，调用方不再手写 ±dx（旧版四处用法符号不一致，
 *    其中两处写反、一处因闭包陈旧几乎拖不动）；
 * 5. 触摸支持（touch-action:none）、键盘方向键调整、双击重置、ARIA separator。
 */
const ResizableDivider: React.FC<ResizableDividerProps> = ({
  placement,
  size,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  onResize,
  onDraggingChange,
  onDoubleClickReset,
  className = '',
}) => {
  const horizontal = placement === 'top' || placement === 'bottom';
  /** 分隔条正向移动（右/下）时面板尺寸的系数：贴左/上侧的面板 +1，贴右/底侧 -1 */
  const growSign = placement === 'left' || placement === 'top' ? 1 : -1;

  const barRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 本次拖拽的不可变上下文：起点指针坐标、起点尺寸、pointerId、最近一次上报值 */
  const dragRef = useRef<{ pointerId: number; startPos: number; startSize: number; last: number } | null>(null);

  const clampSize = useCallback(
    (v: number) => Math.round(Math.max(min, Math.min(max, v))),
    [min, max],
  );

  const finishDrag = useCallback((releaseTarget: HTMLElement | null, pointerId: number) => {
    if (releaseTarget && releaseTarget.hasPointerCapture?.(pointerId)) {
      try {
        releaseTarget.releasePointerCapture(pointerId);
      } catch {
        /* 捕获已被浏览器释放，忽略 */
      }
    }
    dragRef.current = null;
    setDragging(false);
    onDraggingChange?.(false);
  }, [onDraggingChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // 仅主键（左键/触摸/笔）
    e.preventDefault();
    dragRef.current = {
      pointerId: e.pointerId,
      startPos: horizontal ? e.clientY : e.clientX,
      startSize: size,
      last: size,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持捕获的环境退化为遮罩 + 事件监听，仍可工作 */
    }
    setDragging(true);
    onDraggingChange?.(true);
  }, [horizontal, size, onDraggingChange]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const pos = horizontal ? e.clientY : e.clientX;
    const next = clampSize(drag.startSize + (pos - drag.startPos) * growSign);
    if (next !== drag.last) {
      drag.last = next;
      onResize(next);
    }
  }, [horizontal, growSign, clampSize, onResize]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    finishDrag(e.currentTarget, e.pointerId);
  }, [finishDrag]);

  /** 系统中断（如浏览器手势抢占）时同样收尾，避免 dragging 卡死 */
  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    finishDrag(e.currentTarget, e.pointerId);
  }, [finishDrag]);

  // 拖拽期间锁定 body 光标、禁止文本选区（覆盖 iframe/编辑器等一切子区域）
  useEffect(() => {
    if (!dragging) return;
    const { body } = document;
    const prevCursor = body.style.cursor;
    const prevUserSelect = body.style.userSelect;
    body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
    body.style.userSelect = 'none';
    return () => {
      body.style.cursor = prevCursor;
      body.style.userSelect = prevUserSelect;
    };
  }, [dragging, horizontal]);

  // 失焦兜底：指针在窗口外松开导致事件缺失时，窗口重新获得焦点即结束拖拽
  useEffect(() => {
    if (!dragging) return;
    const onBlur = () => {
      const drag = dragRef.current;
      if (drag) finishDrag(barRef.current, drag.pointerId);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [dragging, finishDrag]);

  // 键盘可达性：方向键步进，Shift 加速
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEYBOARD_STEP * 5 : KEYBOARD_STEP;
    let next: number | null = null;
    if (!horizontal && e.key === 'ArrowRight') next = size + step * growSign;
    else if (!horizontal && e.key === 'ArrowLeft') next = size - step * growSign;
    else if (horizontal && e.key === 'ArrowDown') next = size + step * growSign;
    else if (horizontal && e.key === 'ArrowUp') next = size - step * growSign;
    if (next !== null) {
      e.preventDefault();
      onResize(clampSize(next));
    }
  }, [horizontal, growSign, size, onResize, clampSize]);

  // 透明热区向两侧扩展（不占布局空间）
  const hitSpread = (HIT_AREA - 1) / 2;
  const hitStyle: React.CSSProperties = horizontal
    ? { position: 'absolute', top: `-${hitSpread}px`, left: 0, right: 0, height: HIT_AREA }
    : { position: 'absolute', left: `-${hitSpread}px`, top: 0, bottom: 0, width: HIT_AREA };

  return (
    <>
      <div
        ref={barRef}
        role="separator"
        aria-orientation={horizontal ? 'horizontal' : 'vertical'}
        aria-valuenow={Math.round(size)}
        aria-valuemin={Math.round(min)}
        aria-valuemax={max === Number.MAX_SAFE_INTEGER ? undefined : Math.round(max)}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={(e) => {
          const drag = dragRef.current;
          if (drag && e.pointerId === drag.pointerId) finishDrag(e.currentTarget, e.pointerId);
        }}
        onKeyDown={handleKeyDown}
        onDoubleClick={onDoubleClickReset}
        className={[
          'relative z-10 flex-shrink-0 touch-none select-none outline-none',
          'focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset',
          horizontal ? 'h-1 w-full cursor-row-resize' : 'w-1 h-full cursor-col-resize',
          dragging ? 'bg-accent/70' : 'bg-transparent hover:bg-accent/50',
          'transition-colors',
          className,
        ].join(' ')}
      >
        <span aria-hidden="true" style={hitStyle} className="touch-none" />
      </div>

      {/* 拖拽遮罩：全屏透明层阻断 iframe（PDF 预览等）与内容区吞事件/文本选区。
          指针已被 capture 定向到分隔条，遮罩本身不影响 move/up 投递 */}
      {dragging && createPortal(
        <div
          aria-hidden="true"
          className="fixed inset-0 z-[9999]"
          style={{
            cursor: horizontal ? 'row-resize' : 'col-resize',
            touchAction: 'none',
            userSelect: 'none',
          }}
        />,
        document.body,
      )}
    </>
  );
};

export default ResizableDivider;
