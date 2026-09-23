import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ZoomIn, ZoomOut, Maximize, Loader2, FileText, RotateCw, PenLine, Boxes, MessageCircleQuestion } from 'lucide-react';
import { Highlight } from '../types';
import { locateInDocument, normalizeText, normOffsetToRunRange, PageRun } from '../utils/pdfLocate';
import { usePaperMindStore } from '../store';

/**
 * scale/rotation 变化导致整列表拆毁重建前的滚动锚点。
 * 重建会瞬间清空全部页 wrapper（scrollHeight 塌陷，浏览器把 scrollTop 钳 0），
 * 必须在拆毁前记录"当前视口顶部落在哪一页的哪个纵向比例"，重建后按新几何还原，
 * 否则开关 AI 面板/拖拽调宽/缩放/旋转后阅读位置会跳到别处。
 */
interface ScrollAnchor {
  /** 视口顶部当前所在页（按重建前几何判定） */
  page: number;
  /** 视口顶部在该页 wrapper 内的纵向比例 [0,1]（同文档纯缩放时可精确映射） */
  ratioInPage: number;
  /** 全局滚动比例兜底（跨文档/旋转后页内几何不再对应时使用） */
  globalRatio: number;
  /** 捕获时的旋转角：与重建后不一致则只能用全局比例 */
  rotation: number;
  /** 捕获时的文档代理：换文档后锚点失效（页码/几何不再对应） */
  doc: pdfjsLib.PDFDocumentProxy;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfViewerHandle {
  /** 当前渲染的论文 id（供阅读器判断 ref 是否指向目标论文） */
  paperId?: string;
  /** 在多页纵向文档中定位某段文字，滚动并闪亮高亮；返回是否命中 */
  locateText: (text: string) => Promise<boolean>;
}

interface PdfViewerProps {
  url: string;
  title?: string;
  paperId?: string;
  /** 该论文已保存的高亮（按页恢复用） */
  highlights?: Highlight[];
  onAddHighlight?: (hl: Omit<Highlight, 'id' | 'createdAt'>) => void;
  onRemoveHighlight?: (id: string) => void;
  /** 选中文本后回调：快速记笔记 */
  onNote?: (text: string) => void;
  /** 选中文本后回调：加入上下文库 */
  onContext?: (text: string) => void;
  /** 选中文本后回调：对该段提问 */
  onAsk?: (text: string) => void;
}

interface FloatMenu {
  x: number;
  top: number;
  bottom: number;
  text: string;
}

const HIGHLIGHT_COLORS = ['#FDE68A', '#A7F3D0', '#BFDBFE', '#FBCFE8'];

/**
 * 在某个 span[data-pdf-text] 内，把 [localStart, localEnd) 字符区间包裹为高亮 span。
 * 兼容该 div 因先前定位/高亮拆分而存在多个相邻文本节点的情况。
 */
function wrapDivRange(div: HTMLElement, localStart: number, localEnd: number, className: string): boolean {
  const textNodes: Text[] = [];
  let total = 0;
  div.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      textNodes.push(n as Text);
      total += (n as Text).length;
    }
  });
  if (textNodes.length === 0) return false;
  localStart = Math.max(0, Math.min(total, localStart));
  localEnd = Math.max(localStart, Math.min(total, localEnd));
  if (localEnd <= localStart) return false;

  let cursor = 0;
  let first: Text | null = null;
  let last: Text | null = null;
  for (const tn of textNodes) {
    const len = tn.length;
    const segStart = Math.max(cursor, localStart);
    const segEnd = Math.min(cursor + len, localEnd);
    if (segEnd > segStart) {
      const s = segStart - cursor;
      const keep = segEnd - segStart;
      let f: Text = tn;
      if (s > 0) f = tn.splitText(s);
      let l: Text = f;
      if (keep < f.length) l = f.splitText(keep);
      if (!first) first = f;
      last = l;
    }
    cursor += len;
  }
  if (!first || !last) return false;
  const span = document.createElement('span');
  span.className = className;
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  range.surroundContents(span);
  return true;
}

