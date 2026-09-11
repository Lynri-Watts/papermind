import React, { useCallback, useEffect, useRef } from 'react';

interface ResizableDividerProps {
  /** 拖拽增量回调（dx>0 表示分隔条**右侧**的面板变宽；组件内部计算每次移动的增量） */
  onDelta: (dx: number) => void;
  /** 拖拽结束（用于松手后提交等） */
  onDragEnd?: () => void;
  /** 拖拽状态变化（用于分隔条高亮） */
  onDraggingChange?: (dragging: boolean) => void;
  /** 横向分隔条（上下分栏）；默认垂直 */
  horizontal?: boolean;
  className?: string;
}

/**
 * 可拖拽分隔条：按住拖动实时回调增量，内部管理 window 级鼠标监听。
 *
 * 供 QAPanel（AI 面板宽度）、Explore（左栏宽度）、Workspace（预览宽度）
 * 等所有可调宽面板复用，避免各处重复实现 mousemove/mouseup 监听逻辑。
 */
const ResizableDivider: React.FC<ResizableDividerProps> = ({
  onDelta,
  onDragEnd,
  onDraggingChange,
  horizontal = false,
  className = '',
}) => {
  const startRef = useRef<{ pos: number }>({ pos: 0 });

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const cur = horizontal ? e.clientY : e.clientX;
    const dx = cur - startRef.current.pos;
    startRef.current.pos = cur;
    if (dx !== 0) onDelta(dx);
  }, [horizontal, onDelta]);

  const handleMouseUp = useCallback(() => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
    onDraggingChange?.(false);
    onDragEnd?.();
  }, [handleMouseMove, onDraggingChange, onDragEnd]);

  useEffect(() => () => {
    // 卸载兜底：避免组件卸载后 window 监听残留
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove, handleMouseUp]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startRef.current = { pos: horizontal ? e.clientY : e.clientX };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    onDraggingChange?.(true);
  }, [horizontal, handleMouseMove, handleMouseUp, onDraggingChange]);

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      onMouseDown={handleMouseDown}
      className={[
        'flex-shrink-0 select-none transition-colors',
        horizontal
          ? 'h-1 w-full cursor-row-resize hover:bg-accent/50 active:bg-accent/70'
          : 'w-1 h-full cursor-col-resize hover:bg-accent/50 active:bg-accent/70',
        className,
      ].join(' ')}
    />
  );
};

export default ResizableDivider;
