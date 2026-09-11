/** 工具步骤卡片（ToolStepCard）文案 */
export default {
  title: {
    /** 纯思考步骤：流式生成中 / 已完成 */
    thinking: '思考中…',
    thought: '思考',
    /** 动作执行中（{{tool}} 为工具名） */
    running: '正在执行：{{tool}}',
    /** 旧版遗留的跳过步骤（{{tool}} 为工具名） */
    skipped: '已跳过 {{tool}}',
    /** 跳过步骤的补充说明（跟在标题后） */
    rejectedHint: '（基于现有材料回答）',
  },
  /** 工具参数标签（键与后端 PaperSearchTool 的字段对应） */
  arg: {
    title: '标题',
    abstract: '摘要/正文',
    keywords: '关键词',
    author: '作者',
    fulltext: '全文',
    yearFrom: '起始年份',
    yearTo: '截止年份',
    limit: '数量',
    paperIds: '论文',
  },
  /** 数组型参数的可读分隔符（如论文 id 列表） */
  argListSeparator: '、',
  /** 论文列表相关文案 */
  paper: {
    unknownAuthors: '未知作者',
    citationCount: '{{count}} 引用',
    openInReader: '在阅读器中打开该论文',
    addToContext: '加入上下文库（持久保存，供后续问答使用）',
  },
} as const;