/**
 * mermaid 库的统一加载/初始化入口。
 *
 * 代码面板预览与「同源布局」（mermaidLayout）必须共用同一个 mermaid 实例与初始化
 * 配置，才能保证画布初始排布与用户在预览里看到的官方渲染一致（同一引擎、同一主题）。
 * 库体通过动态 import 拆成独立 chunk，仅在首次使用时下载；全局共享同一个 Promise。
 */
export type MermaidModule = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidModule> | null = null;

export function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      return mermaid;
    });
  }
  return mermaidPromise;
}
