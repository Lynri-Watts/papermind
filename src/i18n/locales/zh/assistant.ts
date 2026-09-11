/** 助手消息渲染（AssistantMessage）文案 */
export default {
  /** 正文内 [Source N] 徽标的悬停提示 */
  inlineSource: {
    title: '查看出处 [{{n}}]',
  },
  /** ReAct / AI 推理轨迹区 */
  trail: {
    /** 流式生成中的实时轨迹标题 */
    reactTitle: 'ReAct 推理过程',
    /** 完成后折叠记录的标题 */
    aiTitle: 'AI 推理过程',
    steps: '{{count}} 步',
    thinking: 'AI 正在思考...',
    expandHint: '点击步骤可展开思考',
  },
  /** 用户点击停止后、生成仍在收尾时的统一占位文案 */
  stopping: '正在停止...',
  /** 流式生成中尚无正文时的占位文案 */
  stream: {
    processing: '正在处理...',
  },
  /** 出处区域 */
  sources: {
    title: '出处',
    /** 出处条目无 context_id 时的兜底名称 */
    currentPaper: '当前论文',
    collapse: '点击收起',
    expandFull: '点击展开出处全文',
    locateInPaper: '在该论文中定位这句话',
    openInReaderTitle: '在阅读器中打开该论文并定位原文',
  },
} as const;
