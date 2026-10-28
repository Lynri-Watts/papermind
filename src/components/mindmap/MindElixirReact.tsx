/**
 * MindElixir React 封装组件 —— 负责 mount/unmount 生命周期 + ref 转发 +
 * store 同步（监听 mind-elixir bus 的 operation 事件，getData 后回写 store）。
 *
 * 设计原则：mind-elixir 管辖的 DOM 子树永不 re-render，React 父组件只负责
 * 容器 div 的 mount/unmount 以及 MindElixir 实例的 init/refresh/destroy。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import MindElixir from 'mind-elixir';
import 'mind-elixir/style';
import { marked } from 'marked';
import { toBlob as htmlToBlob, toSvg as htmlToSvg } from 'html-to-image';
import type { MindElixirData } from '../../lib/mindmap/elixirMapper';

// ---------- Markdown 渲染函数（喂给 mind-elixir Options.markdown） ----------

marked.setOptions({ gfm: true, breaks: false });

function md2html(text: string): string {
  if (!text) return '';
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return text;
  }
}

// ---------- MindElixirReact Props ----------

export interface MindElixirReactProps {
  /** 初始/当前数据。组件内部用 deep-compare 检测变更后调 mind.refresh()。 */
  data: MindElixirData;
  /** 0=LEFT, 1=RIGHT, 2=SIDE, 3=DOWN（默认 SIDE）。组件内部 init 时设置，refresh 后用 mind.initLeft/Right/Side/Down 切换 */
  direction?: 0 | 1 | 2 | 3;
  /** 紧凑模式（默认 false） */
  compact?: boolean;
  /** 是否启用编辑（默认 true；只读场景传 false） */
  editable?: boolean;
  /** 自定义主题；不传用 MindElixir.THEME（浅色） */
  theme?: any;
  /** 操作后的数据回写（operation 事件触发） */
  onChangeData?: (data: MindElixirData) => void;
  /** 布局切换后的方向回写 */
  onChangeDirection?: (direction: 0 | 1 | 2 | 3) => void;
  className?: string;
}

// ---------- 主组件 ----------

export interface MindElixirReactHandle {
  /** 直接访问底层 MindElixir 实例（暴露 getData/refresh/scaleFit/exportPng 等方法） */
  readonly instance: MindElixir | null;
  /** 重新聚焦 + 缩放适配所有节点 */
  fitToView: () => void;
  /** 以当前根节点自动展开为完整树（mind-elixir 原生 expandNodeAll 对 root 有效） */
  expandAll: () => void;
  /** 全折叠（保留根可见） */
  collapseAll: () => void;
  /** 切换左右对称/单侧布局 */
  setDirection: (dir: 0 | 1 | 2 | 3) => void;
  /** 切换紧凑模式 */
  setCompact: (compact: boolean) => void;
  /** 导出 PNG */
  exportPng: () => Promise<Blob | null>;
  /** 导出 SVG */
  exportSvg: () => Promise<Blob>;
}

