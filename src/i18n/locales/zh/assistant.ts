/** 助手消息渲染（AssistantMessage）文案 */
export default {
  /** 正文内 [Source N] 跳转按钮的悬停提示 */
  inlineSource: {
    locate: '在原文中定位出处 [{{n}}]',
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
  /** 句中行内引用标记（无编号引用卡） */
  citation: {
    /** 流式中出处尚未绑定 */
    verifying: '正在核对原文…',
    /** 引用卡三态之失败：材料中找不到该句 */
    failedTitle: '引用核对失败',
    failedNote: '未能在提供的材料中逐字找到这句话，无法确认出处。',
  },
  /** 出处区域：只展示来源名与核心原句，分块全文不展开 */
  sources: {
    title: '出处',
    /** 出处条目无 context_id 时的兜底名称 */
    currentPaper: '当前论文',
    locateInPaper: '定位原文',
    openInReaderTitle: '在阅读器中打开该论文并定位原文',
  },
} as const;