/** 清除某页文本层内的定位高亮包裹（还原为普通文本节点） */
function clearLocateRanges(layer: HTMLElement) {
  layer.querySelectorAll('.pdf-locate').forEach((el) => {
    const parent = el.parentNode;
    if (parent) {
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  });
}

/**
 * 在某页文本层中，把 normOffsetToRunRange 给出的 DOM 坐标范围
 * [runStart.charStart, runEnd.charEnd] 精确包裹为定位高亮（可能横跨多个 span）。
 */
function applyLocateRange(
  layer: HTMLElement,
  range: { runStart: number; charStart: number; runEnd: number; charEnd: number },
): boolean {
  const divs = Array.from(layer.querySelectorAll<HTMLElement>('span[data-pdf-text]'));
  if (divs.length === 0) return false;
  let applied = false;
  const last = Math.min(range.runEnd, divs.length - 1);
  for (let i = range.runStart; i <= last; i++) {
    const divLen = divs[i].textContent?.length ?? 0;
    const localStart = i === range.runStart ? Math.min(range.charStart, divLen) : 0;
    const localEnd = i === range.runEnd ? Math.min(range.charEnd, divLen) : divLen;
    if (wrapDivRange(divs[i], localStart, localEnd, 'pdf-locate pdf-jump-flash')) applied = true;
  }
  return applied;
}

/**
 * 多页纵向 PDF 阅读器。
 *
 * 渲染策略：以 fit-width 为基准统一 scale，把【所有】页面渲染成纵向
 * 排列的列表，每个页面 = 出错canvas（图画）+ textLayer（文字可选中/高亮），
 * 用滚动容器的鼠标滚轮在整篇文档间自由定位（无需翻页按钮）。
 * 这样做的好处：跨页内容始终连续在 DOM 中，文本定位/高亮可基于整篇文档，
 * 不会因单页翻页而导致跨页引用定位缺失。
 */
const PdfViewer = React.forwardRef<PdfViewerHandle, PdfViewerProps>(function PdfViewer({
  url,
  title,
  paperId,
  highlights = [],
  onAddHighlight,
  onRemoveHighlight,
  onNote,
  onContext,
  onAsk,
}, ref) {
  const { t } = useTranslation('pdf');
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 页面列表真实挂载点（React 仅渲染该空容器，页面元素由 JS 动态写入，避免与 React 协调冲突）
  const listRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [floatMenu, setFloatMenu] = useState<FloatMenu | null>(null);
  // 渲染进度：页面未就绪前显示 loading
  const [renderedCount, setRenderedCount] = useState(0);

  const renderTaskRef = useRef<Map<number, pdfjsLib.RenderTask>>(new Map());
  const textLayerRefObj = useRef<Map<number, pdfjsLib.TextLayer>>(new Map());
  const containerWidthRef = useRef<number>(0);
  const fitScaleRef = useRef<number>(1);
  const fitScaleBasisRef = useRef<pdfjsLib.PageViewport | null>(null);
  const userZoomRef = useRef(false);
  const pageReadyRef = useRef<Record<number, boolean>>({});
  // 每页 DOM 容器，供跨页定位（精确范围高亮 / scrollIntoView）与命中判定使用
  const pageWrapRefs = useRef<Map<number, HTMLElement>>(new Map());
  // 每页文本 runs（str + hasEOL），与 DOM span 顺序一一对应，用于精确高亮偏移映射
  const pageRunsRef = useRef<Map<number, PageRun[]>>(new Map());
  // 惰性渲染：每页 PDFPageProxy 对象（分片并行预取，避免串行 getPage 卡顿）
  const pagesRef = useRef<Map<number, pdfjsLib.PDFPageProxy>>(new Map());
  // 渲染中的页集合（防止 IntersectionObserver 对同一页重复触发渲染）
  const renderInFlightRef = useRef<Set<number>>(new Set());
  // 供定位（locateText）主动触发某页渲染（目标页可能在视口外）
  const renderPageRef = useRef<((pageNum: number) => Promise<void>) | undefined>(undefined);
  // 惰性渲染下页面渲染时机分散，渲染回调必须取【最新】applyPageHighlights，
  // 避免捕获 effect 创建时的旧高亮版本而漏掉之后新增的高亮（在 applyPageHighlights 定义处同步）
  const applyHighlightsRef = useRef<((wrap: HTMLElement, pageNum: number) => void) | null>(null);

  // 重建（scale/rotation 变化）前后的滚动位置锚点，见 ScrollAnchor 说明
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
  // AI 面板分隔条拖拽中：只更新容器宽度基准，fit-width 重排延迟到松手后一次应用，
  // 避免拖拽途中逐像素拆毁重建（卡顿 + 滚动位置反复跳动）
  const qaPanelResizing = usePaperMindStore((s) => s.qaPanelResizing);
  // ResizeObserver 回调在 [doc] effect 闭包内创建，用 ref 读最新拖拽状态
  const qaPanelResizingRef = useRef(qaPanelResizing);
  useEffect(() => { qaPanelResizingRef.current = qaPanelResizing; }, [qaPanelResizing]);

  /** 按当前容器宽度计算并应用 fit-width 缩放（无文档/用户手动缩放时不干预） */
  const applyFitWidthScale = useCallback(() => {
    const firstVp = fitScaleBasisRef.current;
    const w = containerWidthRef.current;
    if (!firstVp || w <= 0 || userZoomRef.current) return;
    const next = Math.max(0.5, Math.min(3, w / firstVp.width));
    fitScaleRef.current = next;
    setScale((prev) => (Math.abs(prev - next) < 1e-6 ? prev : next));
  }, []);

  // 加载 PDF 文档
  useEffect(() => {
    let cancelled = false;
    // 换文档：旧文档的滚动锚点失效（页码/几何不再对应），新文档从顶部开始
    scrollAnchorRef.current = null;
    setLoading(true);
    setError(null);
    setDoc(null);
    setNumPages(0);
    setRenderedCount(0);

    const task = pdfjsLib.getDocument({
      url,
      useWorkerFetch: true,
    });
    task.promise
      .then((loadedDoc) => {
        if (cancelled) return;
        setDoc(loadedDoc);
        setNumPages(loadedDoc.numPages);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('state.loadFailed'));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      task.destroy();
      // 卸载时清理所有页面渲染任务
      renderTaskRef.current.forEach((t) => t.cancel());
      renderTaskRef.current.clear();
      textLayerRefObj.current.forEach((tl) => tl.cancel());
      textLayerRefObj.current.clear();
      pageWrapRefs.current.clear();
      setRenderedCount(0);
    };
  }, [url]);

  // 监听滚动容器宽度（fit-width 基准）
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      containerWidthRef.current = w;
      // 拖拽 AI 面板分隔条途中不逐帧重排：只记录最新宽度，松手后由
      // qaPanelResizing 翻转的 effect 一次性应用（滚动锚点在那次重建时还原）
      if (w > 0 && doc && !userZoomRef.current && !qaPanelResizingRef.current) {
        applyFitWidthScale();
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [doc, applyFitWidthScale]);

  // 拖拽结束：按最终宽度做一次 fit-width 重排（重建时走滚动锚点还原）
  useEffect(() => {
    if (!qaPanelResizing) applyFitWidthScale();
  }, [qaPanelResizing, applyFitWidthScale]);

  // 渲染所有页面为纵向列表（视口惰性渲染）：
  // 1) 分片并行预取页面对象（避免逐页串行 getPage 卡顿）
  // 2) 预建全部占位 wrapper（高度固定 → 滚动条不跳动）
  // 3) IntersectionObserver 只渲染视口内（含缓冲）页面，离开视口即回收
  // 4) 单页 canvas 渲染与文本提取并行（不等 canvas 完成才取文本层）
  useEffect(() => {
    if (!doc) return;
    const list = listRef.current;
    if (!list) return;
    let cancelled = false;

    const cleanup = () => {
      renderTaskRef.current.forEach((t) => t.cancel());
      textLayerRefObj.current.forEach((tl) => tl.cancel());
      renderTaskRef.current.clear();
      textLayerRefObj.current.clear();
      pagesRef.current.clear();
      pageWrapRefs.current.clear();
      pageRunsRef.current.clear();
      pageReadyRef.current = {};
      renderInFlightRef.current.clear();
      list.innerHTML = '';
      setRenderedCount(0);
    };

    // 拆毁前捕获滚动锚点（必须在 cleanup() 清空 DOM 之前）：
    // scale/rotation 变化会走 cleanup→重建，期间 scrollHeight 塌陷使浏览器
    // 钳住 scrollTop，需记录视口顶部所在页及页内纵向比例，重建后按新几何还原
    const captureScrollAnchor = () => {
      const el = scrollRef.current;
      if (!el) return;
      const scrollable = el.scrollHeight - el.clientHeight;
      const globalRatio = scrollable > 0 ? el.scrollTop / scrollable : 0;
      let page = 0;
      let ratioInPage = 0;
      // pageWrapRefs 按页码升序插入：取第一个底边越过视口顶部的页
      for (const [p, wrap] of pageWrapRefs.current) {
        if (wrap.offsetTop + wrap.offsetHeight > el.scrollTop + 1) {
          page = p;
          ratioInPage = wrap.offsetHeight > 0
            ? Math.min(1, Math.max(0, (el.scrollTop - wrap.offsetTop) / wrap.offsetHeight))
            : 0;
          break;
        }
      }
      scrollAnchorRef.current = { page, ratioInPage, globalRatio, rotation, doc };
    };

    // 全部 wrapper 按新几何重建后还原滚动位置
    const restoreScrollAnchor = () => {
      const el = scrollRef.current;
      const anchor = scrollAnchorRef.current;
      scrollAnchorRef.current = null;
      if (!el || !anchor || anchor.doc !== doc) return;
      // 同文档且未旋转：页内比例可随缩放线性映射，位置精确
      if (anchor.rotation === rotation && anchor.page > 0) {
        const wrap = pageWrapRefs.current.get(anchor.page);
        if (wrap && wrap.offsetHeight > 0) {
          el.scrollTop = Math.round(wrap.offsetTop + anchor.ratioInPage * wrap.offsetHeight);
          return;
        }
      }
      // 旋转后页内几何不再对应：用全局滚动比例近似还原
      const scrollable = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.round(Math.max(0, scrollable) * anchor.globalRatio);
    };

    // 渲染单页：canvas 渲染与 getTextContent 并行，完成后建 TextLayer 并应用高亮
    const renderPage = async (p: number) => {
      const wrap = pageWrapRefs.current.get(p);
      const page = pagesRef.current.get(p);
      if (!wrap || !page || cancelled) return;
      if (pageReadyRef.current[p] || renderInFlightRef.current.has(p)) return;
      renderInFlightRef.current.add(p);

      const displayScale = scale || fitScaleRef.current;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: displayScale, rotation });
      // 回收后重新渲染：清掉残留 canvas/textLayer（wrapper 高度固定不变，滚动条稳定）
      wrap.innerHTML = '';

      const canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.zIndex = '1';
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const textLayer = document.createElement('div');
      textLayer.className = 'pdf-text-layer';
      textLayer.style.pointerEvents = 'auto';

      wrap.appendChild(canvas);
      wrap.appendChild(textLayer);

      try {
        // canvas 渲染 与 文本提取并行，缩短单页就绪时间
        const task = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTaskRef.current.set(p, task);
        const contentPromise = page.getTextContent();
        const [, content] = await Promise.all([task.promise, contentPromise]);
        if (cancelled) return;

        // 与 pdf.js 文本层一致：空字符串 run 不会生成 DOM span，必须跳过，
        // 保证 runs 下标与 DOM span 顺序一一对应。
        const runs: PageRun[] = [];
        for (const it of content.items) {
          if ('str' in it && it.str !== '') runs.push({ str: it.str, hasEOL: !!it.hasEOL });
        }
        pageRunsRef.current.set(p, runs);

        const tl = new pdfjsLib.TextLayer({
          textContentSource: content,
          container: textLayer,
          viewport,
        });
        textLayerRefObj.current.set(p, tl);
        await tl.render();

        // 给每个文本 div 打上标记便于定位高亮
        textLayer.querySelectorAll('span').forEach((s) => {
          if (!s.dataset.pdfText) s.dataset.pdfText = '1';
        });

        // 应用该页的已保存高亮（取最新版本，避免漏掉渲染后才新增的高亮）
        applyHighlightsRef.current(wrap, p);

        // 标记该页渲染完成
        pageReadyRef.current[p] = true;
        setRenderedCount((n) => n + 1);

        // 渲染期间可能已滚出视口（IO 离开回调触发时页尚未 ready，未回收）→ 补一次回收
        if (!isInViewport(wrap)) {
          recyclePage(p);
        }
      } catch (e) {
        if ((e as Error)?.name !== 'RenderingCancelledException' && !cancelled) {
          pageReadyRef.current[p] = true;
          setRenderedCount((n) => n + 1);
        }
      } finally {
        renderInFlightRef.current.delete(p);
      }
    };
    renderPageRef.current = renderPage;

    // 回收远离视口的已渲染页：取消任务并清空内容（保留占位 wrapper，滚动条稳定）
    const recyclePage = (p: number) => {
      if (!pageReadyRef.current[p]) return; // 只回收渲染完成的页，避免与渲染中回调竞态
      const wrap = pageWrapRefs.current.get(p);
      if (!wrap) return;
      const task = renderTaskRef.current.get(p);
      if (task) {
        try { task.cancel(); } catch { /* 忽略 */ }
        renderTaskRef.current.delete(p);
      }
      const tl = textLayerRefObj.current.get(p);
      if (tl) {
        try { tl.cancel(); } catch { /* 忽略 */ }
        textLayerRefObj.current.delete(p);
      }
      wrap.innerHTML = '';
      pageRunsRef.current.delete(p);
      pageReadyRef.current[p] = false;
      setRenderedCount((n) => Math.max(0, n - 1));
    };

    // 视口惰性渲染：进入视口（含上下 800px 缓冲，提前渲染）→ 渲染；离开 → 回收
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const p = Number((entry.target as HTMLElement).dataset.page || 0);
        if (!p) continue;
        if (entry.isIntersecting) {
          void renderPage(p);
        } else {
          recyclePage(p);
        }
      }
    }, { root: scrollRef.current, rootMargin: '800px 0px' });

    // 页是否在视口（含缓冲）内：渲染期间滚出视口的页，IO 离开回调未触发，需补回收
    const isInViewport = (el: HTMLElement): boolean => {
      const root = scrollRef.current;
      if (!root) return true;
      const r = root.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      const margin = 800;
      return e.bottom > r.top - margin && e.top < r.bottom + margin;
    };

    // 预建单页占位 wrapper（高度 = 该页 fit-width viewport 高度）
    const buildWrap = (p: number) => {
      if (pageWrapRefs.current.has(p)) return;
      const page = pagesRef.current.get(p);
      if (!page) return;
      const displayScale = scale || fitScaleRef.current;
      const viewport = page.getViewport({ scale: displayScale, rotation });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap pdf-page-wrap-multi';
      wrap.dataset.page = String(p);
      wrap.style.position = 'relative';
      wrap.style.flexShrink = '0';
      wrap.style.width = `${Math.floor(viewport.width)}px`;
      wrap.style.height = `${Math.floor(viewport.height)}px`;
      wrap.style.setProperty('--scale-factor', String(displayScale));
      list.appendChild(wrap);
      pageWrapRefs.current.set(p, wrap);
      observer.observe(wrap);
    };

    const setup = async () => {
      // 1) 先取首页确定统一的 fit-width 基准 scale
      const firstPage = await doc.getPage(1);
      let firstVp: pdfjsLib.PageViewport;
      try {
        firstVp = firstPage.getViewport({ scale: 1, rotation });
      } catch {
        firstVp = (await doc.getPage(1)).getViewport({ scale: 1, rotation });
      }
      fitScaleBasisRef.current = firstVp;
      if (containerWidthRef.current <= 0) {
        containerWidthRef.current = list.clientWidth || list.offsetWidth || 0;
      }
      if (containerWidthRef.current > 0) {
        fitScaleRef.current = Math.max(0.5, Math.min(3, containerWidthRef.current / firstVp.width));
      }
      pagesRef.current.set(1, firstPage);

      // 2) 分片并行预取其余页面对象（避免逐页串行 getPage 卡顿）
      const nums = Array.from({ length: doc.numPages - 1 }, (_, i) => i + 2);
      const BATCH = 6;
      for (let i = 0; i < nums.length; i += BATCH) {
        if (cancelled) return;
        const batch = nums.slice(i, i + BATCH);
        const pages = await Promise.all(batch.map((n) => doc.getPage(n)));
        pages.forEach((pg, k) => pagesRef.current.set(batch[k], pg));
      }
      if (cancelled) return;

      // 3) 预建全部占位 wrapper（高度固定 → 滚动条稳定），观察器接管后续惰性渲染
      for (let p = 1; p <= doc.numPages; p++) buildWrap(p);

      // 3.5) 全部占位已就位、列表总高度已确定：还原缩放/旋转前的阅读位置
      restoreScrollAnchor();

      // 4) 首屏立即渲染第 1 页（其余由观察器随滚动渲染）
      void renderPage(1);
    };

    setup();

    return () => {
      // 拆毁旧 DOM 前先记录锚点（cleanup 会瞬间清空列表导致 scrollTop 被钳 0）
      captureScrollAnchor();
      cancelled = true;
      observer.disconnect();
      renderPageRef.current = undefined;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, scale, rotation]);

  // 高亮变化时：无需重建页面，直接对已渲染的各页重新应用高亮（含新增/删除）
  useEffect(() => {
    if (!doc) return;
    pageWrapRefs.current.forEach((wrap, pageNum) => {
      applyPageHighlights(wrap, pageNum);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights]);

  // __applyPageHighlights：在指定页的 textLayer 中，把该页已保存高亮包裹为 <span class="pdf-highlight">
  const applyPageHighlights = useCallback((wrap: HTMLElement, pageNum: number) => {
    const layer = wrap.querySelector<HTMLElement>('.pdf-text-layer');
    if (!layer) return;
    // 先清掉定位高亮，避免与已保存高亮嵌套/互相干扰
    clearLocateRanges(layer);
    // 清空旧的高亮包裹
    layer.querySelectorAll('.pdf-highlight-wrap').forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    });

    const pageHighlights = highlights.filter(h => h.position && h.position.page === pageNum);
    if (pageHighlights.length === 0) return;

    const divs = Array.from(layer.querySelectorAll<HTMLElement>('span[data-pdf-text]'));
    if (divs.length === 0) return;

    const textRuns = divs.map(div => div.textContent ?? '');
    const offsets: number[] = [];
    let acc = 0;
    for (const t of textRuns) {
      offsets.push(acc);
      acc += t.length;
    }
    const fullText = textRuns.join('');

    const applyOne = (start: number, end: number) => {
      const clamp = (n: number) => Math.max(0, Math.min(fullText.length, n));
      start = clamp(start);
      end = clamp(end);
      if (end <= start) return;

      let i = 0;
      while (i < divs.length && offsets[i] + textRuns[i].length <= start) i++;
      if (i >= divs.length) return;

      let cursor = start;
      for (let j = i; j < divs.length && cursor < end; j++) {
        const divStart = offsets[j];
        const divEnd = divStart + textRuns[j].length;
        const segStart = Math.max(cursor, divStart);
        const segEnd = Math.min(end, divEnd);
        if (segEnd > segStart) {
          wrapDivRange(divs[j], segStart - divStart, segEnd - divStart, 'pdf-highlight pdf-highlight-wrap');
        }
        cursor = segEnd;
      }
    };

    for (const hl of pageHighlights) {
      if (!hl.position?.start || !hl.position?.end) continue;
      applyOne(hl.position.start, hl.position.end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights]);
  // 惰性渲染回调取最新版本（页面渲染时机分散，避免漏掉新增高亮）
  applyHighlightsRef.current = applyPageHighlights;

  // 监听滚动以关闭操作条（滚轮滚动时应收起浮条）
  useEffect(() => {
    const close = () => setFloatMenu(null);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, []);

  // 选中所属页：从选中节点向上找到离它最近的页 wrapper
  const resolvePageFromNode = useCallback((node: Node | null): HTMLElement | null => {
    let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
    while (el) {
      const htm = el as HTMLElement;
      if (htm.dataset?.page && pageWrapRefs.current.has(Number(htm.dataset.page))) break;
      el = el.parentElement;
    }
    return el as HTMLElement | null;
  }, []);

  // 选中文本：显示操作条
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setFloatMenu(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const wrap = resolvePageFromNode(range.commonAncestorContainer);
      if (!wrap) {
        setFloatMenu(null);
        return;
      }
      const textLayer = wrap.querySelector<HTMLElement>('.pdf-text-layer');
      if (!textLayer || !textLayer.contains(range.commonAncestorContainer)) {
        setFloatMenu(null);
        return;
      }
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text) {
        setFloatMenu(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const outerRect = outerRef.current?.getBoundingClientRect();
      if (!outerRect) return;
      const x = rect.left - outerRect.left + rect.width / 2;
      const top = rect.top - outerRect.top;
      const bottom = rect.bottom - outerRect.top;
      setFloatMenu({ x, top, bottom, text });
    }, 10);
  }, [resolvePageFromNode]);

  // 操作条位置校准（多页滚动时同样适用：菜单定位在 outer 坐标系）
  useLayoutEffect(() => {
    if (!floatMenu || !menuRef.current || !outerRef.current) return;
    const menu = menuRef.current;
    const outerRect = outerRef.current.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = floatMenu.x - menuRect.width / 2;
    left = Math.max(8, Math.min(outerRect.width - menuRect.width - 8, left));
    let top = floatMenu.bottom + 6;
    if (floatMenu.bottom + menuRect.height + 6 > outerRect.height) {
      top = floatMenu.top - menuRect.height - 6;
      if (top < 8) top = Math.max(8, outerRect.height - menuRect.height - 8);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [floatMenu]);

  // 计算选中文本在【所属页】text layer 中的偏移
  const computeSelectionOffsets = useCallback((): { page: number; wrap: HTMLElement; start: number; end: number; text: string } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const wrap = resolvePageFromNode(range.commonAncestorContainer);
    if (!wrap) return null;
    const page = Number(wrap.dataset.page);
    const layer = wrap.querySelector<HTMLElement>('.pdf-text-layer');
    if (!layer || !layer.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString();
    if (!text) return null;

    const divs = Array.from(layer.querySelectorAll('span[data-pdf-text]'));
    const textRuns = divs.map(div => div.textContent ?? '');
    const fullText = textRuns.join('');
    const norm = text.replace(/\s+/g, ' ');
    const idx = fullText.indexOf(norm);
    if (idx === -1) return null;
    return { page, wrap, start: idx, end: idx + norm.length, text: norm.trim() };
  }, [resolvePageFromNode]);

  const handleHighlight = useCallback((color: string) => {
    const info = computeSelectionOffsets();
    if (!info) return;
    if (paperId && onAddHighlight) {
      onAddHighlight({
        paperId,
        text: info.text,
        position: { page: info.page, start: info.start, end: info.end },
        color,
      });
    }
    setFloatMenu(null);
    window.getSelection()?.removeAllRanges();
    applyPageHighlights(info.wrap, info.page);
  }, [computeSelectionOffsets, paperId, onAddHighlight, applyPageHighlights]);

  const handleNote = useCallback(() => {
    const info = computeSelectionOffsets();
    if (!info) return;
    onNote?.(info.text);
    setFloatMenu(null);
    window.getSelection()?.removeAllRanges();
  }, [computeSelectionOffsets, onNote]);

  const handleContext = useCallback(() => {
    const info = computeSelectionOffsets();
    if (!info) return;
    onContext?.(info.text);
    setFloatMenu(null);
    window.getSelection()?.removeAllRanges();
  }, [computeSelectionOffsets, onContext]);

  const handleAsk = useCallback(() => {
    const info = computeSelectionOffsets();
    if (!info) return;
    onAsk?.(info.text);
    setFloatMenu(null);
    window.getSelection()?.removeAllRanges();
  }, [computeSelectionOffsets, onAsk]);

  const zoomIn = useCallback(() => {
    userZoomRef.current = true;
    setScale((s) => Math.min(4, +(s * 1.15).toFixed(2)));
  }, []);
  const zoomOut = useCallback(() => {
    userZoomRef.current = true;
    setScale((s) => Math.max(0.4, +(s / 1.15).toFixed(2)));
  }, []);
  const fitWidth = useCallback(() => {
    userZoomRef.current = false;
    setScale(fitScaleRef.current || 1);
  }, []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  // 暴露精确定位接口：先在整篇文档（逐页拼接纯文本）中定位命中范围，
  // 再把命中范围按页切分、映射到每页 DOM span 的精确字符区间，连续包裹高亮。
  useImperativeHandle(ref, () => ({
    paperId,
    locateText: async (rawText: string): Promise<boolean> => {
      const target = normalizeText(rawText);
      const docRef = doc;
      const scroll = scrollRef.current;
      if (!target || !docRef || !scroll) return false;

      try {
        // 全文定位 → 页码 + 命中范围（跨页连续）
        const hit = await locateInDocument(docRef, target);
        if (!hit) return false;

        const wrap = pageWrapRefs.current.get(hit.page);
        if (!wrap) return false;

        // 先滚动目标页到视口中部
        const scroller = scroll;
        const targetTop = wrap.offsetTop - (scroller.clientHeight || 400) / 3;
        scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });

        // 等待该页渲染完成（惰性渲染下目标页可能在视口外：主动触发其渲染）
        const waitMs = Date.now() + 5000;
        while (Date.now() < waitMs) {
          if (!pageReadyRef.current[hit.page] && renderPageRef.current) {
            void renderPageRef.current(hit.page);
          }
          if (pageReadyRef.current[hit.page]
            && wrap.querySelector('span[data-pdf-text]')) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        // 清除上一次的定位高亮（所有已渲染页）
        pageWrapRefs.current.forEach((pw) => {
          const pl = pw.querySelector<HTMLElement>('.pdf-text-layer');
          if (pl) clearLocateRanges(pl);
        });

        // 命中范围可能跨页：逐页切分，把页内 norm 偏移映射到 DOM span 精确区间
        const offsets = hit.pageOffsets;
        let page = hit.page;
        let localStart = hit.start - hit.pageStart;
        let remaining = hit.length;
        let any = false;
        while (page <= docRef.numPages && remaining > 0) {
          const pageStartOff = offsets[page - 1];
          const pageEndOff = page < docRef.numPages ? offsets[page] : Number.MAX_SAFE_INTEGER;
          const take = Math.min(remaining, Math.max(0, pageEndOff - pageStartOff - localStart));
          if (take > 0) {
            const pWrap = pageWrapRefs.current.get(page);
            const runs = pageRunsRef.current.get(page);
            const pLayer = pWrap?.querySelector<HTMLElement>('.pdf-text-layer');
            if (pWrap && runs && pLayer) {
              const range = normOffsetToRunRange(runs, localStart, take);
              if (range && applyLocateRange(pLayer, range)) any = true;
            }
          }
          remaining -= take;
          page += 1;
          localStart = 0;
        }

        // 滚动到命中页中部，方便看到高亮
        wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return any;
      } catch {
        return false;
      }
    },
  }), [doc, paperId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-textSecondary">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">{t('state.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-textSecondary">
        <FileText className="w-8 h-8 mb-3 opacity-50" />
        <p className="text-sm text-red-400 mb-2">{t('state.renderFailed')}</p>
        <p className="text-xs max-w-sm text-center">{error}</p>
      </div>
    );
  }

  return (
    <div ref={outerRef} className="relative flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface border-b border-border flex-shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-xs text-textSecondary whitespace-nowrap">
            {t('toolbar.pagesHint', { count: numPages })}
          </span>
        </div>

        {title && (
          <p className="text-xs text-textSecondary truncate max-w-[200px] hidden md:block">{title}</p>
        )}

        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary transition-colors"
            title={t('toolbar.zoomOut')}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={fitWidth}
            className="px-2 py-1.5 rounded-lg hover:bg-background text-textSecondary text-xs transition-colors"
            title={t('toolbar.fitWidth')}
          >
            <Maximize className="w-4 h-4" />
          </button>
          <button
            onClick={zoomIn}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary transition-colors"
            title={t('toolbar.zoomIn')}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <span className="text-xs text-textSecondary w-10 text-center">{Math.round(scale * 100)}%</span>
          <button
            onClick={rotate}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary transition-colors"
            title={t('toolbar.rotate')}
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 多页纵向滚动容器：页面元素由 render effect 动态写入 listRef */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-background/50 relative"
        onMouseUp={handleMouseUp}
      >
        <div
          ref={listRef}
          className="flex flex-col items-center gap-6 px-4 py-4 w-full min-h-full"
        />
        {renderedCount === 0 && doc && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-textSecondary pointer-events-none">
            <Loader2 className="w-8 h-8 animate-spin mb-3" />
            <p className="text-sm">{t('state.rendering')}</p>
          </div>
        )}
      </div>

      {/* 选中操作条 */}
      {floatMenu && (
        <div
          ref={menuRef}
          className="absolute z-50 flex items-center gap-1 px-1.5 py-1 bg-surface border border-border rounded-xl shadow-2xl"
          style={{ left: floatMenu.x, top: floatMenu.bottom + 6 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-center gap-1 pr-1 border-r border-border">
            {HIGHLIGHT_COLORS.map(color => (
              <button
                key={color}
                onClick={() => handleHighlight(color)}
                className="w-5 h-5 rounded-md transition-transform hover:scale-110"
                style={{ backgroundColor: color }}
                title={t('selection.highlight')}
              />
            ))}
          </div>
          <button
            onClick={handleNote}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary hover:text-primary transition-colors"
            title={t('selection.note')}
          >
            <PenLine className="w-4 h-4" />
          </button>
          <button
            onClick={handleContext}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary hover:text-primary transition-colors"
            title={t('selection.addToContext')}
          >
            <Boxes className="w-4 h-4" />
          </button>
          <button
            onClick={handleAsk}
            className="p-1.5 rounded-lg hover:bg-background text-textSecondary hover:text-primary transition-colors"
            title={t('selection.askAbout')}
          >
            <MessageCircleQuestion className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
});

export default PdfViewer;