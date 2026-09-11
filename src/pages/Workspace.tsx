import React, { useState, useRef } from 'react';
import LatexEditor from '../components/LatexEditor';
import PaperPreview from '../components/PaperPreview';
import ResizableDivider from '../components/ResizableDivider';

const Workspace: React.FC = () => {
  // 预览面板宽度（可拖拽调整：200-560，默认 280 让位给 LaTeX 编辑器）
  const [rightWidth, setRightWidth] = useState(280);
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className="h-full flex gap-0 overflow-x-auto"
      style={{ minWidth: '700px' }}
    >
      <div className="flex-1 min-w-[300px] overflow-hidden">
        <LatexEditor />
      </div>

      {/* 可拖拽分隔条：调宽论文预览 */}
      <ResizableDivider
        onDelta={(dx) => setRightWidth(Math.max(200, Math.min(560, rightWidth + dx)))}
      />

      <div
        className="flex-shrink-0 overflow-hidden"
        style={{ width: `${rightWidth}px` }}
      >
        <PaperPreview />
      </div>
    </div>
  );
};

export default Workspace;
