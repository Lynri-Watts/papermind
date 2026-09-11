import React from 'react';
import { useTranslation } from 'react-i18next';
import { SearchSourceStatus } from '../types';

/** 论文数据源元信息：展示名 + 主题色（搜索结果来源标注、来源筛选共用一处定义） */
export const PROVIDER_META: Record<string, { label: string; color: string }> = {
  semantic_scholar: { label: 'Semantic Scholar', color: '#38BDF8' },
  arxiv: { label: 'arXiv', color: '#FB7185' },
  openalex: { label: 'OpenAlex', color: '#A78BFA' },
  core: { label: 'CORE', color: '#34D399' },
};

/** 「全部来源」筛选项的 i18n 键（命名空间 source）；调用方渲染该项文案时应使用 t('source:all') */
export const allOptionLabelKey = 'all';

/** 来源筛选下拉选项：'all'=全部数据源并发合并，其余为单一来源。
 * 这是"已知数据源"的静态目录（离线兜底）；在线时应以 store.settings 中
 * 的"已启用数据源"为准（见 Explore），避免选到已被停用的源。
 * 'all' 项的展示文案由调用方用 t('source:all') 渲染，故这里 label 留空，
 * 静态目录中不内嵌任何界面文案。 */
export const SOURCE_OPTIONS = [
  { value: 'all', label: '' },
  { value: 'semantic_scholar', label: 'Semantic Scholar' },
  { value: 'arxiv', label: 'arXiv' },
  { value: 'openalex', label: 'OpenAlex' },
  { value: 'core', label: 'CORE' },
];

/** 数据源徽标：标注某篇论文来自哪个数据源 */
export const SourceBadge: React.FC<{ provider: string; className?: string }> = ({ provider, className = '' }) => {
  const { t } = useTranslation('source');
  const meta = PROVIDER_META[provider];
  if (!meta) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[11px] font-medium ${className}`}
      style={{ color: meta.color, backgroundColor: `${meta.color}1A` }}
      title={t('badge.title', { source: meta.label })}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: meta.color }} />
      {meta.label}
    </span>
  );
};

/** 数据源命中状态徽标：ok=命中条数 / empty=无匹配 / error=失败（悬停查看原因） */
export const SourceStatusBadge: React.FC<{ status: SearchSourceStatus }> = ({ status }) => {
  const { t } = useTranslation(['source', 'common']);
  const meta = PROVIDER_META[status.source];
  const label = meta?.label ?? status.source;
  if (status.status === 'ok') {
    const color = meta?.color ?? '#94A3B8';
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px]"
        style={{ color, backgroundColor: `${color}1A` }}
        title={t('status.okTitle', { source: label, count: status.count })}
      >
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
        {label} {status.count}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-background border border-border text-textSecondary"
      title={status.error ? t('status.errorTitle', { source: label, error: status.error }) : t('status.emptyTitle', { source: label })}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-textSecondary/50" />
      {label} {status.status === 'error' ? t('common:status.failed') : t('status.empty')}
    </span>
  );
};