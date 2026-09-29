/**
 * React Flow 自定义思维导图节点。
 *
 * 视觉与 mermaid mindmap classic look 同源：
 * - 形状由 node.shape 决定：default=药丸底色块 / rect=方角矩形 / rounded=小圆角 /
 *   circle=圆形 / hexagon=左右尖六边形（clip-path，尖点比例实测自 mermaid）；
 *   根节点恒为圆形；
 * - 配色按「根分支 section」（一级分支序 % 11）取 mermaid dark 主题实测色，
 *   颜色本身由画布经 sectionOfNodes 结构推导，不依赖一次离屏渲染；
 * - 刚完成 mermaid 同源布局时画布传入 measured（实测宽高/填充/文字色），
 *   节点严格按官方尺寸渲染；用户拖拽/增补后 measured 失效，节点回退自适应尺寸；
 * - paper 节点是强化卡片：同 section 底色 + accent 描边 + BookOpen 徽标，点击打开阅读器。
 *
 * 右侧折叠按钮控制子树显隐；双击进入行内编辑。交互回调通过 Context 下发，
 * 避免回调进 node data 导致节点对象频繁换引用。
 */
import React, { useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MindmapNode as MindmapNodeData, MindmapNodeShape } from '../../types';
import { ROOT_TEXT, SECTION_TEXT, fillForSection } from '../../lib/mindmap';

/** 六边形尖点水平内缩比例（实测 mermaid polygon：11/115.8 ≈ 9.5%，尖在左右中点） */
const HEXAGON_CLIP = 'polygon(9.5% 0, 90.5% 0, 100% 50%, 90.5% 100%, 9.5% 100%, 0 50%)';
const PRIMARY_COLOR = '#3B82F6';
const ACCENT_COLOR = '#10B981';

export type MindmapNodeMeasured = {
  width: number;
  height: number;
  fill: string;
  textColor: string;
};

export type MindmapNodeViewData = {
  /** 文档节点真源；RF 节点的 id/position 由画布从它派生 */
  node: MindmapNodeData;
  hasChildren: boolean;
  selected: boolean;
  editing: boolean;
  readOnly: boolean;
  /** 所属根分支（root=null，其余 0..10），决定配色 */
  section: number | null;
  /** mermaid 实测几何存在时严格按官方尺寸/配色渲染 */
  measured?: MindmapNodeMeasured;
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
  opacity: 0,
};

/** 各形状在「无实测尺寸」时的自适应内边距（mermaid 测量尺寸存在时内边距由固定宽高吸收） */
const AUTO_PADDING: Record<MindmapNodeShape, string> = {
  circle: 'px-4 py-2.5',
  rect: 'px-3.5 py-2',
  rounded: 'px-3.5 py-2',
  hexagon: 'px-7 py-2',
  default: 'px-3.5 py-1.5',
};
const MEASURED_PADDING: Record<MindmapNodeShape, string> = {
  circle: 'px-2',
  rect: 'px-3.5',
  rounded: 'px-3.5',
  hexagon: 'px-4',
  default: 'px-3.5',
};
const RADIUS: Record<MindmapNodeShape, number> = {
  circle: 9999,
  rect: 0,
  rounded: 5,
  hexagon: 0,
  default: 18,
};

const MindmapNodeView: React.FC<NodeProps<MindmapFlowNode>> = ({ id, data }) => {
  const { node, hasChildren, selected, editing, readOnly, section, measured } = data;
  const handlers = useContext(MindmapNodeHandlersContext);
  const { t } = useTranslation('mindmap');
  const isRoot = node.parentId === null;
  const isPaper = node.kind === 'paper';
  const collapsed = node.collapsed === true;

  // 根恒圆；paper 在 mermaid 中按矩形渲染（伪链接不合法），GUI 强化为矩形卡片
  const visual: MindmapNodeShape = isRoot ? 'circle' : (node.shape ?? 'default');
  const isHexagon = visual === 'hexagon';

  const fill = measured?.fill ?? fillForSection(section);
  const textColor = measured?.textColor ?? (isRoot ? ROOT_TEXT : SECTION_TEXT);

  const boxStyle: React.CSSProperties = {
    boxSizing: 'border-box',
    fontSize: 16,
    lineHeight: '24px',
    background: fill,
    color: textColor,
    borderRadius: RADIUS[visual],
  };
  if (measured) {
    boxStyle.width = measured.width;
    boxStyle.height = measured.height;
  }
  if (isHexagon) {
    boxStyle.clipPath = HEXAGON_CLIP;
    boxStyle.borderRadius = 0;
  }
  if (isPaper) {
    // paper 卡片：accent 描边（hexagon 不可能是 paper，描边不会被 clip）
    boxStyle.border = `2px solid ${ACCENT_COLOR}`;
  }
  // 选中反馈：普通形状外描边阴影；六边形描边会被 clip，改用 drop-shadow
  if (selected) {
    if (isHexagon) {
      boxStyle.filter = `drop-shadow(0 0 3px ${PRIMARY_COLOR})`;
    } else {
      boxStyle.boxShadow = `0 0 0 2px ${PRIMARY_COLOR}`;
    }
  }

  const paddingClass = measured ? MEASURED_PADDING[visual] : AUTO_PADDING[visual];
  // 无实测尺寸时圆形随文字成椭圆即可；有实测尺寸时宽高已相等为正圆
  const labelClass = measured
    ? 'min-w-0 flex-1 break-words text-center'
    : 'whitespace-nowrap';

  return (
    <div
      data-mm-node-id={id}
      style={boxStyle}
      className={`flex items-center justify-center gap-1.5 ${paddingClass} transition-[filter] hover:brightness-110`}
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
          className="flex shrink-0 items-center disabled:cursor-default"
          style={{ color: ACCENT_COLOR }}
          disabled={readOnly}
          title={t('node.openPaper')}
          onClick={(e) => {
            e.stopPropagation();
            if (node.paperId) handlers.onOpenPaper(node.paperId);
          }}
        >
          <BookOpen size={16} />
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
        <span className={`${labelClass} ${isRoot ? 'font-semibold' : 'font-normal'} ${node.text ? '' : 'opacity-50'}`}>
          {node.text ||
            (isPaper ? t('node.paperPlaceholder') : isRoot ? t('node.rootPlaceholder') : t('node.placeholder'))}
        </span>
      )}

      {hasChildren && !readOnly && !editing && (
        <button
          type="button"
          className="ml-0.5 flex shrink-0 items-center opacity-60 transition-opacity hover:opacity-100"
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
        <ChevronRight size={15} className="ml-0.5 shrink-0 opacity-60" />
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
