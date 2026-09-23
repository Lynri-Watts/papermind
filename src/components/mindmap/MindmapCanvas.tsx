/**
 * 思维导图几何画布（React Flow）。
 *
 * - 文档单向派生：doc → RF nodes/edges；拖拽位置仅在拖动期间用本地 override 渲染，
 *   dragStop 才合成动作落文档（避免每个拖动帧产生历史/请求）；
 * - 拖到另一节点上（data-mm-node-id 命中）= reparent，落点绿色高亮，自身/后代拒绝；
 * - 滚轮上滑放大（React Flow 默认方向，显式声明）；
 * - 键盘：Tab 子主题 / Enter 同级 / Delete 删除（promote）/ F2、双击编辑 /
 *   Ctrl+Z、Ctrl+Shift+Z 撤销重做；
 * - 加载态、错误重试、保存状态与工具提示都走 mindmap i18n 命名空间。
 * 可视化交互不在自动化测试范围，由用户手动验收（Task 7 TR）。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle,
  Code2,
  ListPlus,
  Loader2,
  Maximize,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  Wand2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { XYPosition } from '@xyflow/system';
import type { MindmapAction, MindmapDoc, MindmapInfo, MindmapNode } from '../../types';
import { descendantIds } from '../../lib/mindmap';
import { usePaperMindStore } from '../../store';
import MindmapNodeView, {
  MindmapNodeHandlersContext,
  type MindmapFlowNode,
} from './MindmapNode';
import { useMindmapEditor } from './useMindmapEditor';
import MindmapCodePanel from './MindmapCodePanel';

/** 画布对外的命令式入口：代码面板、AI SSE diff 与页面工具栏通过它驱动编辑器 */
export interface MindmapCanvasHandle {
  getDoc: () => MindmapDoc;
  /** 代码面板「应用」/整份导入：差异以用户编辑身份进入历史与保存管线 */
  adoptUserTarget: (target: MindmapDoc) => void;
  /** AI 实时编辑（SSE mindmap_diff）：即时落图，不进用户撤销栈、不入保存队列 */
  applyExternalDiff: (
    actions: MindmapAction[],
    serverIdMap?: Record<string, string>,
    version?: number
  ) => void;
  relayout: () => void;
  fitView: () => void;
  /** 外部全量变更（AI 事务撤销）：强制拉取服务端最新文档并对账 */
  reloadFromServer: () => Promise<void>;
}

const NODE_TYPES = { mindmap: MindmapNodeView };

/** React Flow 回传原生事件（鼠标或触摸），统一取出触点坐标 */
function pointOf(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ('touches' in event) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 };
  }
  return { x: event.clientX, y: event.clientY };
}

export interface MindmapCanvasProps {
  mapId: string;
  workspaceId?: string | null;
  readOnly?: boolean;
  /** paper 节点点击：默认无动作（Task 10 接阅读器） */
  onOpenPaper?: (paperId: string) => void;
  /** 显示右侧 mermaid 代码面板（与几何画布双向融合） */
  showCodePanel?: boolean;
  /** 传入即显示工具栏中的代码面板开关按钮 */
  onToggleCodePanel?: () => void;
  /** 代码面板宽度（Tailwind 宽度类，如 'w-[420px]'），默认 w-[380px] */
  codePanelWidthClass?: string;
  className?: string;
}

