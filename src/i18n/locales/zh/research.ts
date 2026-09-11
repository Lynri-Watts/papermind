/** 研究（阅读器）：多标签 PDF 阅读、元数据栏与上传弹窗文案 */
export default {
  header: {
    title: '阅读器',
    /** 工作区指示：已选中工作区时的文案 */
    workspace: '当前工作区',
    noWorkspace: '未选择工作区',
    upload: '上传文献',
    uploadTitle: '上传本地文献（PDF 等）到当前工作区并阅读',
  },
  tabs: {
    /** 论文标题缺失时的兜底标题 */
    untitled: '论文',
    close: '关闭标签页',
    add: '新增',
    addTitle: '上传本地文献（PDF 等）并阅读',
  },
  meta: {
    unknownAuthors: '未知作者',
    noPaper: '未选择论文',
    unknownVenue: '未知出版来源',
    /** 引用次数；count 供英文单复数使用，formatted 为本地化后的数字 */
    citations: '{{formatted}} 次引用',
    /** 一键加入当前工作区上下文库（元数据栏右侧按钮） */
    addToContext: '加入上下文',
    addToContextTitle: '把当前标签页的论文加入当前工作区的上下文库',
    addingToContext: '加入中…',
    /** 已收录时的不可点击态 */
    inContext: '已在上下文',
    inContextTitle: '该论文已在当前工作区的上下文库中',
  },
  pdf: {
    preparing: '正在准备 PDF…',
    /** 后端未提供 PDF 时的兜底说明 */
    unavailable: '该论文没有可用的 PDF',
    /** 探测 PDF 可用性失败时的兜底说明 */
    fetchFailed: '无法获取该论文的 PDF',
    /** 失败面板：手动重新尝试获取 */
    retry: '刷新重试',
    retryTitle: '手动重新尝试获取该论文的 PDF（自动获取失败后不会再自动重试，避免触发限流）',
  },
  empty: {
    hint: '点击「上传文献」打开本地 PDF，或到「探索」搜索论文后打开阅读',
  },
  paper: {
    /** 摘要标题 */
    abstract: '摘要',
    noAbstract: '（该论文暂无摘要）',
    viewSource: '查看原文：{{url}}',
  },
  upload: {
    panelTitle: '上传本地文献',
    /** 弹窗未选择工作区时的说明；<home> 为跳转主页的高亮词 */
    needWorkspaceHint: '尚未选择工作区。上传的文献存放在工作区中，请先到 <home>主页</home> 创建或进入一个工作区后再上传。',
    /** 上传入口的前置校验提示 */
    needWorkspace: '尚未选择工作区，请先在主页创建或进入一个工作区',
    pick: '点击选择本地文件',
    supported: '支持 PDF（自动打开阅读）、.tex / .bib（写作）、.txt / .md',
    uploading: '上传中...',
    failed: '上传失败',
    uploaded: '已上传：{{path}}',
  },
  notice: {
    highlightAdded: '已添加高亮',
    noteAdded: '已记入笔记',
    contextAdded: '已存为上下文摘录',
    contextFailed: '加入上下文失败',
    /** 一键整篇加入成功 */
    addedToContext: '已加入上下文库：{{title}}',
    addToContextFailed: '加入上下文失败',
    selectPaperFirst: '请先选择论文',
    /** 引用定位失败提示；snippet 为截断后的引用内容 */
    locateFailed: '未能在原文中找到该引用内容：{{snippet}}',
  },
} as const;