const MindElixirReact = React.forwardRef<MindElixirReactHandle, MindElixirReactProps>(
  function MindElixirReact(
    {
      data,
      direction = 2,
      compact = false,
      editable = true,
      theme,
      onChangeData,
      onChangeDirection,
      className,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mindRef = useRef<MindElixir | null>(null);
    const lastDataRef = useRef<MindElixirData | null>(null);
    const suppressChangeRef = useRef(false);

    // ---------- mount: init MindElixir ----------
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const mind = new MindElixir({
        el: container,
        direction,
        editable,
        toolBar: false,      // 我们自己的工具栏更贴合 PaperMind dark theme
        contextMenu: false,  // 我们自己的右键菜单（按需实现）
        keypress: true,
        compact,
        theme,
        markdown: md2html,
        allowUndo: true,
      });

      mind.init(data);
      mindRef.current = mind;
      lastDataRef.current = data;

      // 订阅 operation 事件：每次节点编辑后 getData 回写 props
      const handler = () => {
        if (suppressChangeRef.current) return;
        const updated = mind.getData();
        lastDataRef.current = updated as MindElixirData;
        onChangeData?.(updated as MindElixirData);
      };
      mind.bus.addListener('operation', handler);

      // 订阅方向切换事件（用户用 F 键或主题菜单切换布局）
      const dirHandler = (dir: number) => {
        onChangeDirection?.(dir as 0 | 1 | 2 | 3);
      };
      mind.bus.addListener('changeDirection', dirHandler);

      return () => {
        mind.bus.removeListener('operation', handler);
        mind.bus.removeListener('changeDirection', dirHandler);
        mind.destroy();
        mindRef.current = null;
        lastDataRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---------- data 变化：同步 direction/compact 到实例 + refresh ----------
    useEffect(() => {
      const mind = mindRef.current;
      if (!mind) return;
      const prev = lastDataRef.current;
      if (prev === data) return;

      suppressChangeRef.current = true;
      try {
        // refresh(data) 只拷 nodeData/arrows/summaries，不读 direction/compact。
        // 必须先手动同步实例字段，layout() 才会用新方向/紧凑模式重排。
        const dirChanged = (mind.direction as any) !== data.direction;
        const compactChanged = mind.compact !== data.compact;
        if (dirChanged || compactChanged) {
          if (data.direction !== undefined) (mind as any).direction = data.direction;
          if (data.compact !== undefined) mind.compact = data.compact;
        }
        mind.refresh(data);
      } finally {
        suppressChangeRef.current = false;
      }
      lastDataRef.current = data;
    }, [data]);

    // ---------- imperative handle ----------
    const fitToView = useCallback(() => mindRef.current?.scaleFit(), []);
    const expandAll = useCallback(() => {
      const mind = mindRef.current as any;
      if (!mind) return;
      // expandNodeAll 接收 Topic（DOM），用 MindElixir.E(id) 拿 DOM
      const rootDom = (MindElixir as any).E?.(mind.nodeData.id);
      if (rootDom) mind.expandNodeAll(rootDom, true);
    }, []);
    const collapseAll = useCallback(() => {
      const mind = mindRef.current as any;
      if (!mind) return;
      const rootDom = (MindElixir as any).E?.(mind.nodeData.id);
      if (rootDom) mind.expandNodeAll(rootDom, false);
    }, []);
    const setDirection = useCallback((dir: 0 | 1 | 2 | 3) => {
      const mind = mindRef.current as any;
      if (!mind) return;
      mind.direction = dir;
      mind.refresh();
      mind.toCenter?.();
      mind.bus?.fire?.('changeDirection', dir);
    }, []);
    const setCompact = useCallback((c: boolean) => {
      const mind = mindRef.current as any;
      if (!mind) return;
      mind.compact = c;
      mind.refresh();
    }, []);
    // ---------- 导出：临时重置 transform → 导出 .map-canvas → 裁剪 ----------
    // 之前各种坐标错位的根因：mind-elixir 设了 translate3d + scale，
    // 导致 bbox 和 html-to-image 输出的像素之间比例/偏移极难对齐。
    // 最干净的解法：临时把 .map-canvas 的 transform 设为 none，
    // 让内容回到自然布局坐标——此时 .me-nodes 和 SVG lines 在同一坐标空间，
    // 比例就是 pixelRatio，bbox 全是正数。
    const exportPng = useCallback(async () => {
      const mind = mindRef.current as any;
      const target = containerRef.current?.querySelector('.map-canvas') as HTMLElement | null;
      if (!target || !mind) return null;
      try {
        // 1. 临时重置 transform → 内容回到自然布局坐标（offsetWidth 世界）
        const origTransform = target.style.transform;
        const origNodesPadding = (target.querySelector('.me-nodes') as HTMLElement | null)?.style.padding ?? '';
        target.style.transform = 'none';
        const nodesEl = target.querySelector('.me-nodes') as HTMLElement | null;
        if (!nodesEl) { target.style.transform = origTransform; return null; }
        nodesEl.style.padding = '0';
        await new Promise((r) => requestAnimationFrame(() => r(null)));

        // 2. 自然布局下，nodesEl 本身就是完整 bbox（fit-content 所有内容）
        //    用它的 offsetWidth/Height + offsetLeft/Top（相对 .map-canvas）
        const PAD = 32;
        const pr = window.devicePixelRatio || 2;
        const nodesLeft = nodesEl.offsetLeft;
        const nodesTop = nodesEl.offsetTop;
        const nodesW = nodesEl.offsetWidth;
        const nodesH = nodesEl.offsetHeight;

        console.log('[mindmap] natural:', nodesLeft, nodesTop, nodesW, 'x', nodesH,
          'target.offset:', target.offsetWidth, 'x', target.offsetHeight);

        // 3. 导出（transform=none，padding=0 → SVG 和节点完美对齐）
        const blob = await htmlToBlob(target, {
          backgroundColor: '#1f2023',
          pixelRatio: pr,
          cacheBust: true,
        });

        // 4. 立即恢复（用户感知不到中间状态）
        nodesEl.style.padding = origNodesPadding;
        target.style.transform = origTransform;

        if (!blob) return null;
        const img = await createImageBitmap(blob);
        console.log('[mindmap] image:', img.width, 'x', img.height,
          'expected:', target.offsetWidth * pr, 'x', target.offsetHeight * pr);

        // 5. 从完整图片里裁 nodes 区域 + 四周 PAD
        const canvas = document.createElement('canvas');
        canvas.width = (nodesW + PAD * 2) * pr;
        canvas.height = (nodesH + PAD * 2) * pr;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#1f2023';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(
          img,
          nodesLeft * pr, nodesTop * pr, nodesW * pr, nodesH * pr, // source (image pixels)
          PAD * pr, PAD * pr, nodesW * pr, nodesH * pr,           // dest (canvas pixels)
        );
        return await new Promise<Blob>((res, rej) => {
          canvas.toBlob((b) => b ? res(b) : rej(new Error('canvas.toBlob failed')), 'image/png');
        });
      } catch (e) {
        console.warn('[mindmap] exportPng failed', e);
        return null;
      }
    }, []);
    const exportSvg = useCallback(async () => {
      const mind = mindRef.current as any;
      const target = containerRef.current?.querySelector('.map-canvas') as HTMLElement | null;
      if (!target || !mind) return new Blob();
      try {
        mind.scaleFit?.();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const svgText = await htmlToSvg(target, {
          backgroundColor: '#1f2023',
          cacheBust: true,
        });
        return new Blob([svgText], { type: 'image/svg+xml' });
      } catch (e) {
        console.warn('[mindmap] exportSvg failed', e);
        return new Blob();
      }
    }, []);

    React.useImperativeHandle(ref, () => ({
      get instance() { return mindRef.current; },
      fitToView,
      expandAll,
      collapseAll,
      setDirection,
      setCompact,
      exportPng,
      exportSvg,
    }), [fitToView, expandAll, collapseAll, setDirection, setCompact, exportPng, exportSvg]);

    return (
      <div
        ref={containerRef}
        className={`mind-elixir-container ${className ?? ''}`}
        style={{ width: '100%', height: '100%' }}
      />
    );
  },
);

export default MindElixirReact;
