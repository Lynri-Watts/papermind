/**
 * 非 mindmap 图（flowchart / sequenceDiagram / timeline …）的只读渲染视图。
 *
 * - 源码经 mermaid 官方引擎渲染为 SVG（与代码面板预览共用 useMermaidRender，
 *   保证引擎、主题、防抖一致）；
 * - 不可在画布上结构化编辑：任何修改都来自代码面板的 source 模式；
 * - 容器内可滚动、按钮缩放（25%–300%）与适应宽度；暗色主题沿用全局样式。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMermaidRender } from '../../lib/mindmap/useMermaidRender';

export interface MermaidSourceViewProps {
  /** mermaid 原始源码（doc.source） */
  source: string;
  className?: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

const MermaidSourceView: React.FC<MermaidSourceViewProps> = ({ source, className }) => {
  const { t } = useTranslation('mindmap');
  const render = useMermaidRender(source, 300);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // SVG 注入
  useEffect(() => {
    if (render.status === 'ready' && hostRef.current) {
      hostRef.current.innerHTML = render.svg;
    }
  }, [render]);

  // 测量渲染产物的自然尺寸（viewBox 优先；回退 width/height 属性 / getBBox）
  useLayoutEffect(() => {
    if (render.status !== 'ready' || !hostRef.current) return;
    const svg = hostRef.current.querySelector('svg');
    if (!svg) {
      setNatural(null);
      return;
    }
    let w = 0;
    let h = 0;
    const vb = svg.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      w = vb.width;
      h = vb.height;
    } else {
      const parseLen = (v: string | null): number => {
        if (!v) return 0;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      };
      w = parseLen(svg.getAttribute('width'));
      h = parseLen(svg.getAttribute('height'));
      if (!w || !h) {
        const box = (svg as SVGGraphicsElement).getBBox?.();
        if (box) {
          w = w || box.width;
          h = h || box.height;
        }
      }
    }
    setNatural(w > 0 && h > 0 ? { w, h } : null);
    svg.style.display = 'block';
    svg.style.maxWidth = 'none';
  }, [render]);

  // 新图渲染完成后恢复 100%
  useEffect(() => {
    if (render.status === 'ready') setZoom(1);
  }, [render.status]);

  const fitWidth = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !natural) return;
    const available = container.clientWidth - 32; // 两侧各 16px 内边距
    if (available > 0 && natural.w > 0) setZoom(clampZoom(available / natural.w));
  }, [natural]);

  return (
    <div
      className={`relative flex h-full w-full flex-col bg-background ${className ?? ''}`}
      data-mm-source-view="1"
    >
      {/* 缩放工具条 */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-surface/90 px-1 py-0.5 text-textSecondary shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={() => setZoom((z) => clampZoom(Number((z - 0.1).toFixed(2))))}
          disabled={render.status !== 'ready'}
          title={t('view.zoomOut')}
          className="rounded p-1.5 hover:bg-white/10 hover:text-text disabled:opacity-40"
        >
          <ZoomOut size={14} />
        </button>
        <span className="min-w-[3.2rem] text-center font-mono text-[11px] text-text">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => clampZoom(Number((z + 0.1).toFixed(2))))}
          disabled={render.status !== 'ready'}
          title={t('view.zoomIn')}
          className="rounded p-1.5 hover:bg-white/10 hover:text-text disabled:opacity-40"
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          onClick={fitWidth}
          disabled={render.status !== 'ready' || !natural}
          title={t('view.fitWidth')}
          className="rounded p-1.5 hover:bg-white/10 hover:text-text disabled:opacity-40"
        >
          <Maximize size={14} />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4">
        {render.status === 'idle' && (
          <div className="text-xs text-textSecondary">{t('view.empty')}</div>
        )}
        {render.status === 'loading' && (
          <div className="text-xs text-textSecondary">{t('view.loading')}</div>
        )}
        {render.status === 'failed' && (
          <div className="max-w-2xl rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertTriangle size={13} />
              {t('view.renderFailed')}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-red-300/80">
              {render.message}
            </pre>
          </div>
        )}
        {render.status === 'ready' && (
          <div
            style={
              natural
                ? { width: natural.w * zoom, height: natural.h * zoom }
                : undefined
            }
          >
            <div
              ref={hostRef}
              className="mmd-source-host [&_svg]:h-full [&_svg]:w-full"
              style={natural ? { width: '100%', height: '100%' } : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default MermaidSourceView;
