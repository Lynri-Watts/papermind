/**
 * mermaid 源码 → SVG 的只读渲染 hook（代码面板预览 / 非 mindmap 只读图共用）。
 *
 * 约定：
 * - 经 loadMermaid() 取全局唯一实例（与同源布局同引擎、同 dark 主题）；
 * - debounce 后渲染，单调序号丢弃过期结果（快速连续改源码不会闪烁旧图）；
 * - 渲染失败返回 failed（mermaid 的语法错误信息），调用方决定如何展示；
 * - 空源码为 idle（不触发渲染）。
 */
import { useEffect, useState } from 'react';
import { loadMermaid } from './mermaidLoader';

export type MermaidRenderState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'failed'; message: string };

/** 跨实例单调序号：同一时刻只承认最后一次渲染结果（与原代码面板 previewSeq 同义） */
let renderSeq = 0;

export function useMermaidRender(source: string, debounceMs = 300): MermaidRenderState {
  const [state, setState] = useState<MermaidRenderState>(
    source.trim() ? { status: 'loading' } : { status: 'idle' }
  );

  useEffect(() => {
    if (!source.trim()) {
      setState({ status: 'idle' });
      return;
    }
    const seq = ++renderSeq;
    setState({ status: 'loading' });
    let cancelled = false;

    const timer = window.setTimeout(() => {
      loadMermaid()
        .then(async (mermaid) => {
          if (cancelled || seq !== renderSeq) return;
          try {
            const id = `mmd-render-${Date.now()}-${seq}`;
            const { svg } = await mermaid.render(id, source);
            if (!cancelled && seq === renderSeq) setState({ status: 'ready', svg });
          } catch (e) {
            if (!cancelled && seq === renderSeq) {
              setState({
                status: 'failed',
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && seq === renderSeq) {
            setState({
              status: 'failed',
              message: e instanceof Error ? e.message : String(e),
            });
          }
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, debounceMs]);

  return state;
}
