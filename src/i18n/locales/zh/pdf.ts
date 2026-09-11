/** PDF 阅读器（PdfViewer）文案 */
export default {
  state: {
    loading: '正在加载 PDF…',
    rendering: '正在渲染页面…',
    renderFailed: '无法渲染 PDF',
    loadFailed: '无法加载 PDF',
  },
  toolbar: {
    /** 工具栏左侧提示：总页数与滚动说明（中文无复数，仅基础键） */
    pagesHint: '{{count}} 页 · 鼠标滚轮滚动',
    zoomOut: '缩小',
    fitWidth: '适应宽度',
    zoomIn: '放大',
    rotate: '旋转',
  },
  selection: {
    /** 选中文本浮条上各按钮的 title */
    highlight: '高亮',
    note: '记笔记',
    addToContext: '加入上下文库',
    askAbout: '对该段提问',
  },
} as const;