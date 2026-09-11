/** 设置页：界面语言、论文数据源与大模型服务配置文案 */
export default {
  title: '设置',
  /** 副标题中的 `.env` 用 <env> 包裹，以保留等宽字体样式（Trans 命名组件） */
  subtitle: '管理论文数据源与大模型服务；凭据保存在后端 <env>.env</env>，保存后立即生效',
  loading: '正在读取设置...',
  /** 加载失败时的兜底文案；后端返回了错误信息时直接显示后端信息 */
  loadError: '无法读取设置，请确认后端服务已启动',

  /** 界面语言（语言自名取自 LANGUAGE_LABELS，不翻译） */
  language: {
    title: '界面语言',
    description: '切换后立即生效，并记住你的选择',
  },

  llm: {
    title: '大模型服务',
    /** 字段名沿用接口术语，不翻译 */
    baseUrl: 'Base URL',
    model: '模型名',
    apiKey: 'API Key',
  },

  /** 密钥/凭据输入框占位符（数据源与 LLM 共用） */
  placeholder: {
    /** 已配置时只回显掩码，留空表示不修改 */
    configuredRemain: '已配置 {{value}}（留空保持不变）',
    secret: '粘贴你的 API Key',
    mailto: '填写后进入 polite pool',
    empty: '未填写',
  },

  reveal: {
    show: '显示',
    hide: '隐藏',
  },

  test: {
    button: '连通性测试',
    sourceHint: '用已保存的配置发起一次真实检索',
    llmHint: '用已保存的配置发起一次最小对话',
    sourceDirtyHint: '该项有未保存的改动，请先保存再测试',
    llmDirtyHint: 'LLM 配置有未保存的改动，请先保存再测试',
    failed: '测试失败',
    /** 成功结果后缀：耗时（前缀空格由调用处拼接，保持原渲染） */
    latency: '· {{ms}}ms',
  },

  save: {
    success: '已保存到后端 .env 并立即生效（无需重启）',
    failed: '保存失败',
  },

  error: {
    atLeastOneSource: '至少要启用一个数据源',
    noChanges: '没有需要保存的改动',
  },

  sources: {
    title: '论文数据源',
    description: '排序决定多源检索时的聚合优先级（越靠前越优先）；停用的数据源不参与检索，也不会出现在「探索」的来源筛选中。',
    /** 卡片状态徽标；disabled 同时用于已停用分区分隔线 */
    enabled: '已启用',
    disabled: '已停用',
    credentialConfigured: '已配置凭据',
    credentialMissing: '未配置凭据',
    getApiKey: '获取 API Key',
    docs: '文档',
    moveUp: '提高优先级',
    moveDown: '降低优先级',
    clear: '清除',
    pendingClear: '待清除',
    clearHint: '保存后清除该凭据',
  },

  footer: {
    dirty: '有未保存的改动',
    clean: '当前配置已与后端一致',
    discard: '放弃改动',
  },
} as const;