/** 加载器：确保文档在 store 缓存中后挂载编辑器（换图即整体重挂载，状态干净） */
const MindmapCanvas = forwardRef<MindmapCanvasHandle, MindmapCanvasProps>(function MindmapCanvas({
  mapId,
  workspaceId = null,
  readOnly = false,
  onOpenPaper,
  showCodePanel = false,
  onToggleCodePanel,
  codePanelWidthClass,
  className,
}, ref) {
  const { t } = useTranslation('mindmap');
  const cached = usePaperMindStore((s) => s.mindmapDocs[mapId]);
  const loadMindmapDoc = usePaperMindStore((s) => s.loadMindmapDoc);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setFailed(false);
    if (!usePaperMindStore.getState().mindmapDocs[mapId]) {
      loadMindmapDoc(mapId, workspaceId, true).catch(() => setFailed(true));
    }
    // reloadKey：失败后手动重试
  }, [mapId, workspaceId, reloadKey, loadMindmapDoc]);

  if (failed && !cached) {
    return (
      <div className={`flex h-full flex-col items-center justify-center gap-3 text-textSecondary ${className ?? ''}`}>
        <AlertTriangle size={28} className="text-amber-400" />
        <span className="text-sm">{t('loadFailed')}</span>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1 text-sm text-textSecondary transition-colors hover:bg-white/5 hover:text-text"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          {t('retry')}
        </button>
      </div>
    );
  }
  if (!cached) {
    return (
      <div className={`flex h-full items-center justify-center text-textSecondary ${className ?? ''}`}>
        <Loader2 className="animate-spin" size={20} />
        <span className="ml-2 text-sm">{t('loading')}</span>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <EditorSurface
        key={`${mapId}:${reloadKey}`}
        ref={ref}
        mapId={mapId}
        workspaceId={workspaceId}
        info={cached}
        readOnly={readOnly}
        onOpenPaper={onOpenPaper}
        showCodePanel={showCodePanel}
        onToggleCodePanel={onToggleCodePanel}
        codePanelWidthClass={codePanelWidthClass}
        className={className}
      />
    </ReactFlowProvider>
  );
});

interface SurfaceProps extends MindmapCanvasProps {
  info: MindmapInfo;
}

