import React, { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, BookOpen, ChevronLeft, ChevronRight, RotateCcw,
  Loader2, Plus, Check, X, SlidersHorizontal, ChevronDown, Users,
  Quote, FileText, Globe, ExternalLink, Filter, ListTree,
} from 'lucide-react';
import { searchPapersStructured, createPaperContext, getPdfUrl } from '../api';
import { Paper, SearchSourceStatus } from '../types';
import { usePaperMindStore, SearchFilters } from '../store';
import ResizableDivider from '../components/ResizableDivider';
import { PROVIDER_META, SOURCE_OPTIONS, SourceBadge, SourceStatusBadge } from '../components/SourceBadge';
import AddToMindmapButton from '../components/mindmap/AddToMindmapButton';

// 思维导图浮层含 React Flow，懒加载避免拖慢 Explore 首屏
const MindmapDock = lazy(() => import('../components/mindmap/MindmapDock'));

const PAGE_SIZE = 12;
const MAX_LIMIT = 50;

const Explore: React.FC = () => {
  const { t } = useTranslation(['explore', 'common']);
  const {
    setCurrentView,
    activeWorkspaceId,
    searchQuery, setSearchQuery,
    searchResults, setSearchResults,
    searchProvider, setSearchProvider,
    searchFilters, setSearchFilters,
    exploreAutoSearched, markExploreAutoSearched,
    selectedPaper, setSelectedPaper,
    openReaderTab,
    exploreSearchWidth, setExploreSearchWidth,
    exploreSearchCollapsed, setExploreSearchCollapsed,
    settings, refreshSettings,
  } = usePaperMindStore();
  const addContextItem = usePaperMindStore((s) => s.addContextItem);
  const contextItems = usePaperMindStore((s) => s.contextItems);

  const searchRef = useRef<HTMLInputElement>(null);

  // 结构化搜索 UI 态
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resultLimit, setResultLimit] = useState(PAGE_SIZE);
  /** 最近一次检索中各数据源的命中状态（多源聚合时展示"哪个源没返回、为什么"） */
  const [sourceStatus, setSourceStatus] = useState<SearchSourceStatus[]>([]);
  const [ctxAddingId, setCtxAddingId] = useState<string | null>(null);
  /** 思维导图浮层开关：导图是辅助工具，按需呼出、不常驻占栏 */
  const [mindmapOpen, setMindmapOpen] = useState(false);
  const [notification, setNotification] = useState<{ show: boolean; message: string; type: 'success' | 'error' } | null>(null);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 「加入导图」自动建图的默认标题：检索词 → 工作区名 → 兜底
  const defaultMapTitle = useMemo(() => {
    const q = searchQuery.trim();
    if (q) return q.length > 40 ? `${q.slice(0, 40)}…` : q;
    const ws = usePaperMindStore.getState().workspaces
      .find((w) => w.id === usePaperMindStore.getState().activeWorkspaceId);
    return ws ? ws.name : t('mindmap:gallery.newMapTitle');
  }, [searchQuery, t]);

  // ---------- 结构化搜索（合并原 SearchPage 逻辑，作为 Explore 左栏） ----------
  /** 是否启用了任一高级筛选字段（任一非空即走后端字段化检索） */
  const hasStructured = useCallback((filters: SearchFilters = searchFilters) => {
    return Boolean(
      filters.title.trim() || filters.author.trim()
      || filters.abstract.trim() || filters.fulltext.trim()
      || filters.yearFrom.trim() || filters.yearTo.trim()
    );
  }, [searchFilters]);

  /** 高级筛选已填写字段数（用于折叠按钮上的角标） */
  const activeFilterCount = [
    searchFilters.title, searchFilters.author, searchFilters.abstract,
    searchFilters.fulltext, searchFilters.yearFrom, searchFilters.yearTo,
  ].filter((v) => v.trim()).length;

  /** 执行检索：由「搜索」按钮或输入框回车显式触发（不做输入防抖自动搜索）。
   * 主搜索框内容始终作为 ``keywords`` 字段提交，高级字段作为附加限定，二者不会互相覆盖。 */
  const performSearch = useCallback(async (limit = PAGE_SIZE) => {
    const keywords = searchQuery.trim();
    const filters = searchFilters;
    const structured = hasStructured(filters);
    if (!keywords && !structured) {
      setSearchError(t('error.emptyQuery'));
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const parseYear = (v: string): number | null => {
        const t = v.trim();
        if (!t) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      };
      const response = await searchPapersStructured(
        {
          keywords: keywords || undefined,
          title: filters.title.trim() || undefined,
          author: filters.author.trim() || undefined,
          abstract: filters.abstract.trim() || undefined,
          fulltext: filters.fulltext.trim() || undefined,
          yearFrom: parseYear(filters.yearFrom),
          yearTo: parseYear(filters.yearTo),
          sources: filters.source && filters.source !== 'all' ? [filters.source] : undefined,
        },
        limit
      );
      setSearchResults(response.papers);
      setSearchProvider(response.provider ?? null);
      setSourceStatus(response.sources ?? []);
      setResultLimit(limit);
    } catch (e) {
      setSearchResults([]);
      setSearchProvider(null);
      setSourceStatus([]);
      setSearchError(e instanceof Error ? e.message : t('error.searchFailed'));
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery, searchFilters, hasStructured, setSearchResults, setSearchProvider, t]);

  // 首次进入：恢复上次持久化的搜索条件并自动搜索一次（此后一律显式触发）。
  // 闸门必须是「执行时实时读取」的 store 值，不能读渲染闭包里的值：
  // main.tsx 的 StrictMode 会把挂载副作用执行两次（setup→cleanup→setup），
  // 两次用的都是同一份闭包，闭包里的闸门值恒为初始值，两次都会放行。
  // 组件内 useRef 同理（ref 会被重建/丢弃）。改为 getState() 实时读取即可去重。
  useEffect(() => {
    if (usePaperMindStore.getState().exploreAutoSearched) return;
    if (!searchQuery.trim() && !hasStructured()) return;
    usePaperMindStore.getState().markExploreAutoSearched();
    performSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateFilter = (key: keyof SearchFilters, value: string) => {
    setSearchFilters({ ...searchFilters, [key]: value });
  };

  const handleClear = () => {
    setSearchQuery('');
    setSearchFilters({
      title: '', author: '', abstract: '', fulltext: '', yearFrom: '', yearTo: '', source: 'all',
    });
    setSearchResults([]);
    setSearchProvider(null);
    setSourceStatus([]);
    setSearchError(null);
    setResultLimit(PAGE_SIZE);
  };

  const handleLoadMore = () => {
    const next = Math.min(MAX_LIMIT, resultLimit + PAGE_SIZE);
    performSearch(next);
  };

  // ---------- 论文操作 ----------
  const handleSelectPaper = (paper: Paper) => {
    setSelectedPaper(paper);
  };

  const handleReadPaper = (paper: Paper) => {
    openReaderTab(paper.id, paper.title);
    setCurrentView('research');
  };

  const isPaperInContext = useCallback((paperId: string) =>
    contextItems.some((c) => c.paperId === paperId), [contextItems]);

  const showNotification = (message: string, type: 'success' | 'error') => {
    if (notificationTimer.current) clearTimeout(notificationTimer.current);
    setNotification({ show: true, message, type });
    notificationTimer.current = setTimeout(() => setNotification(null), 2500);
  };

  const handleAddToContext = async (paper: Paper, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (ctxAddingId) return;
    setCtxAddingId(paper.id);
    try {
      // 上下文库按工作区隔离：归属当前活跃工作区
      const item = await createPaperContext(paper.id, undefined,
        usePaperMindStore.getState().activeWorkspaceId ?? undefined);
      addContextItem(item);
      showNotification(t('notification.contextAdded'), 'success');
    } catch (err) {
      showNotification(err instanceof Error ? err.message : t('notification.contextAddFailed'), 'error');
    } finally {
      setCtxAddingId(null);
    }
  };

  const providerLabel = searchProvider
    ? (searchProvider === 'all' ? t('sourceFilter.all') : (PROVIDER_META[searchProvider]?.label ?? searchProvider))
    : null;
  const activeSource = searchFilters.source; // 'all' 或单个数据源 id

  /** 来源下拉选项：以 store.settings 中"已启用数据源"为准（按聚合优先级排序），
   * 避免选到已在「设置」页停用的源（后端会明确拒绝）；设置未加载时退回静态目录。 */
  const sourceOptions = useMemo(() => {
    const enabled = (settings?.sources ?? []).filter((s) => s.enabled);
    const allOption = { value: 'all', label: t('sourceFilter.all') };
    if (enabled.length === 0) {
      return [allOption, ...SOURCE_OPTIONS.filter((o) => o.value !== 'all')];
    }
    return [
      allOption,
      ...enabled.map((s) => ({ value: s.id, label: s.label })),
    ];
  }, [settings, t]);

  // 设置快照未就绪时主动拉取（Explore 依赖它渲染"已启用数据源"）
  useEffect(() => {
    if (!settings) void refreshSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 设置变化后：若当前选定来源已被停用，回退到「全部来源」（否则后端会拒绝该请求）
  useEffect(() => {
    if (!settings) return;
    const enabledIds = settings.sources.filter((s) => s.enabled).map((s) => s.id);
    if (activeSource !== 'all' && !enabledIds.includes(activeSource)) {
      setSearchFilters({ ...searchFilters, source: 'all' });
    }
  }, [settings, activeSource, searchFilters, setSearchFilters]);

  return (
    <>
      <div className="relative h-full flex">
        {/* 左栏：结构化搜索（原 SearchPage 合并至此）。可拖宽、可折叠为窄条 */}
        {exploreSearchCollapsed ? (
          <div className="w-10 flex-shrink-0 border-r border-border bg-surface flex flex-col items-center py-3 gap-2">
            <button
              onClick={() => setExploreSearchCollapsed(false)}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('search.expand')}
            >
              <Search className="w-5 h-5" />
            </button>
            <button
              onClick={() => setMindmapOpen(true)}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('mindmap:dock.title')}
            >
              <ListTree className="w-5 h-5" />
            </button>
          </div>
        ) : (
        <div style={{ width: exploreSearchWidth }} className="flex-shrink-0 border-r border-border bg-surface flex flex-col overflow-hidden">
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2 mb-3">
              <Search className="w-5 h-5 text-textSecondary" />
              <span className="font-semibold text-text">{t('search.title')}</span>
              <button
                onClick={() => setMindmapOpen(true)}
                className="ml-auto p-1.5 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
                title={t('mindmap:dock.title')}
                aria-label={t('mindmap:dock.title')}
              >
                <ListTree className="w-4 h-4" />
              </button>
              <button
                onClick={() => setExploreSearchCollapsed(true)}
                className="p-1.5 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-text transition-colors"
                title={t('search.collapse')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') performSearch();
                }}
                placeholder={t('search.inputPlaceholder')}
                className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg text-text placeholder-textSecondary focus:outline-none focus:border-primary text-sm"
              />
            </div>
            {/* 来源筛选：限定检索数据源（缺省全部来源并发合并；选单一来源则只查该源） */}
            <div className="flex items-center gap-2 mt-2">
              <label className="flex items-center gap-1.5 text-xs text-textSecondary flex-shrink-0">
                <Filter className="w-3.5 h-3.5" />
                {t('search.sourceLabel')}
              </label>
              <select
                value={searchFilters.source}
                onChange={(e) => updateFilter('source', e.target.value)}
                className="flex-1 min-w-0 px-2 py-1.5 bg-background border border-border rounded-lg text-xs text-text focus:outline-none focus:border-primary cursor-pointer transition-colors"
                title={t('search.sourceHint')}
              >
                {sourceOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            {/* 统一触发区：搜索按钮同时适用于主搜索框与筛选条件；不再有第二套"普通/高级"触发逻辑 */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <button
                onClick={() => performSearch()}
                disabled={searchLoading}
                className="flex-1 min-w-[72px] flex items-center justify-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
              >
                {searchLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                {t('common:action.search')}
              </button>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors text-xs ${
                  showAdvanced || activeFilterCount > 0
                    ? 'bg-primary/10 border-primary/40 text-primary'
                    : 'bg-background border-border text-textSecondary hover:text-text hover:border-primary'
                }`}
                title={t('search.filterHint')}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                {t('search.filter')}
                {activeFilterCount > 0 && (
                  <span className="px-1 rounded bg-primary text-white text-[10px] leading-4">{activeFilterCount}</span>
                )}
                <ChevronDown className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              </button>
              <button
                onClick={handleClear}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border hover:border-primary/40 text-textSecondary hover:text-text text-xs font-medium rounded-lg transition-colors"
                title={t('search.clearHint')}
              >
                <RotateCcw className="w-3 h-3" />
                {t('common:action.clear')}
              </button>
            </div>

            {/* 筛选条件面板（字段化限定；提交统一走上方的「搜索」按钮或主搜索框回车） */}
            {showAdvanced && (
              <div className="mt-3 space-y-2.5">
                <FieldInput
                  label={t('fields.title')}
                  placeholder={t('fields.titlePlaceholder')}
                  value={searchFilters.title}
                  onChange={(v) => updateFilter('title', v)}
                />
                <FieldInput
                  label={t('fields.author')}
                  placeholder={t('fields.authorPlaceholder')}
                  value={searchFilters.author}
                  onChange={(v) => updateFilter('author', v)}
                />
                <FieldInput
                  label={t('fields.abstract')}
                  placeholder={t('fields.abstractPlaceholder')}
                  value={searchFilters.abstract}
                  onChange={(v) => updateFilter('abstract', v)}
                />
                <FieldInput
                  label={t('fields.fulltext')}
                  placeholder={t('fields.fulltextPlaceholder')}
                  value={searchFilters.fulltext}
                  onChange={(v) => updateFilter('fulltext', v)}
                />
                <div className="grid grid-cols-2 gap-2">
                  <FieldInput
                    label={t('fields.yearFrom')}
                    placeholder="2020"
                    value={searchFilters.yearFrom}
                    onChange={(v) => updateFilter('yearFrom', v)}
                  />
                  <FieldInput
                    label={t('fields.yearTo')}
                    placeholder="2024"
                    value={searchFilters.yearTo}
                    onChange={(v) => updateFilter('yearTo', v)}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-2">
            {searchLoading && searchResults.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-textSecondary">
                <Loader2 className="w-6 h-6 animate-spin mb-2" />
                <p className="text-xs">{t('results.searching')}</p>
              </div>
            )}

            {!searchLoading && searchResults.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-textSecondary">
                <Search className="w-6 h-6 mb-2 opacity-50" />
                <p className="text-xs text-center px-4">
                  {searchError ?? (
                    activeSource !== 'all'
                      ? t('results.emptySource', { source: PROVIDER_META[activeSource]?.label ?? activeSource })
                      : t('results.empty')
                  )}
                </p>
              </div>
            )}

            {searchResults.map((paper) => {
              const inContext = isPaperInContext(paper.id);
              const active = selectedPaper?.id === paper.id;
              return (
                <div
                  key={paper.id}
                  onClick={() => handleSelectPaper(paper)}
                  className={`p-3 rounded-lg cursor-pointer transition-all border ${
                    active
                      ? 'bg-primary/10 border-primary/50'
                      : 'bg-background border-transparent hover:border-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium text-text line-clamp-2 flex-1">{paper.title}</h3>
                    <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                      {inContext ? (
                        <span className="p-1 text-accent" title={t('context.added')}>
                          <Check className="w-4 h-4" />
                        </span>
                      ) : (
                        <button
                          onClick={(e) => handleAddToContext(paper, e)}
                          disabled={ctxAddingId === paper.id}
                          className="p-1 rounded-lg hover:bg-accent/20 text-textSecondary hover:text-accent transition-colors disabled:opacity-40"
                          title={t('context.add')}
                        >
                          {ctxAddingId === paper.id
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Plus className="w-4 h-4" />}
                        </button>
                      )}
                      <AddToMindmapButton
                        paperId={paper.id}
                        paperTitle={paper.title}
                        defaultMapTitle={defaultMapTitle}
                        className="p-1 rounded-lg transition-colors hover:bg-indigo-100 disabled:opacity-40"
                        onResult={(r) => showNotification(r.message, r.kind === 'error' ? 'error' : 'success')}
                      />
                      <ChevronRight className={`w-4 h-4 transition-colors ${active ? 'text-primary' : 'text-textSecondary'}`} />
                    </div>
                  </div>
                  <p className="text-xs text-textSecondary mt-1 line-clamp-1">
                    <Users className="w-3 h-3 inline mr-1" />
                    {paper.authors.slice(0, 3).join(', ')}
                    {paper.authors.length > 3 ? ' et al.' : ''}
                  </p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <SourceBadge provider={paper.source} />
                    {paper.publication_venue && (
                      <span className="px-1.5 py-0.5 bg-secondary/10 text-secondary text-xs rounded">
                        {paper.publication_venue}
                      </span>
                    )}
                    <span className="px-1.5 py-0.5 bg-accent/10 text-accent text-xs rounded">
                      {paper.year || '—'}
                    </span>
                    {paper.citation_count != null && (
                      <span className="flex items-center gap-0.5 text-[11px] text-textSecondary">
                        <Quote className="w-3 h-3" />
                        {paper.citation_count.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {searchResults.length > 0 && resultLimit < MAX_LIMIT && (
              <div className="flex justify-center pt-1">
                <button
                  onClick={handleLoadMore}
                  disabled={searchLoading}
                  className="flex items-center gap-1.5 px-4 py-2 bg-surface border border-border hover:border-primary/40 text-textSecondary hover:text-text text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {searchLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronDown className="w-3 h-3" />}
                  {t('results.loadMore')}
                </button>
              </div>
            )}
          </div>

          <div className="p-3 border-t border-border space-y-1.5">
            <div className="flex items-center justify-between text-xs text-textSecondary">
              <span className="flex items-center gap-1.5">
                {searchLoading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <span>{t('results.count', { count: searchResults.length })}</span>
                )}
              </span>
              {providerLabel && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 bg-accent/10 text-accent rounded">
                  <Globe className="w-3 h-3" />
                  {providerLabel}
                </span>
              )}
            </div>
            {/* 多源聚合时逐个来源展示命中/失败情况，避免"只见到某一个源"的困惑 */}
            {sourceStatus.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {sourceStatus.map((s) => <SourceStatusBadge key={s.source} status={s} />)}
              </div>
            )}
          </div>
        </div>
        )}
        {/* 可拖拽分隔条：调宽搜索栏（范围 240-560，持久化） */}
        <ResizableDivider onDelta={(dx) => setExploreSearchWidth(exploreSearchWidth + dx)} />

        {/* 右栏：论文详情（抽屉浮层，不占布局空间） */}
        {selectedPaper && (
          <div className="absolute top-0 right-0 bottom-0 w-96 flex-shrink-0 border-l border-border bg-surface flex flex-col overflow-hidden shadow-2xl z-10">
            {selectedPaper && (
              <>
                <div className="p-4 border-b border-border overflow-auto">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <BookOpen className="w-5 h-5 text-primary" />
                      <span className="font-semibold text-text">{t('detail.title')}</span>
                    </div>
                    <button
                      onClick={() => setSelectedPaper(null)}
                      className="p-1.5 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-text transition-colors"
                      title={t('detail.close')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <h3 className="text-sm font-medium text-text mb-2">{selectedPaper.title}</h3>
                  <p className="text-xs text-textSecondary mb-2">{selectedPaper.authors.join(', ')}</p>
                  {selectedPaper.source && PROVIDER_META[selectedPaper.source] && (
                    <div className="mb-3">
                      <SourceBadge provider={selectedPaper.source} />
                    </div>
                  )}

                  <div className="space-y-2 mb-3">
                    {selectedPaper.publication_venue && (
                      <DetailRow label={t('detail.venue')} value={selectedPaper.publication_venue} />
                    )}
                    <DetailRow label={t('detail.year')} value={selectedPaper.year ? String(selectedPaper.year) : '—'} />
                    {selectedPaper.citation_count != null && (
                      <DetailRow label={t('detail.citations')} value={selectedPaper.citation_count.toLocaleString()} />
                    )}
                    {selectedPaper.doi && <DetailRow label={t('detail.doi')} value={selectedPaper.doi} />}
                  </div>

                  <div className="mb-3">
                    <h4 className="text-xs font-medium text-text mb-1.5">{t('detail.abstract')}</h4>
                    <p className="text-xs text-textSecondary/80 line-clamp-6">{selectedPaper.abstract || t('detail.noAbstract')}</p>
                  </div>

                  <div className="space-y-2">
                    <button
                      onClick={() => handleReadPaper(selectedPaper)}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-primary hover:bg-primary/80 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      <BookOpen className="w-4 h-4" />
                      {t('detail.openInReader')}
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      {selectedPaper.pdf_url && (
                        <a
                          href={getPdfUrl(selectedPaper.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-center gap-1.5 px-3 py-2 bg-secondary/20 hover:bg-secondary/30 text-secondary text-sm font-medium rounded-lg transition-colors"
                        >
                          <FileText className="w-4 h-4" />
                          PDF
                        </a>
                      )}
                      {selectedPaper.url && (
                        <a
                          href={selectedPaper.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-center gap-1.5 px-3 py-2 bg-surface border border-border hover:border-primary/40 text-textSecondary hover:text-text text-sm font-medium rounded-lg transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                          {t('detail.sourceLink')}
                        </a>
                      )}
                    </div>
                    {isPaperInContext(selectedPaper.id) ? (
                      <button
                        disabled
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent/10 text-accent text-sm font-medium rounded-lg cursor-default"
                        title={t('context.alreadyInContext')}
                      >
                        <Check className="w-4 h-4" />
                        {t('context.addedAction')}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleAddToContext(selectedPaper)}
                        disabled={ctxAddingId === selectedPaper.id}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent/20 hover:bg-accent/30 text-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                      >
                        {ctxAddingId === selectedPaper.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Plus className="w-4 h-4" />}
                        {ctxAddingId === selectedPaper.id ? t('context.adding') : t('context.addAction')}
                      </button>
                    )}
                    <AddToMindmapButton
                      paperId={selectedPaper.id}
                      paperTitle={selectedPaper.title}
                      defaultMapTitle={defaultMapTitle}
                      withLabel
                      onResult={(r) => showNotification(r.message, r.kind === 'error' ? 'error' : 'success')}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 思维导图：按需浮层（懒加载 React Flow），不常驻占栏 */}
      {mindmapOpen && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <Loader2 className="animate-spin text-textSecondary" size={20} />
          </div>
        }>
          <MindmapDock
            open={mindmapOpen}
            onClose={() => setMindmapOpen(false)}
            scopeWs={activeWorkspaceId}
            defaultMapTitle={defaultMapTitle}
          />
        </Suspense>
      )}

      {notification?.show && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg border transition-all duration-300 ${
            notification.type === 'success'
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <Check className="w-4 h-4" />
            ) : (
              <X className="w-4 h-4" />
            )}
            <span className="text-sm font-medium">{notification.message}</span>
          </div>
        </div>
      )}
    </>
  );
};

/** 高级搜索字段输入框 */
const FieldInput: React.FC<{
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ label, placeholder, value, onChange }) => (
  <label className="block">
    <span className="text-[11px] font-medium text-textSecondary mb-1 block">{label}</span>
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text placeholder-textSecondary focus:outline-none focus:border-primary text-sm transition-colors"
    />
  </label>
);

/** 详情面板键值行 */
const DetailRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between text-sm gap-3">
    <span className="text-textSecondary flex-shrink-0">{label}</span>
    <span className="text-text font-medium text-right break-all">{value}</span>
  </div>
);

export default Explore;
