import React from 'react';
import WritingWorkspace from '../components/writing/WritingWorkspace';

/**
 * 创作页：多文件 LaTeX 写作工作区
 * （左文件树 ｜ 中标签页编辑器 ｜ 右实时预览/编译 PDF，宽度可拖拽）。
 */
const Workspace: React.FC = () => {
  return (
    <div className="h-full overflow-x-auto" style={{ minWidth: '960px' }}>
      <div className="h-full">
        <WritingWorkspace />
      </div>
    </div>
  );
};

export default Workspace;
