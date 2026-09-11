/** AI 助手面板（QAPanel）文案 */
export default {
  tab: {
    qa: 'AI 问答',
    context: '上下文',
    data: '数据',
  },
  panel: {
    expand: '展开 AI 助手',
    collapse: '折叠 AI 助手',
    clearChat: '清空对话',
    /** 上下文标签页头部：特化为添加外部网页链接 */
    addExternalLink: '添加外部链接',
  },
  focus: {
    reading: '阅读焦点：{{title}}',
    readingEmpty: '阅读焦点：未打开论文',
    writing: '写作焦点：AI 可读取当前 LaTeX 文档',
    explore: '探索焦点：基于上下文库与外部检索',
  },
  quick: {
    heading: '快捷提问：',
    q1: '总结当前论文的核心贡献',
    q2: '这篇论文的方法与已有工作有何不同？',
    q3: '帮我改写上面这段 LaTeX 表达得更学术',
    q4: '检索相关的最新研究并列出',
  },
  empty: {
    intro: '三大板块共用一个 AI 助手：阅读论文、检索文献、撰写 LaTeX 都可在此提问。',
  },
  input: {
    placeholder: '阅读、搜索、写作共用一个助手...',
    stop: '停止生成',
  },
  toggle: {
    context: '上下文',
    contextHint: '启用/停用上下文库',
    search: 'AI 检索',
    searchHint: '启用/停用 AI 检索文献工具（开启时 AI 在 ReAct 循环中自主调用搜索/读全文工具，无需逐次确认）',
    manage: '管理',
    manageHint: '固定/排除上下文项',
  },
  ctx: {
    pinnedCount: '固定 {{count}}',
    excludedCount: '排除 {{count}}',
    selectorEmpty: '暂无上下文，请先在「上下文」页添加论文或网页。',
    pin: '固定',
    pinned: '已固定',
    pinHint: '固定此项（每次问答必用）',
    exclude: '排除',
    excluded: '已排除',
    excludeHint: '排除此项（AI 不会使用）',
    all: '全部 ({{count}})',
    empty: '上下文库为空。点击右上角「+」从论文库导入论文，或抓取网页生成摘要。',
  },
  data: {
    heading: 'AI 提取的数据块',
    intro: '从上下文论文中自动提取。点击 "插入论文" 直接插入 LaTeX 文档（Conclusion 前，可接受）。',
    toolsHeading: '数据分析工具',
    addToPaper: '插入论文',
    adding: '插入中...',
    tool: {
      chart: '生成图表',
      table: '创建表格',
      stats: '统计分析',
      export: '导出数据',
    },
    blockType: {
      chart: '图表',
      table: '表格',
      equation: '公式',
      figure: '图片',
      data: '数据',
    },
  },
  stage: {
    connecting: '正在连接服务...',
  },
  step: {
    execFailed: '{{tool}} 执行失败',
    failed: '{{tool}} 失败',
    stoppedNoResult: '已停止生成，该工具未返回结果',
    interruptedNoResult: '生成中断，该工具未返回结果',
  },
  error: {
    ragFailed: 'RAG 问答失败',
    ragFailedWith: 'RAG 问答失败：{{message}}',
    addContextFailed: '加入上下文失败',
  },
  notice: {
    addedToContext: '已加入上下文库',
    addedToContextWithTitle: '已加入上下文库：{{title}}',
    openedInReader: '已在阅读器中打开：{{title}}',
    contextInserted: 'Context 已插入论文（Conclusion 前，可接受）',
    dataBlockAdded: '{{type}} 已插入论文',
  },
  label: {
    paper: '论文',
  },
} as const;