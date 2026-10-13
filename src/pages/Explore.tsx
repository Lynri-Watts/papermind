import React, { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, BookOpen, ChevronRight, RotateCcw,
  Loader2, Plus, Check, X, SlidersHorizontal, ChevronDown, Users,
  Quote, FileText, Globe, ExternalLink, Filter,
} from 'lucide-react';
import { searchPapersStructured, createPaperContext, getPdfUrl, getPaperById } from '../api';
import { Paper, SearchSourceStatus } from '../types';
import {
  usePaperMindStore, SearchFilters,
  EXPLORE_SEARCH_DEFAULT_WIDTH, EXPLORE_SEARCH_MIN_WIDTH, EXPLORE_SEARCH_MAX_WIDTH,
} from '../store';
import ResizableDivider from '../components/ResizableDivider';
import { PROVIDER_META, SOURCE_OPTIONS, SourceBadge, SourceStatusBadge } from '../components/SourceBadge';
import AddToMindmapButton from '../components/mindmap/AddToMindmapButton';
import MindmapGallerySidebar from '../components/mindmap/MindmapGallerySidebar';
import { useMindmapScope } from '../components/mindmap/useMindmapScope';

// 中栏导图含 React Flow，懒加载避免拖慢 Explore 首屏
const MindmapWorkArea = lazy(() => import('../components/mindmap/MindmapWorkArea'));

