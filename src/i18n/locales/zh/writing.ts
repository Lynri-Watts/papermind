/** 创作模块（LaTeX 编辑器与论文预览）文案 */
export default {
  header: {
    title: 'LaTeX 编辑器',
  },
  toolbar: {
    /** 撤销/重做 */
    undo: '撤销',
    redo: '重做',
    /** 行内格式 */
    bold: '加粗',
    italic: '斜体',
    list: '列表',
    link: '链接',
    code: '代码',
    math: '公式',
    /** 快捷插入的块级结构 */
    section: '章节',
    subsection: '小节',
    equation: '公式',
    /** AI 动作 */
    aiEdit: 'AI 编辑',
    acceptAll: '全部接受（{{count}}）',
    /** 编译与保存 */
    compile: '编译',
    save: '保存',
  },
  structure: {
    title: '文档结构',
    empty: '未发现章节',
  },
  suggestion: {
    /** AI 建议类型标签 */
    improvement: '改进',
    correction: '修正',
    addition: '补充',
    refinement: '润色',
    fallback: '建议',
    /** 悬停提示框中的对比标签 */
    original: '原文',
    suggested: '建议',
    reject: '拒绝',
    accept: '接受',
  },
  preview: {
    title: '预览',
    zoomOut: '缩小',
    zoomIn: '放大',
    reset: '重置',
  },
} as const;
