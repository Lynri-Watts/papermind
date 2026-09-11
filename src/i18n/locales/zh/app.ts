/** App 侧边栏与全局布局文案 */
export default {
  brand: {
    /** 品牌副标题：中英一致，作为产品标识不翻译 */
    tagline: 'AI Research Assistant',
  },
  nav: {
    home: '主页',
    homeDesc: '工作区管理',
    creation: '创作',
    creationDesc: 'LaTeX 写作与预览',
    maintenance: '维护中，敬请期待',
    research: '研究',
    researchDesc: '阅读 + RAG 问答',
    explore: '探索',
    exploreDesc: '检索 + 知识图谱',
    settings: '设置',
    settingsDesc: '数据源与大模型服务',
  },
  /** 入口置灰时的悬停提示 */
  navDisabledHint: '创作功能维护中，暂不可用',
  workspaceSwitcher: {
    noWorkspace: '未选择工作区',
    switchWorkspace: '切换工作区',
    createWorkspace: '去创建工作区',
  },
} as const;
