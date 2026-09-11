/** store（zustand）内产生的用户可见文案：AI 建议标题/描述、数据块与上下文插入提示。
 * store 非组件、无法使用 hook，统一以 i18n.t('store:<相对键>') 调用。 */
export default {
  suggestion: {
    clarity: {
      title: '清晰度优化',
      description: '让这句话更简洁、更学术',
    },
    academicTone: {
      title: '学术语气',
      description: '提升学术写作风格',
    },
    contextualEnhancement: {
      title: '上下文增强',
      description: '补充引用上下文以增强论证',
    },
    grammarCorrection: {
      title: '语法修正',
      description: '改进句子结构',
    },
  },
  dataBlock: {
    notFound: '未找到数据块',
    unsupported: '不支持的数据块类型',
    /** {{type}} 为数据块类型标识（Table / Chart / Equation / Figure） */
    insertedTitle: '{{type}} 已插入',
    insertedDescription: '{{title}} — 由 AI 从数据块插入',
    addedToPaper: '{{type}} 已添加到论文',
  },
  contextInsert: {
    suggestionTitle: '上下文已插入：{{title}}',
    suggestionDescription: '{{title}} — 由 AI 从上下文库插入',
    success: 'Context 已插入论文（Conclusion 前，可接受）',
  },
} as const;