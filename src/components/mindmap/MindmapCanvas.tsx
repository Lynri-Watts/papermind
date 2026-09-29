/**
 * 思维导图几何画布（React Flow）。
 *
 * - 文档单向派生：doc → RF nodes/edges；节点位置完全由 mermaid 同源布局决定，
 *   节点不可拖拽（几何不是用户数据），结构编辑走工具栏/键盘/代码面板/AI；
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
import type { MindmapAction, MindmapDoc, MindmapInfo, MindmapNode } from '../../types';
import {
  descendantIds,
  edgeWidthForLevel,
  fillForSection,
  orderedChildren,
  sectionOfNodes,
} from '../../lib/mindmap';
import { MindmapConflictError } from '../../api';
import { usePaperMindStore } from '../../store';
import { MINDMAP_TYPE } from '../../lib/mindmap';
import MindmapNodeView, {
  MindmapNodeHandlersContext,
  type MindmapFlowNode,
} from './MindmapNode';
import MindmapEdgeView, { type MindmapFlowEdge } from './MindmapEdge';
import { useMindmapEditor } from './useMindmapEditor';
import MindmapCodePanel from './MindmapCodePanel';
import MermaidSourceView from './MermaidSourceView';
import MermaidSourcePanel from './MermaidSourcePanel';

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
const EDGE_TYPES = { mindmap: MindmapEdgeView };

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

  // 类型分流：mindmap=可编辑树画布；其他 mermaid 图=官方渲染只读视图（源码面板编辑）
  if (cached.diagramType !== MINDMAP_TYPE) {
    return (
      <ReadonlySurface
        key={`${mapId}:${reloadKey}`}
        ref={ref}
        mapId={mapId}
        info={cached}
        showCodePanel={showCodePanel}
        onToggleCodePanel={onToggleCodePanel}
        codePanelWidthClass={codePanelWidthClass}
        className={className}
      />
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

  const focusFitView = useCallback(() => {
    void reactFlow.fitView({ padding: 0.2, duration: 200, maxZoom: 1 });
  }, [reactFlow]);

  // mermaid 布局落图后坐标整体切换：自动/手动布局结束后重新适应画布一次
  const wasLayoutingRef = useRef(false);
  useEffect(() => {
    if (wasLayoutingRef.current && !editor.layouting && editor.nodeGeom.size > 0) {
      focusFitView();
    }
    wasLayoutingRef.current = editor.layouting;
  }, [editor.layouting, editor.nodeGeom.size, focusFitView]);

  // mindmap 代码面板确认「转换成其他 mermaid 图」：整段源码替换，成功后外层按
  // 新 diagramType 自动切只读视图；冲突落服务端最新文档并提示
  const handleReplaceSource = useCallback(async (src: string) => {
    const store = usePaperMindStore.getState();
    try {
      await store.replaceMindmapSource(mapId, src);
    } catch (e) {
      if (e instanceof MindmapConflictError) store.cacheMindmapDoc(e.currentMindmap);
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }, [mapId]);

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

  // ---------- section 配色与树层级（结构推导，不依赖 mermaid 离屏渲染） ----------
  const sectionMap = useMemo(() => sectionOfNodes(editor.doc), [editor.doc]);
  const depthMap = useMemo(() => {
    const map = new Map<string, number>();
    const root = editor.doc.nodes.find((n) => n.parentId === null);
    if (!root) return map;
    map.set(root.id, 0);
    const walk = (parentId: string, depth: number) => {
      for (const child of orderedChildren(editor.doc.nodes, parentId)) {
        map.set(child.id, depth);
        walk(child.id, depth + 1);
      }
    };
    walk(root.id, 1);
    return map;
  }, [editor.doc]);

  // ---------- RF nodes / edges ----------
  const nodes: MindmapFlowNode[] = useMemo(() => {
    return editor.doc.nodes
      .filter((n) => !hiddenIds.has(n.id))
      .map((n) => {
        const measured = editor.nodeGeom.get(n.id);
        return {
          id: n.id,
          type: 'mindmap',
          position: { x: n.x, y: n.y },
          selected: editor.selectedId === n.id,
          // 几何锁定：节点不可拖拽，位置只由 mermaid 布局决定
          draggable: false,
          // mermaid 实测尺寸存在时严格按官方宽高渲染，保证边 path 端点对齐
          style: measured
            ? { width: measured.width, height: measured.height }
            : undefined,
          data: {
            node: n,
            hasChildren: childParentSet.has(n.id),
            selected: editor.selectedId === n.id,
            editing: editor.editingId === n.id,
            readOnly,
            section: sectionMap.get(n.id) ?? null,
            measured,
          },
        };
      });
  }, [
    editor.doc, editor.selectedId, editor.editingId, editor.nodeGeom,
    hiddenIds, childParentSet, readOnly, sectionMap,
  ]);

  const edges: MindmapFlowEdge[] = useMemo(() => {
    return editor.doc.nodes
      .filter((n) => n.parentId !== null && !hiddenIds.has(n.id) && !hiddenIds.has(n.parentId))
      .map((n) => {
        const id = `${n.parentId}->${n.id}`;
        const childSection = sectionMap.get(n.id) ?? 0;
        return {
          id,
          type: 'mindmap',
          source: n.parentId as string,
          target: n.id,
          sourceHandle: 'out',
          targetHandle: 'in',
          data: {
            // 节点不可拖：mermaid 官方 path 始终有效；tidy 降级期间为空走贝塞尔兜底
            geom: editor.edgeGeom.get(id),
            fallbackStroke: fillForSection(childSection),
            fallbackWidth: edgeWidthForLevel(depthMap.get(n.id) ?? 1),
          },
        };
      });
  }, [editor.doc.nodes, editor.edgeGeom, hiddenIds, sectionMap, depthMap]);

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

  // ---------- 受控变更：仅选择（位置锁定，不接受 position 变更） ----------
  const onNodesChange = useCallback((changes: NodeChange<MindmapFlowNode>[]) => {
    for (const change of changes) {
      if (change.type === 'select') {
        if (change.selected) editor.setSelectedId(change.id);
        else if (editor.selectedId === change.id) editor.setSelectedId(null);
      }
    }
  }, [editor]);

  // RF 要求 edges 引用存在以接受变更；本画布边完全派生，空实现即可
  const onEdgesChange = useCallback((_changes: EdgeChange[]) => undefined, []);

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
    {
      key: 'layout',
      title: editor.layouting ? t('status.layingOut') : t('toolbar.relayout'),
      icon: editor.layouting ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />,
      onClick: editor.relayout,
      disabled: readOnly || editor.layouting,
    },
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
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
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
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          // 几何锁定：任何模式下节点都不可拖动，排布永远以 mermaid 为准
          nodesDraggable={false}
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
              if (!node) return '#475569';
              if (node.parentId === null) return '#797D7D';
              if (node.kind === 'paper') return '#10B981';
              return fillForSection(sectionMap.get(node.id) ?? 0);
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

          {editor.layoutNotice && (
            <Panel position="top-center" className="!m-2">
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 shadow-lg backdrop-blur">
                <AlertTriangle size={13} className="shrink-0 text-amber-400" />
                <span>{t(`status.${editor.layoutNotice}`)}</span>
                <button
                  type="button"
                  className="text-amber-300/60 hover:text-amber-200"
                  onClick={editor.clearLayoutNotice}
                >
                  ×
                </button>
              </div>
            </Panel>
          )}

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
            onReplaceSource={handleReplaceSource}
            readOnly={readOnly}
          />
        </div>
      )}
      </div>
    </MindmapNodeHandlersContext.Provider>
  );
});

/**
 * 非 mindmap 图的只读表面：左侧 mermaid 官方渲染，右侧源码编辑面板。
 * ref 命令仅保留兼容外壳（无节点树，结构化命令为空操作；AI 不会编辑此类图）。
 */
