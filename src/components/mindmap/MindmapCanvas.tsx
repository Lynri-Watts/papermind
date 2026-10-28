/**
 * 思维导图 Canvas 组件（MindElixir DOM 引擎）。
 *
 * 架构：
 * - 文档真源在 MindmapDoc（store 缓存），MindElixir 每次操作触发 onChangeData，
 *   经 elixirToDoc 转回扁平 MindmapDoc 后调用 adoptUserTarget 进入后端 actions 管线；
 * - 画布几何布局由 mind-elixir 内部 DOM 管理，MindmapDoc 中的 x/y 固定为 0；
 * - 工具栏：fit-to-view、expand-all、collapse-all、方向切换、紧凑模式、源码面板 toggle；
 * - 右侧 MindmapCodePanel（Markdown 源码面板）保留，与画布双向融合。
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
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Code2,
  Loader2,
  Maximize,
  Minimize2,
  PanelLeftOpen,
  Redo2,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MindmapDoc, MindmapInfo } from '../../types';
import {
  docToElixir,
  elixirToDoc,
  MINDMAP_TYPE,
} from '../../lib/mindmap';
import { ELIXIR_DIRECTION_LABELS } from '../../lib/mindmap/elixirMarkdown';
import { usePaperMindStore } from '../../store';
import MindElixirReact, { type MindElixirReactHandle } from './MindElixirReact';
import { useMindmapEditor } from './useMindmapEditor';
import MindmapCodePanel from './MindmapCodePanel';
import MermaidSourceView from './MermaidSourceView';

/** 画布对外的命令式入口 */
export interface MindmapCanvasHandle {
  getDoc: () => MindmapDoc;
  adoptUserTarget: (target: MindmapDoc) => void;
  applyExternalDiff: (
    actions: any[],
    serverIdMap?: Record<string, string>,
    version?: number,
  ) => void;
  /** 强制刷新画布 */
  reloadFromServer: () => Promise<void>;
}

export interface MindmapCanvasProps {
  mapId: string;
  workspaceId?: string | null;
  readOnly?: boolean;
  /** paper 节点点击：默认无动作 */
  onOpenPaper?: (paperId: string) => void;
  /** 显示右侧 Markdown 代码面板 */
  showCodePanel?: boolean;
  /** 传入即显示工具栏中的代码面板开关按钮 */
  onToggleCodePanel?: () => void;
  /** 代码面板宽度（Tailwind 宽度类，默认 w-[380px]） */
  codePanelWidthClass?: string;
  className?: string;
}

