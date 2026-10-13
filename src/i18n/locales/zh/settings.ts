/** 设置页：界面语言、论文数据源与大模型服务配置文案 */
export default {
  title: '设置',
  subtitle: '管理论文数据源与大模型服务；凭据只保存在后端本地数据库中，保存后立即生效',
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

  /** AI 问答读取论文/上下文正文的粒度（开销 vs 证据完整性的取舍） */
  reading: {
    title: 'AI 读取粒度',
    description: '问答时 AI 读取论文正文的方式，在 token/耗时开销与证据完整性之间取舍。多次关键词检索取到的段落会自动合并去重，不会互相覆盖。',
    auto: {
      label: '自动',
      hint: '由模型按问题自行决定：简单问题用关键词定位，复杂问题直接读整篇',
    },
    full: {
      label: '完整优先',
      hint: '需要证据时一次读取整篇，证据最全、引用核对最稳；token 与耗时开销最高',
    },
    passages: {
      label: '节省优先',
      hint: '只按关键词取回命中段落，开销最低；证据分散在多个章节时可能需要多轮补读',
    },
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
    success: '已保存到后端本地数据库并立即生效（无需重启）',
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
