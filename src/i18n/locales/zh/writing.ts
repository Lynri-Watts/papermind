/** 创作模块（多文件 LaTeX 写作、预览与编译）文案 */
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
    link: '插入链接',
    image: '插入图片（\\includegraphics）',
    /** 快捷插入的块级结构 */
    section: '章节 \\section',
    subsection: '小节 \\subsection',
    itemize: '无序列表（itemize）',
    enumerate: '有序列表（enumerate）',
    /** 编译与保存 */
    compile: '编译',
    save: '保存',
  },
  structure: {
    title: '文档结构',
    empty: '未发现章节',
  },
  files: {
    title: '文件',
    empty: '暂无文件。点击上方 + 新建文本文件，或用上传按钮添加 PDF、图片等资料。',
    create: '新建文本文件',
    createTitle: '新建文本文件',
    namePlaceholder: '文件名（不含扩展名）',
    confirmCreate: '创建',
    cancel: '取消',
    upload: '上传文件',
    refresh: '刷新文件列表',
    retry: '重试',
    close: '关闭标签',
    unsaved: '未保存',
    notEditable: '该文件为二进制格式，无法在应用内编辑',
    delete: '删除文件',
    deleteConfirm: '确定删除文件「{{name}}」吗？此操作不可恢复。',
    closeDirtyConfirm: '文件「{{name}}」有尚未保存的改动，关闭将丢失这些改动。确定关闭？',
    copyImageRef: '复制 \\includegraphics 引用路径',
    insertRef: '复制引用',
    openNewTab: '在浏览器新标签页打开',
    download: '下载',
    refCopied: '已复制图片引用路径：{{path}}',
    errEmpty: '文件名不能为空',
    errInvalid: '文件名不合法：仅允许相对路径，禁止 \\、:、/ 开头与 .. 越界',
    errExt: '仅可创建 .tex/.bib/.md/.txt 文本文件',
    errExists: '同名文件已存在',
    createFailed: '创建文件失败',
    loadFailed: '文件加载失败',
    saveFailed: '文件保存失败',
    uploadFailed: '部分文件上传失败',
    deleteFailed: '删除文件失败',
    copyFailed: '复制失败：浏览器未授权剪贴板访问',
  },
  status: {
    saved: '已保存',
    saving: '保存中…',
    unsaved: '未保存',
    compiling: '编译中…',
  },
  compile: {
    ok: '编译成功',
    failed: '编译失败',
    pdfTab: '编译 PDF',
    logTab: '编译日志',
    pdfEmpty: '尚未编译。停止编辑 1.5 秒后将自动编译，也可点击下方按钮立即编译。双击编译后的 PDF 可跳回源码对应位置。',
    noLog: '编译日志为空。',
    /** 自动编译失败后暂停提示 */
    autoPaused: '自动编译已暂停。修正问题后点击「编译」手动恢复，之后空闲自动编译将重新启用。',
    resume: '立即编译并恢复自动编译',
    /** 双击 PDF 反向定位 */
    locateFailed: '无法从 PDF 定位到源码位置（请确认已成功编译，且点击位置在正文上）',
    locateTimeout: '未能打开「{{name}}」并完成定位，请重试',
    locateUnsupported: 'SyncTeX 指向的「{{name}}」不是可编辑的文本文件',
  },
  review: {
    /** 内联 diff 块控件 tooltip */
    acceptHunk: '接受该处修改',
    rejectHunk: '拒绝并还原该处修改',
    /** 逐块操作失败（WritingWorkspace notice / 审核条错误兜底） */
    actionFailed: '操作失败，请重试',
    /** 整事务回滚时部分新建文件已被用户改动，保留未删 */
    rollbackKept: '以下文件创建后已被修改，已保留：{{names}}',
    /** 回答卡片上的事务审核条 */
    editedHint: 'AI 已修改本文档，可在编辑器中逐处接受/拒绝',
    writingLive: 'AI 正在写作…',
    acceptAll: '全部接受',
    undoAll: '撤销本次写作',
    acceptedAll: '已接受全部修改',
    undone: '本次写作已撤销',
  },
} as const;
