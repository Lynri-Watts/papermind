/**
 * React Flow 自定义思维导图节点。
 *
 * 两种形态：topic（普通主题）/ paper（论文引用，BookOpen 图标，点击打开阅读器）；
 * 根节点用强调底色。右侧折叠按钮控制子树显隐；双击进入行内编辑。
 * 与画布的交互回调通过 Context 下发，避免回调进 node data 导致节点对象频繁换引用。
 */
import React, { useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MindmapNode as MindmapNodeData } from '../../types';

export type MindmapNodeViewData = {
  /** 文档节点真源；RF 节点的 id/position 由画布从它派生 */
  node: MindmapNodeData;
  hasChildren: boolean;
  selected: boolean;
  editing: boolean;
  dropTarget: boolean;
  readOnly: boolean;
  // React Flow v12 要求 node data 满足 Record<string, unknown>
} & Record<string, unknown>;

export type MindmapFlowNode = Node<MindmapNodeViewData, 'mindmap'>;

export interface MindmapNodeHandlers {
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onToggleCollapsed: (id: string) => void;
  onOpenPaper: (paperId: string) => void;
}

/** 画布提供交互实现；默认值仅为类型安全（画布外渲染不应发生） */
export const MindmapNodeHandlersContext = React.createContext<MindmapNodeHandlers>({
  onStartEdit: () => undefined,
  onCommitEdit: () => undefined,
  onCancelEdit: () => undefined,
  onToggleCollapsed: () => undefined,
  onOpenPaper: () => undefined,
});

const HANDLE_STYLE: React.CSSProperties = {
  width: 8,
  height: 8,
  background: '#64748b',
  border: 'none',
};

const MindmapNodeView: React.FC<NodeProps<MindmapFlowNode>> = ({ id, data }) => {
  const { node, hasChildren, selected, editing, dropTarget, readOnly } = data;
  const handlers = useContext(MindmapNodeHandlersContext);
  const { t } = useTranslation('mindmap');
  const isRoot = node.parentId === null;
  const isPaper = node.kind === 'paper';
  const collapsed = node.collapsed === true;

  const ringClass = dropTarget
    ? 'ring-2 ring-accent border-accent'
    : selected
      ? 'ring-2 ring-primary border-primary'
      : isRoot
        ? 'border-primary/40 hover:border-primary/60'
        : 'border-border hover:border-primary/50';
  const fillClass = isPaper
    ? 'bg-accent/10'
    : isRoot
      ? 'bg-primary/15'
      : 'bg-surface';
  const textClass = isRoot ? 'font-semibold text-text' : 'text-text';

  return (
    <div
      data-mm-node-id={id}
      className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition-colors ${ringClass} ${fillClass}`}
      onDoubleClick={(e) => {
        if (!readOnly) {
          e.stopPropagation();
          handlers.onStartEdit(id);
        }
      }}
    >
      {!isRoot && (
        <Handle type="target" id="in" position={Position.Left} style={HANDLE_STYLE} />
      )}

      {isPaper && (
        <button
          type="button"
          className="flex items-center text-accent hover:text-accent/80 disabled:cursor-default"
          disabled={readOnly}
          title={t('node.openPaper')}
          onClick={(e) => {
            e.stopPropagation();
            if (node.paperId) handlers.onOpenPaper(node.paperId);
          }}
        >
          <BookOpen size={15} />
        </button>
      )}

      {editing ? (
        <NodeTextEditor
          key={`edit-${id}`}
          initialText={node.text}
          placeholder={isRoot ? t('node.rootPlaceholder') : t('node.placeholder')}
          onCommit={(text) => handlers.onCommitEdit(id, text)}
          onCancel={handlers.onCancelEdit}
        />
      ) : (
        <span className={`whitespace-nowrap ${textClass} ${node.text ? '' : 'text-textSecondary/50'}`}>
          {node.text ||
            (isPaper ? t('node.paperPlaceholder') : isRoot ? t('node.rootPlaceholder') : t('node.placeholder'))}
        </span>
      )}

      {hasChildren && !readOnly && !editing && (
        <button
          type="button"
          className="ml-0.5 flex items-center text-textSecondary hover:text-text"
          title={collapsed ? t('node.expand') : t('node.collapse')}
          onClick={(e) => {
            e.stopPropagation();
            handlers.onToggleCollapsed(id);
          }}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
      )}
      {hasChildren && (readOnly || editing) && collapsed && (
        <ChevronRight size={15} className="ml-0.5 text-textSecondary" />
      )}

      {hasChildren && (
        <Handle type="source" id="out" position={Position.Right} style={HANDLE_STYLE} />
      )}
    </div>
  );
};

/** 行内文本编辑：Enter/失焦提交，Esc 取消；编辑期间吞掉画布快捷键 */
const NodeTextEditor: React.FC<{
  initialText: string;
  placeholder: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}> = ({ initialText, placeholder, onCommit, onCancel }) => {
  const [text, setText] = useState(initialText);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={text}
      placeholder={placeholder}
      className="w-40 min-w-[8rem] rounded border border-primary/50 bg-background px-1 py-0.5 text-sm text-text outline-none focus:ring-1 focus:ring-primary"
      data-mm-editing="1"
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(text);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(text)}
    />
  );
};

export default MindmapNodeView;
