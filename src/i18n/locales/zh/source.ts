/** 数据源徽标（SourceBadge）文案 */
export default {
  /** 来源筛选「全部来源」选项：静态目录 SOURCE_OPTIONS 只带此键，文案由调用方渲染 */
  all: '全部来源',
  /** 数据源徽标（标注单篇论文来源） */
  badge: {
    /** 悬停提示（{{source}} 为数据源显示名，专有名词不翻译） */
    title: '数据源: {{source}}',
  },
  /** 多源聚合时的命中状态徽标 */
  status: {
    /** ok：悬停提示（{{count}} 为命中条数） */
    okTitle: '{{source}}：命中 {{count}} 条',
    /** empty：可见文案 */
    empty: '无匹配',
    /** empty：悬停提示 */
    emptyTitle: '{{source}}：无匹配结果',
    /** error：悬停提示（{{error}} 为后端返回的失败原因） */
    errorTitle: '{{source}}：{{error}}',
  },
} as const;