const ReadonlySurface = forwardRef<MindmapCanvasHandle, SurfaceProps>(function ReadonlySurface({
  mapId,
  workspaceId = null,
  info,
  showCodePanel = false,
  onToggleCodePanel,
  codePanelWidthClass = 'w-[380px]',
  className,
}, ref) {
  const { t } = useTranslation('mindmap');
  const source = info.source ?? '';

  useImperativeHandle(ref, () => ({
    getDoc: () => ({ nodes: [], diagramType: info.diagramType, source }),
    adoptUserTarget: () => undefined,
    applyExternalDiff: () => undefined,
    relayout: () => undefined,
    fitView: () => undefined,
    reloadFromServer: async () => {
      await usePaperMindStore.getState().loadMindmapDoc(mapId, workspaceId, true);
    },
  }), [info.diagramType, source, mapId, workspaceId]);

  return (
    <div className={`mm-dark flex h-full w-full overflow-hidden ${className ?? ''}`}>
      <div className="relative h-full min-w-0 flex-1">
        <MermaidSourceView source={source} />
        {onToggleCodePanel && (
          <div className="absolute left-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 p-1 shadow-lg backdrop-blur">
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
          </div>
        )}
      </div>
      {showCodePanel && (
        <div className={`h-full shrink-0 ${codePanelWidthClass}`}>
          <MermaidSourcePanel mapId={mapId} source={source} />
        </div>
      )}
    </div>
  );
});

export default MindmapCanvas;