const PAGE_SIZE = 12;
const MAX_LIMIT = 50;
/** 右栏详情区默认/极限高度（与上方搜索区上下分栏，可横向拖拽条调整） */
const DETAIL_DEFAULT_H = 380;
const DETAIL_MIN_H = 220;
const DETAIL_MAX_H = 640;

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
  const createMindmap = usePaperMindStore((s) => s.createMindmap);

  const searchRef = useRef<HTMLInputElement>(null);

  // 结构化搜索 UI 态
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resultLimit, setResultLimit] = useState(PAGE_SIZE);
  /** 最近一次检索中各数据源的命中状态（多源聚合时展示"哪个源没返回、为什么"） */
  const [sourceStatus, setSourceStatus] = useState<SearchSourceStatus[]>([]);
  const [ctxAddingId, setCtxAddingId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ show: boolean; message: string; type: 'success' | 'error' } | null>(null);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 导图索引作用域：跟随当前工作区，可切到全局（与全屏图库页一致）
  const [scopeWs, setScopeWs] = useState<string | null>(activeWorkspaceId ?? null);
  useEffect(() => {
    setScopeWs(activeWorkspaceId ?? null);
  }, [activeWorkspaceId]);
  const scope = useMindmapScope(scopeWs);

  /** 详情区高度（搜索区占满剩余高度） */
  const [detailH, setDetailH] = useState(DETAIL_DEFAULT_H);
  /** 导图节点点击 → 拉取论文元数据中（节点只带 paperId） */
  const [paperLoading, setPaperLoading] = useState(false);

  // 「加入导图」自动建图/中栏快速建图的默认标题：检索词 → 工作区名 → 兜底
  const defaultMapTitle = useMemo(() => {
    const q = searchQuery.trim();
    if (q) return q.length > 40 ? `${q.slice(0, 40)}…` : q;
    const ws = usePaperMindStore.getState().workspaces
      .find((w) => w.id === usePaperMindStore.getState().activeWorkspaceId);
    return ws ? ws.name : t('mindmap:gallery.newMapTitle');
  }, [searchQuery, t]);

  // ---------- 结构化搜索（右栏上半区） ----------
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
        const tt = v.trim();
        if (!tt) return null;
        const n = Number(tt);
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

  // ---------- 导图 ----------
  /** 中栏空态快速建图（检索词/工作区名为默认标题） */
  const handleQuickCreate = useCallback(() => {
    void createMindmap({ workspaceId: scopeWs, title: defaultMapTitle, rootText: defaultMapTitle });
  }, [createMindmap, scopeWs, defaultMapTitle]);

  /**
   * 导图 paper 节点单击：打开与搜索一致的论文详情（右栏下半区）。
   * 节点只携带 paperId，先在本轮检索结果里找，找不到再请求后端元数据。
   */
  const handleOpenPaperFromMap = useCallback(async (paperId: string) => {
    // 右栏处于折叠窄条时，详情在栏内不可见——先展开再呈现
    if (usePaperMindStore.getState().exploreSearchCollapsed) {
      setExploreSearchCollapsed(false);
    }
    const hit = searchResults.find((p) => p.id === paperId);
    if (hit) {
      setSelectedPaper(hit);
      return;
    }
    setPaperLoading(true);
    try {
      const paper = await getPaperById(paperId);
      if (paper) {
        setSelectedPaper(paper);
      } else {
        showNotification(t('detail.fetchFailed'), 'error');
      }
    } catch (err) {
      showNotification(err instanceof Error ? err.message : t('detail.fetchFailed'), 'error');
    } finally {
      setPaperLoading(false);
    }
  }, [searchResults, setSelectedPaper, setExploreSearchCollapsed, t]);

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
      <div className="relative flex h-full bg-background">
        {/* 左栏：思维导图索引（作用域切换/建图/列表，与全屏图库页共用组件） */}
        <MindmapGallerySidebar
          className="w-60"
          scopeWs={scopeWs}
          onScopeChange={setScopeWs}
          metas={scope.metas}
          activeId={scope.activeId}
          loadError={scope.error}
          onReload={() => void scope.reload()}
          onCreate={handleQuickCreate}
        />

        {/* 中栏：思维导图工作区（常驻；React Flow 懒加载） */}
        <main className="min-w-0 flex-1">
          <Suspense fallback={
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-textSecondary" size={20} />
            </div>
          }>
            <MindmapWorkArea
              scopeWs={scopeWs}
              scope={scope}
              defaultMapTitle={defaultMapTitle}
              onOpenPaper={(pid) => void handleOpenPaperFromMap(pid)}
              onOpenGallery={() => setCurrentView('mindmaps')}
            />
          </Suspense>
        </main>

        {/* 右栏分隔条（面板贴右缘：向右拖变窄；宽度持久化，双击恢复默认） */}
        <ResizableDivider
          placement="right"
          size={exploreSearchWidth}
          min={EXPLORE_SEARCH_MIN_WIDTH}
          max={EXPLORE_SEARCH_MAX_WIDTH}
          onResize={setExploreSearchWidth}
          onDoubleClickReset={() => setExploreSearchWidth(EXPLORE_SEARCH_DEFAULT_WIDTH)}
        />

        {/* 右栏：搜索（上）+ 论文详情（下）。可折叠为窄条 */}
        {exploreSearchCollapsed ? (
          <div className="flex w-10 flex-shrink-0 flex-col items-center gap-2 border-l border-border bg-surface py-3">
            <button
              onClick={() => setExploreSearchCollapsed(false)}
              className="rounded-lg p-2 text-textSecondary transition-colors hover:bg-primary/20 hover:text-primary"
              title={t('search.expand')}
            >
              <Search className="h-5 w-5" />
            </button>
          </div>
        ) : (
          <aside
            style={{ width: exploreSearchWidth }}
            className="flex flex-shrink-0 flex-col overflow-hidden border-l border-border bg-surface"
          >
            {/* ---- 上：搜索条件 + 结果列表（占满详情区之外的剩余高度） ---- */}
            <section className="flex min-h-0 flex-1 flex-col">
              <div className="border-b border-border p-3">
                <div className="mb-2.5 flex items-center gap-2">
                  <Search className="h-4 w-4 text-textSecondary" />
                  <span className="text-sm font-semibold text-text">{t('search.title')}</span>
                  <button
                    onClick={() => setExploreSearchCollapsed(true)}
                    className="ml-auto rounded-lg p-1.5 text-textSecondary transition-colors hover:bg-primary/20 hover:text-text"
                    title={t('search.collapse')}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-textSecondary" />
                  <input
                    ref={searchRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') performSearch();
                    }}
                    placeholder={t('search.inputPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background py-1.5 pl-9 pr-3 text-sm text-text placeholder-textSecondary focus:border-primary focus:outline-none"
                  />
                </div>
                {/* 来源筛选：限定检索数据源（缺省全部来源并发合并；选单一来源则只查该源） */}
                <div className="mt-2 flex items-center gap-2">
                  <label className="flex flex-shrink-0 items-center gap-1.5 text-xs text-textSecondary">
                    <Filter className="h-3.5 w-3.5" />
                    {t('search.sourceLabel')}
                  </label>
                  <select
                    value={searchFilters.source}
                    onChange={(e) => updateFilter('source', e.target.value)}
                    className="min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 py-1 text-xs text-text transition-colors focus:border-primary focus:outline-none"
                    title={t('search.sourceHint')}
                  >
                    {sourceOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                {/* 统一触发区：搜索按钮同时适用于主搜索框与筛选条件；不再有第二套"普通/高级"触发逻辑 */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => performSearch()}
                    disabled={searchLoading}
                    className="flex min-w-[72px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {searchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                    {t('common:action.search')}
                  </button>
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      showAdvanced || activeFilterCount > 0
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border bg-background text-textSecondary hover:border-primary hover:text-text'
                    }`}
                    title={t('search.filterHint')}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    {t('search.filter')}
                    {activeFilterCount > 0 && (
                      <span className="rounded bg-primary px-1 text-[10px] leading-4 text-white">{activeFilterCount}</span>
                    )}
                    <ChevronDown className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                  </button>
                  <button
                    onClick={handleClear}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-textSecondary transition-colors hover:border-primary/40 hover:text-text"
                    title={t('search.clearHint')}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('common:action.clear')}
                  </button>
                </div>

                {/* 筛选条件面板（字段化限定；提交统一走上方的「搜索」按钮或主搜索框回车） */}
                {showAdvanced && (
                  <div className="mt-2.5 space-y-2">
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

              <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2.5">
                {searchLoading && searchResults.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-textSecondary">
                    <Loader2 className="mb-2 h-6 w-6 animate-spin" />
                    <p className="text-xs">{t('results.searching')}</p>
                  </div>
                )}

                {!searchLoading && searchResults.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-textSecondary">
                    <Search className="mb-2 h-6 w-6 opacity-50" />
                    <p className="px-4 text-center text-xs">
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
                      className={`cursor-pointer rounded-lg border p-2.5 transition-all ${
                        active
                          ? 'border-primary/50 bg-primary/10'
                          : 'border-transparent bg-background hover:border-border'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="line-clamp-2 flex-1 text-sm font-medium text-text">{paper.title}</h3>
                        <div className="mt-0.5 flex flex-shrink-0 items-center gap-1">
                          {inContext ? (
                            <span className="p-1 text-accent" title={t('context.added')}>
                              <Check className="h-4 w-4" />
                            </span>
                          ) : (
                            <button
                              onClick={(e) => handleAddToContext(paper, e)}
                              disabled={ctxAddingId === paper.id}
                              className="rounded-lg p-1 text-textSecondary transition-colors hover:bg-accent/20 hover:text-accent disabled:opacity-40"
                              title={t('context.add')}
                            >
                              {ctxAddingId === paper.id
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Plus className="h-4 w-4" />}
                            </button>
                          )}
                          <AddToMindmapButton
                            paperId={paper.id}
                            paperTitle={paper.title}
                            defaultMapTitle={defaultMapTitle}
                            className="p-1 rounded-lg transition-colors hover:bg-indigo-100 disabled:opacity-40"
                            onResult={(r) => showNotification(r.message, r.kind === 'error' ? 'error' : 'success')}
                          />
                          <ChevronRight className={`h-4 w-4 transition-colors ${active ? 'text-primary' : 'text-textSecondary'}`} />
                        </div>
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-textSecondary">
                        <Users className="mr-1 inline h-3 w-3" />
                        {paper.authors.slice(0, 3).join(', ')}
                        {paper.authors.length > 3 ? ' et al.' : ''}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <SourceBadge provider={paper.source} />
                        {paper.publication_venue && (
                          <span className="rounded bg-secondary/10 px-1.5 py-0.5 text-xs text-secondary">
                            {paper.publication_venue}
                          </span>
                        )}
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
                          {paper.year || '—'}
                        </span>
                        {paper.citation_count != null && (
                          <span className="flex items-center gap-0.5 text-[11px] text-textSecondary">
                            <Quote className="h-3 w-3" />
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
                      className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-4 py-2 text-xs font-medium text-textSecondary transition-colors hover:border-primary/40 hover:text-text disabled:opacity-50"
                    >
                      {searchLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
                      {t('results.loadMore')}
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-1.5 border-t border-border p-2.5">
                <div className="flex items-center justify-between text-xs text-textSecondary">
                  <span className="flex items-center gap-1.5">
                    {searchLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <span>{t('results.count', { count: searchResults.length })}</span>
                    )}
                  </span>
                  {providerLabel && (
                    <span className="flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-accent">
                      <Globe className="h-3 w-3" />
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
            </section>

            {/* ---- 下：论文详情（导图节点单击 / 结果卡单击共用；可拖拽调高） ---- */}
            {selectedPaper && (
              <>
                <ResizableDivider
                  placement="bottom"
                  size={detailH}
                  min={DETAIL_MIN_H}
                  max={DETAIL_MAX_H}
                  onResize={setDetailH}
                  onDoubleClickReset={() => setDetailH(DETAIL_DEFAULT_H)}
                />
                <section
                  style={{ height: detailH }}
                  className="flex flex-shrink-0 flex-col overflow-hidden border-t border-border bg-surface"
                >
                  <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <BookOpen className="h-4 w-4 shrink-0 text-primary" />
                      <span className="truncate text-sm font-semibold text-text">{t('detail.title')}</span>
                      {paperLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-textSecondary" />}
                    </div>
                    <button
                      onClick={() => setSelectedPaper(null)}
                      className="rounded-lg p-1.5 text-textSecondary transition-colors hover:bg-primary/20 hover:text-text"
                      title={t('detail.close')}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-3">
                    <h3 className="mb-1.5 text-sm font-medium text-text">{selectedPaper.title}</h3>
                    <p className="mb-2 text-xs text-textSecondary">{selectedPaper.authors.join(', ')}</p>
                    {selectedPaper.source && PROVIDER_META[selectedPaper.source] && (
                      <div className="mb-2.5">
                        <SourceBadge provider={selectedPaper.source} />
                      </div>
                    )}

                    <div className="mb-2.5 space-y-1.5">
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
                      <h4 className="mb-1 text-xs font-medium text-text">{t('detail.abstract')}</h4>
                      <p className="text-xs leading-5 text-textSecondary/80">{selectedPaper.abstract || t('detail.noAbstract')}</p>
                    </div>

                    <div className="space-y-2">
                      <button
                        onClick={() => handleReadPaper(selectedPaper)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/80"
                      >
                        <BookOpen className="h-4 w-4" />
                        {t('detail.openInReader')}
                      </button>
                      <div className="grid grid-cols-2 gap-2">
                        {selectedPaper.pdf_url && (
                          <a
                            href={getPdfUrl(selectedPaper.id)}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center justify-center gap-1.5 rounded-lg bg-secondary/20 px-3 py-2 text-sm font-medium text-secondary transition-colors hover:bg-secondary/30"
                          >
                            <FileText className="h-4 w-4" />
                            PDF
                          </a>
                        )}
                        {selectedPaper.url && (
                          <a
                            href={selectedPaper.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-textSecondary transition-colors hover:border-primary/40 hover:text-text"
                          >
                            <ExternalLink className="h-4 w-4" />
                            {t('detail.sourceLink')}
                          </a>
                        )}
                      </div>
                      {isPaperInContext(selectedPaper.id) ? (
                        <button
                          disabled
                          className="flex w-full cursor-default items-center justify-center gap-2 rounded-lg bg-accent/10 px-3 py-2 text-sm font-medium text-accent"
                          title={t('context.alreadyInContext')}
                        >
                          <Check className="h-4 w-4" />
                          {t('context.addedAction')}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleAddToContext(selectedPaper)}
                          disabled={ctxAddingId === selectedPaper.id}
                          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent/20 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/30 disabled:opacity-50"
                        >
                          {ctxAddingId === selectedPaper.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Plus className="h-4 w-4" />}
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
                </section>
              </>
            )}
          </aside>
        )}
      </div>

      {notification?.show && (
        <div
          className={`fixed right-4 top-4 z-50 rounded-xl border px-4 py-3 shadow-lg transition-all duration-300 ${
            notification.type === 'success'
              ? 'border-green-500/30 bg-green-500/10 text-green-400'
              : 'border-red-500/30 bg-red-500/10 text-red-400'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <Check className="h-4 w-4" />
            ) : (
              <X className="h-4 w-4" />
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
    <span className="mb-1 block text-[11px] font-medium text-textSecondary">{label}</span>
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-text placeholder-textSecondary transition-colors focus:border-primary focus:outline-none"
    />
  </label>
);

/** 详情面板键值行 */
const DetailRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-3 text-xs">
    <span className="flex-shrink-0 text-textSecondary">{label}</span>
    <span className="break-all text-right font-medium text-text">{value}</span>
  </div>
);

export default Explore;