const EditorSurface = forwardRef<MindmapCanvasHandle, SurfaceProps>(function EditorSurface({
  mapId,
  workspaceId = null,
  info,
  readOnly = false,
  onOpenPaper,
  showCodePanel = false,
  onToggleCodePanel,
  codePanelWidthClass = 'w-[380px]',
  className,
}, ref) {
  const { t } = useTranslation('mindmap');
  const editor = useMindmapEditor({ mapId, workspaceId, info, readOnly });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const reactFlow = useReactFlow();
  const [dragOverrides, setDragOverrides] = useState<Record<string, XYPosition>>({});

  const focusFitView = useCallback(() => {
    void reactFlow.fitView({ padding: 0.2, duration: 200, maxZoom: 1 });
  }, [reactFlow]);

  // 对外命令式入口（代码面板 / AI SSE / 页面工具栏）
  useImperativeHandle(ref, () => ({
    getDoc: () => editor.doc,
    adoptUserTarget: editor.adoptUserTarget,
    applyExternalDiff: editor.applyExternalDiff,
    relayout: editor.relayout,
    fitView: focusFitView,
    reloadFromServer: editor.reloadFromServer,
  }), [editor, focusFitView]);

  // ---------- 可见性（折叠子树排除） ----------
  const hiddenIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const n of editor.doc.nodes) {
      if (n.collapsed === true) {
        const family = descendantIds(editor.doc.nodes, n.id);
        for (const id of family) if (id !== n.id) hidden.add(id);
      }
    }
    return hidden;
  }, [editor.doc]);

  const childParentSet = useMemo(() => {
    const parents = new Set<string>();
    for (const n of editor.doc.nodes) if (n.parentId) parents.add(n.parentId);
    return parents;
  }, [editor.doc]);

  // ---------- RF nodes / edges ----------
  const nodes: MindmapFlowNode[] = useMemo(() => {
    return editor.doc.nodes
      .filter((n) => !hiddenIds.has(n.id))
      .map((n) => ({
        id: n.id,
        type: 'mindmap',
        position: dragOverrides[n.id] ?? { x: n.x, y: n.y },
        selected: editor.selectedId === n.id,
        draggable: !readOnly,
        data: {
          node: n,
          hasChildren: childParentSet.has(n.id),
          selected: editor.selectedId === n.id,
          editing: editor.editingId === n.id,
          dropTarget: editor.dropTargetId === n.id,
          readOnly,
        },
      }));
  }, [
    editor.doc, editor.selectedId, editor.editingId, editor.dropTargetId,
    hiddenIds, childParentSet, dragOverrides, readOnly,
  ]);

  const edges: Edge[] = useMemo(() => {
    return editor.doc.nodes
      .filter((n) => n.parentId !== null && !hiddenIds.has(n.id) && !hiddenIds.has(n.parentId))
      .map((n) => ({
        id: `${n.parentId}->${n.id}`,
        source: n.parentId as string,
        target: n.id,
        sourceHandle: 'out',
        targetHandle: 'in',
      }));
  }, [editor.doc.nodes, hiddenIds]);

  const nodeHandlers = useMemo(() => ({
    onStartEdit: editor.startEdit,
    onCommitEdit: editor.commitEdit,
    onCancelEdit: editor.cancelEdit,
    onToggleCollapsed: editor.toggleCollapsed,
    onOpenPaper: (paperId: string) => onOpenPaper?.(paperId),
  }), [
    editor.startEdit, editor.commitEdit, editor.cancelEdit,
    editor.toggleCollapsed, onOpenPaper,
  ]);

  // ---------- 受控变更：选择与拖拽中间帧 ----------
  const onNodesChange = useCallback((changes: NodeChange<MindmapFlowNode>[]) => {
    for (const change of changes) {
      if (change.type === 'select') {
        if (change.selected) editor.setSelectedId(change.id);
        else if (editor.selectedId === change.id) editor.setSelectedId(null);
      } else if (change.type === 'position' && change.dragging && change.position) {
        setDragOverrides((cur) => ({ ...cur, [change.id]: change.position as XYPosition }));
      }
    }
  }, [editor]);

  // RF 要求 edges 引用存在以接受变更；本画布边完全派生，空实现即可
  const onEdgesChange = useCallback((_changes: EdgeChange[]) => undefined, []);

  const dropCandidateFromPoint = useCallback((clientX: number, clientY: number, draggedId: string): string | null => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const wrap = el?.closest('[data-mm-node-id]') as HTMLElement | null;
    const candidate = wrap?.dataset.mmNodeId ?? null;
    if (!candidate || candidate === draggedId) return null;
    if (descendantIds(editor.doc.nodes, draggedId).includes(candidate)) return null;
    return candidate;
  }, [editor.doc.nodes]);

  const onNodeDrag = useCallback((event: MouseEvent | TouchEvent, node: MindmapFlowNode) => {
    const p = pointOf(event);
    const candidate = dropCandidateFromPoint(p.x, p.y, node.id);
    if (candidate !== editor.dropTargetId) editor.setDropTargetId(candidate);
  }, [dropCandidateFromPoint, editor]);

  const onNodeDragStop = useCallback((event: MouseEvent | TouchEvent, node: MindmapFlowNode) => {
    const p = pointOf(event);
    const candidate = dropCandidateFromPoint(p.x, p.y, node.id);
    editor.commitDrag(node.id, node.position.x, node.position.y, candidate);
    setDragOverrides((cur) => {
      const next = { ...cur };
      delete next[node.id];
      return next;
    });
    editor.setDropTargetId(null);
  }, [dropCandidateFromPoint, editor]);

  // ---------- 键盘 ----------
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (readOnly) return;
    const targetEl = e.target as HTMLElement | null;
    if (targetEl?.closest('input, textarea, [data-mm-editing]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) editor.redo(); else editor.undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      editor.redo();
      return;
    }
    if (ctrl || e.altKey) return;
    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        editor.addChild();
        break;
      case 'Enter':
        e.preventDefault();
        editor.addSibling();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        editor.deleteNode();
        break;
      case 'F2':
        if (editor.selectedId) {
          e.preventDefault();
          editor.startEdit(editor.selectedId);
        }
        break;
      default:
    }
  }, [editor, readOnly]);

  const focusWrapper = useCallback(() => {
    wrapperRef.current?.focus();
  }, []);

  const rootNode = useMemo(
    () => editor.doc.nodes.find((n: MindmapNode) => n.parentId === null),
    [editor.doc]
  );

  const toolButtons: Array<{
    key: string;
    title: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled: boolean;
  }> = [
    {
      key: 'child',
      title: t('toolbar.addChild'),
      icon: <Plus size={16} />,
      onClick: () => editor.addChild(),
      disabled: !editor.selectedId && !rootNode,
    },
    {
      key: 'sibling',
      title: t('toolbar.addSibling'),
      icon: <ListPlus size={16} />,
      onClick: () => editor.addSibling(),
      disabled: !editor.selectedId,
    },
    {
      key: 'delete',
      title: t('toolbar.delete'),
      icon: <Trash2 size={16} />,
      onClick: () => editor.deleteNode(),
      disabled: !editor.selectedId || editor.selectedId === rootNode?.id,
    },
    { key: 'undo', title: t('toolbar.undo'), icon: <Undo2 size={16} />, onClick: editor.undo, disabled: !editor.canUndo },
    { key: 'redo', title: t('toolbar.redo'), icon: <Redo2 size={16} />, onClick: editor.redo, disabled: !editor.canRedo },
    { key: 'layout', title: t('toolbar.relayout'), icon: <Wand2 size={16} />, onClick: editor.relayout, disabled: readOnly },
    { key: 'fit', title: t('toolbar.fitView'), icon: <Maximize size={16} />, onClick: focusFitView, disabled: false },
  ];

  return (
    <MindmapNodeHandlersContext.Provider value={nodeHandlers}>
      <div className={`mm-dark flex h-full w-full overflow-hidden ${className ?? ''}`}>
      <div
        ref={wrapperRef}
        tabIndex={0}
        className="relative h-full min-w-0 flex-1 bg-background outline-none"
        onKeyDown={onKeyDown}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(_e, node) => editor.setSelectedId(node.id)}
          onPaneClick={() => { editor.setSelectedId(null); focusWrapper(); }}
          // 滚轮上滑放大（deltaY<0 → zoom in）：React Flow 默认行为，显式声明确保不被 panOnScroll 翻转
          zoomOnScroll
          zoomOnPinch
          panOnScroll={false}
          minZoom={0.1}
          maxZoom={2.5}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          defaultEdgeOptions={{ style: { stroke: '#475569', strokeWidth: 1.5 } }}
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          nodesDraggable={!readOnly}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#334155" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            className="!bg-surface"
            nodeColor={(n) => {
              const data = (n as MindmapFlowNode).data;
              const node = data?.node;
              if (node?.parentId === null) return '#3B82F6';
              if (node?.kind === 'paper') return '#10B981';
              return '#475569';
            }}
            maskColor="rgba(15,23,42,0.75)"
          />

          <Panel position="top-left" className="!m-2">
            <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 p-1 shadow-lg backdrop-blur">
              {!readOnly && toolButtons.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  title={b.title}
                  aria-label={b.title}
                  disabled={b.disabled}
                  onClick={b.onClick}
                  className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {b.icon}
                </button>
              ))}
              {onToggleCodePanel && (
                <button
                  type="button"
                  title={t('toolbar.codeToggle')}
                  aria-label={t('toolbar.codeToggle')}
                  aria-pressed={showCodePanel}
                  onClick={onToggleCodePanel}
                  className={`rounded-md p-1.5 transition-colors ${
                    showCodePanel ? 'bg-primary/15 text-primary' : 'text-textSecondary hover:bg-white/10 hover:text-text'
                  }`}
                >
                  <Code2 size={16} />
                </button>
              )}
            </div>
          </Panel>

          <Panel position="bottom-left" className="!m-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/95 px-2.5 py-1 text-xs text-textSecondary shadow-lg backdrop-blur">
              {editor.error ? (
                <>
                  <AlertTriangle size={13} className="text-amber-400" />
                  <span className="text-amber-300">{t(`status.${editor.error}`)}</span>
                  {editor.error === 'saveFailed' && (
                    <button
                      type="button"
                      className="rounded border border-border px-1.5 py-0.5 transition-colors hover:bg-white/10"
                      onClick={editor.retrySave}
                    >
                      {t('retry')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-textSecondary/60 hover:text-text"
                    onClick={editor.clearError}
                  >
                    ×
                  </button>
                </>
              ) : (
                <>
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${editor.saving ? 'animate-pulse bg-amber-400' : 'bg-accent'}`}
                  />
                  <span>{editor.saving ? t('status.saving') : t('status.saved')}</span>
                  <span className="text-border">·</span>
                  <span>{editor.doc.nodes.length}</span>
                </>
              )}
            </div>
          </Panel>

          {!readOnly && (
            <Panel position="bottom-right" className="!m-2">
              <div className="rounded-lg border border-border bg-surface/80 px-2.5 py-1 text-[11px] text-textSecondary/70 shadow-lg backdrop-blur">
                {t('hint')}
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>
      {showCodePanel && (
        <div className={`h-full shrink-0 ${codePanelWidthClass}`}>
          <MindmapCodePanel
            doc={editor.doc}
            onApplyTarget={editor.adoptUserTarget}
            readOnly={readOnly}
          />
        </div>
      )}
      </div>
    </MindmapNodeHandlersContext.Provider>
  );
});

export default MindmapCanvas;
