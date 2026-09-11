/** 主页（工作区管理）文案 */
export default {
  /** 标题区副标题 */
  subtitle: '选择一个工作区开始研究，或创建一个新的工作区',
  create: {
    title: '新建工作区',
    namePlaceholder: '工作区名称（必填），如：Transformer 综述',
    descriptionPlaceholder: '简短描述（可选）',
    /** 主按钮：创建后选定为当前工作区 */
    submit: '创建并选定',
    /** 折叠态大按钮 */
    prompt: '点击创建新的工作区',
    promptHint: '上传的文献与正在写作的论文都存放在工作区内',
  },
  list: {
    heading: '我的工作区（{{count}}）',
    empty: '还没有工作区，创建第一个开始吧',
    /** 当前工作区卡片的不可点击徽标 */
    selected: '已选定',
    /** 切换为当前工作区进行中的徽标 */
    selecting: '切换中…',
    /** 工作区没有描述时的兜底：文件数量 */
    fileCount: '{{count}} 个文件',
    filesHeading: '文件（{{count}}）',
    filesEmpty: '该工作区暂无文件，可在阅读器「上传文献」中向当前工作区上传',
    /** 展开文件按钮的 title */
    viewFiles: '查看文件',
    /** 删除按钮的 title */
    deleteWorkspace: '删除工作区',
  },
  errors: {
    nameRequired: '请输入工作区名称',
    createFailed: '创建工作区失败',
    deleteFailed: '删除工作区失败',
    selectFailed: '选择工作区失败',
  },
  confirm: {
    delete: '确定删除工作区「{{name}}」？其内所有文件将一并删除。',
  },
  time: {
    justNow: '刚刚',
    minutesAgo: '{{count}} 分钟前',
    hoursAgo: '{{count}} 小时前',
    monthDay: '{{month}}月{{day}}日',
  },
} as const;