/** 加载器：确保文档在 store 缓存中后挂载编辑器 */
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

  // 类型分流：mindmap=可编辑树画布；其他 mermaid 图=官方渲染只读视图
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
  const elixirRef = useRef<MindElixirReactHandle>(null);

  // 画布状态
  const [direction, setDirection] = useState<0 | 1 | 2 | 3>(2); // 默认 SIDE
  const [compact, setCompact] = useState(false);
  const [copiedToast, setCopiedToast] = useState<'idle' | 'ok' | 'err'>('idle');

  // MindElixirData（由 doc 派生）
  const elixirData = useMemo(() => {
    if (editor.doc.nodes.length === 0) {
      return {
        nodeData: { id: 'root', topic: '', metadata: { kind: 'topic' as const } },
        direction,
        compact,
        meta: { converter: 'papermind' },
      } as import('../../lib/mindmap/elixirMapper').MindElixirData;
    }
    const base = docToElixir(editor.doc);
    return { ...base, direction, compact };
  }, [editor.doc, direction, compact]);

  // MindElixir 操作后回写：MindElixirData → MindmapDoc → adoptUserTarget
  const handleChangeData = useCallback((elixirData: unknown) => {
    if (readOnly) return;
    try {
      const doc = elixirToDoc(elixirData as any);
      editor.adoptUserTarget(doc);
    } catch (e) {
      console.error('[mindmap] onChangeData failed', e);
    }
  }, [editor, readOnly]);

  // MindElixir 内部方向切换回写
  const handleChangeDirection = useCallback((dir: 0 | 1 | 2 | 3) => {
    setDirection(dir);
  }, []);

  // ---------- 工具栏按钮 ----------
  const directions = [
    { dir: 0 as const, label: ELIXIR_DIRECTION_LABELS[0] },
    { dir: 1 as const, label: ELIXIR_DIRECTION_LABELS[1] },
    { dir: 2 as const, label: ELIXIR_DIRECTION_LABELS[2] },
    { dir: 3 as const, label: ELIXIR_DIRECTION_LABELS[3] },
  ];

  const directionBtn = (
    <div className="relative">
      <select
        value={direction}
        onChange={(e) => {
          const d = Number(e.target.value) as 0 | 1 | 2 | 3;
          setDirection(d);
        }}
        disabled={readOnly}
        className="cursor-pointer appearance-none rounded-md bg-surface px-2.5 py-1 pr-5 text-xs text-textSecondary transition-colors hover:bg-white/10 hover:text-text focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
      >
        {directions.map((d) => (
          <option key={d.dir} value={d.dir}>{d.label}</option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-textSecondary/60"
        viewBox="0 0 12 12"
        fill="currentColor"
      >
        <path d="M2 4l4 4 4-4z" />
      </svg>
    </div>
  );

  // ---------- 截图到剪贴板 ----------
  const handleCopyImage = useCallback(async () => {
    try {
      const blob = await elixirRef.current?.exportPng();
      if (!blob) throw new Error('exportPng returned null');
      if (blob.size === 0) throw new Error('empty png');
      if (!navigator.clipboard?.write) {
        // 旧浏览器 fallback：打开新标签下载
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${info?.title ?? 'mindmap'}.png`;
        a.click();
        URL.revokeObjectURL(url);
        setCopiedToast('ok');
        setTimeout(() => setCopiedToast('idle'), 2000);
        return;
      }
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      setCopiedToast('ok');
    } catch (e) {
      console.warn('[mindmap] copy image failed', e);
      setCopiedToast('err');
    }
    setTimeout(() => setCopiedToast('idle'), 2000);
  }, [info?.title]);

  // 对外命令式入口
  useImperativeHandle(ref, () => ({
    getDoc: () => editor.doc,
    adoptUserTarget: editor.adoptUserTarget,
    applyExternalDiff: editor.applyExternalDiff,
    reloadFromServer: editor.reloadFromServer,
  }), [editor]);

  return (
    <div className={`mm-dark flex h-full w-full overflow-hidden ${className ?? ''}`}>
      <div className="relative h-full min-w-0 flex-1 bg-background">
        {/* MindElixir 画布 */}
        <MindElixirReact
          ref={elixirRef}
          data={elixirData}
          direction={direction}
          compact={compact}
          editable={!readOnly}
          onChangeData={handleChangeData}
          onChangeDirection={handleChangeDirection}
        />

        {/* 工具栏 */}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 p-1 shadow-lg backdrop-blur">
          {!readOnly && (
            <>
              <button
                type="button"
                title={t('toolbar.undo')}
                aria-label={t('toolbar.undo')}
                onClick={editor.undo}
                disabled={!editor.canUndo}
                className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Undo2 size={16} />
              </button>
              <button
                type="button"
                title={t('toolbar.redo')}
                aria-label={t('toolbar.redo')}
                onClick={editor.redo}
                disabled={!editor.canRedo}
                className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Redo2 size={16} />
              </button>
              <div className="mx-0.5 h-5 w-px bg-border" />
            </>
          )}

          {/* Fit-to-view */}
          <button
            type="button"
            title={t('toolbar.fitView')}
            aria-label={t('toolbar.fitView')}
            onClick={() => elixirRef.current?.fitToView()}
            className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-text"
          >
            <Maximize size={16} />
          </button>

          {/* Expand-all / Collapse-all */}
          {!readOnly && (
            <>
              <button
                type="button"
                title={t('toolbar.expandAll', { defaultValue: 'Expand all' })}
                aria-label={t('toolbar.expandAll', { defaultValue: 'Expand all' })}
                onClick={() => elixirRef.current?.expandAll()}
                className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-text"
              >
                <ChevronDown size={16} />
              </button>
              <button
                type="button"
                title={t('toolbar.collapseAll', { defaultValue: 'Collapse all' })}
                aria-label={t('toolbar.collapseAll', { defaultValue: 'Collapse all' })}
                onClick={() => elixirRef.current?.collapseAll()}
                className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-text"
              >
                <ChevronRight size={16} />
              </button>
              <div className="mx-0.5 h-5 w-px bg-border" />
            </>
          )}

          {/* 方向切换 */}
          {directionBtn}

          {/* 紧凑模式 toggle */}
          {!readOnly && (
            <button
              type="button"
              title={t('toolbar.compactToggle', { defaultValue: 'Compact mode' })}
              aria-label={t('toolbar.compactToggle', { defaultValue: 'Compact mode' })}
              aria-pressed={compact}
              onClick={() => setCompact((c) => !c)}
              className={`rounded-md p-1.5 transition-colors ${
                compact ? 'bg-primary/15 text-primary' : 'text-textSecondary hover:bg-white/10 hover:text-text'
              }`}
            >
              <PanelLeftOpen size={16} />
            </button>
          )}

          {/* 截图到剪贴板 */}
          <button
            type="button"
            title={t('toolbar.copyImage', { defaultValue: 'Copy image to clipboard' })}
            aria-label={t('toolbar.copyImage', { defaultValue: 'Copy image to clipboard' })}
            onClick={handleCopyImage}
            className="rounded-md p-1.5 text-textSecondary transition-colors hover:bg-white/10 hover:text-text"
          >
            <ClipboardCopy size={16} />
          </button>

          {/* 源码面板 toggle */}
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

        {/* 复制成功/失败 Toast */}
        {copiedToast !== 'idle' && (
          <div
            className={`absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-lg border px-3 py-1.5 text-xs shadow-lg backdrop-blur transition-opacity ${
              copiedToast === 'ok'
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                : 'border-rose-500/40 bg-rose-500/15 text-rose-300'
            }`}
          >
            {copiedToast === 'ok'
              ? t('toolbar.copyImageOk', { defaultValue: 'Image copied to clipboard' })
              : t('toolbar.copyImageErr', { defaultValue: 'Copy failed — try again' })}
          </div>
        )}

        {/* 只读 badge */}
        {readOnly && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-surface/95 px-2.5 py-1 text-[11px] text-textSecondary shadow-lg backdrop-blur">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
            {t('status.readOnly', { defaultValue: 'Read only' })}
          </div>
        )}

        {/* 底部状态栏 */}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-lg border border-border bg-surface/95 px-2.5 py-1 text-xs text-textSecondary shadow-lg backdrop-blur">
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
      </div>

      {/* 右侧 Markdown 源码面板 */}
      {showCodePanel && (
        <div className={`h-full shrink-0 ${codePanelWidthClass}`}>
          <MindmapCodePanel
            doc={editor.doc}
            onApplyTarget={editor.applyCodeTarget}
            readOnly={readOnly}
          />
        </div>
      )}
    </div>
  );
});

/**
 * 非 mindmap 图的只读表面：左侧 mermaid 官方渲染。
 * ref 命令仅保留兼容外壳（无节点树，结构化命令为空操作）。
 */
const ReadonlySurface = forwardRef<MindmapCanvasHandle, SurfaceProps>(function ReadonlySurface({
  mapId,
  workspaceId = null,
  info,
  className,
}, ref) {
  const source = info.source ?? '';

  useImperativeHandle(ref, () => ({
    getDoc: () => ({ nodes: [], diagramType: info.diagramType, source }),
    adoptUserTarget: () => undefined,
    applyExternalDiff: () => undefined,
    reloadFromServer: async () => {
      await usePaperMindStore.getState().loadMindmapDoc(mapId, workspaceId, true);
    },
  }), [info.diagramType, source, mapId, workspaceId]);

  return (
    <div className={`mm-dark flex h-full w-full overflow-hidden ${className ?? ''}`}>
      <div className="relative h-full min-w-0 flex-1">
        <MermaidSourceView source={source} />
      </div>
    </div>
  );
});

export default MindmapCanvas;
