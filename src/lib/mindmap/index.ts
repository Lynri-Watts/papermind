/**
 * 思维导图前端内核统一出口（文档模型 / MindElixir 数据转换 / Markdown 互换 / 稳定 ID 合入）。
 * 画布、Markdown 源码面板、SSE AI diff 全部只依赖本目录，保证 GUI 与 AI 走同一套语义。
 *
 * 非 mindmap 的 mermaid 图（flowchart / sequenceDiagram 等）继续使用 mermaid 引擎——
 * mermaidLoader / useMermaidRender 独立于本模块，按需引用。
 */
export * from './model';
export * from './diagramType';
export * from './elixirMapper';
export * from './diffMerge';
export * from './mermaidLoader';
export * from './useMermaidRender';
