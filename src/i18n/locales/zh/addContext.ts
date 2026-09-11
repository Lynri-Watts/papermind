/** 添加上下文弹窗（AddContextModal）文案 */
export default {
  /** 弹窗标题 */
  title: '添加到上下文',
  /** 导入类型切换 */
  mode: {
    paper: '论文',
    url: 'URL',
  },
  /** 论文库导入 */
  paper: {
    hint: '从论文库导入，摘要自动提取 abstract（无摘要时由 AI 生成）',
    searchPlaceholder: '搜索论文标题 / 关键词...',
    searching: '搜索中...',
    empty: '未找到匹配的论文',
    /** 论文无摘要时的兜底占位 */
    noAbstract: '（无摘要）',
  },
  /** URL 导入 */
  url: {
    hint: '抓取网页正文并生成摘要（未配置 API Key 时自动截取正文开头）',
    importing: '抓取并生成摘要...',
    import: '导入',
  },
  errors: {
    importFailed: '导入失败，请检查后端服务',
  },
} as const;
