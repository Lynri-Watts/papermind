/** 上下文条目卡片（ContextItemCard）文案 */
export default {
  /** 类型徽标 */
  type: {
    paper: '论文',
    url: 'URL',
  },
  /** 生成状态徽标（ready 以外的 pending 态） */
  status: {
    generating: '生成中',
    /** paper 全文/PDF 自动获取失败的徽标 */
    unavailable: '无法打开',
    /** 徽标悬停：无后端原因时的兜底提示 */
    unavailableTitle: '该论文全文自动获取失败，可点击刷新按钮手动重试',
  },
  /** 摘要编辑 */
  summary: {
    empty: '（无摘要，点击编辑）',
    /** 操作按钮的 title */
    edit: '编辑摘要',
    /** 摘要文本的点击提示 */
    editTitle: '点击编辑摘要',
  },
  /** 标签 */
  tag: {
    /** 新增标签输入框的 placeholder */
    placeholder: '标签',
    /** 新增标签按钮的文案 */
    add: '标签',
  },
  /** 右侧操作按钮的 title */
  actions: {
    insertPaper: '一键插入论文',
    /** 把该论文转移到阅读器（研究视图）打开 */
    openInReader: '在阅读器中打开',
    viewContent: '按需查看全文',
    collapseContent: '收起全文',
    regenerate: '重新生成摘要',
    /** 无法打开时：手动重新尝试获取全文/PDF */
    retryPdf: '手动刷新，重新尝试获取全文',
  },
  /** 全文按需展开区 */
  content: {
    /** 标题行：{{kind}} 由 webText / paperFullText 填充 */
    label: '{{kind}}（按需加载，不随问答上传）',
    webText: '网页正文',
    paperFullText: '论文全文',
    empty: '（无全文内容）',
    loading: '加载中...',
  },
  errors: {
    fetchContentFailed: '获取全文失败',
    saveFailed: '保存失败',
    addTagFailed: '添加标签失败',
    removeTagFailed: '移除标签失败',
    refreshFailed: '刷新失败',
    retryPdfFailed: '重新尝试获取全文失败',
    deleteFailed: '删除失败',
  },
} as const;
