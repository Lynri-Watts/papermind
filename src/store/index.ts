import { create } from 'zustand';
import { Paper, ChatMessage, ChatConversation, Note, Highlight, AISuggestion, ContextItem, DataBlock, ReaderTab, WorkspaceInfo, SettingsSnapshot, MindmapMeta, MindmapInfo } from '../types';
import {
  loadState, saveState, listContextItems, listWorkspaces, readLatexFile, saveLatexFile, getSettings,
  generateChatTitle,
  listMindmaps as listMindmapsApi,
  createMindmap as createMindmapApi,
  importMindmap as importMindmapApi,
  getMindmap as getMindmapApi,
  renameMindmap as renameMindmapApi,
  deleteMindmapApi,
} from '../api';
import i18n from '../i18n';

/** 创作模块（原 Workspace / LaTeX 写作）是否对用户开放。
 * 注意：它与「工作区」不是同一概念——工作区是文献与文件的容器（见主页工作区管理），
 * 创作模块是其下的 LaTeX 写作与预览页面。
 * 发布前该功能存在缺陷，暂时下线：侧边栏入口保留但置灰「维护中」，
 * 主页「进入」与 AI 助手跳转均被拦回主页。恢复时把此处改回 true 即可。 */
export const WRITING_ENABLED: boolean = false;

/** 高级结构化搜索筛选条件（对应后端 /api/search 字段化检索；年份用字符串输入、提交时转数字）。
 * 主搜索框的关键词不在此处——它始终作为 ``keywords`` 字段提交，避免与高级字段重复/冲突。
 * ``source``：数据源筛选（'all'=全部数据源并发合并；其余为单个数据源 id）。 */
export interface SearchFilters {
  title: string;
  author: string;
  abstract: string;
  fulltext: string;
  yearFrom: string;
  yearTo: string;
  source: string;
}

const INITIAL_SEARCH_FILTERS: SearchFilters = {
  title: '',
  author: '',
  abstract: '',
  fulltext: '',
  yearFrom: '',
  yearTo: '',
  source: 'all',
};

// ---------- 问答会话（归档/重开/标题） ----------
/** 占位标题最大长度（超出截断加省略号）；AI 生成标题由后端限长 */
const CONV_PLACEHOLDER_MAX = 24;

// ---------- AI 面板宽度 ----------
/** AI 面板默认宽度（旧版默认 380；升级时把仍是旧默认值的快照迁移到新默认） */
const QA_PANEL_DEFAULT_WIDTH = 420;
const QA_PANEL_MIN_WIDTH = 300;
const QA_PANEL_MAX_WIDTH = 640;
/** 旧版默认宽度：快照中恰好等于该值视为"从未手动拖拽"，迁移到新默认 */
const QA_PANEL_LEGACY_DEFAULT_WIDTH = 380;
/**
 * 收敛宽度到合法区间。
 * @param migrateLegacyDefault 仅快照恢复时传 true：恰好等于旧默认 380 视为
 *        "从未手动拖拽"，迁移到新默认；拖拽 setter 不走迁移（允许精确停在 380）
 */
function clampQaPanelWidth(width: unknown, migrateLegacyDefault = false): number {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return QA_PANEL_DEFAULT_WIDTH;
  }
  if (migrateLegacyDefault && width === QA_PANEL_LEGACY_DEFAULT_WIDTH) {
    return QA_PANEL_DEFAULT_WIDTH;
  }
  return Math.max(QA_PANEL_MIN_WIDTH, Math.min(QA_PANEL_MAX_WIDTH, Math.round(width)));
}

/** 首条用户提问的本地占位标题（AI 标题返回前即时可见；失败时永久保留） */
function conversationPlaceholderTitle(firstQuestion: string): string {
  const q = firstQuestion.replace(/\s+/g, ' ').trim();
  return q.length > CONV_PLACEHOLDER_MAX ? `${q.slice(0, CONV_PLACEHOLDER_MAX)}…` : q;
}

/** 归一化持久化的聊天消息：过期实时态（toolCall/streaming）在重新加载时一律剥离 */
function normalizeChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return (raw as ChatMessage[]).map((m) => {
    const { toolCall: _toolCall, ...rest } = m;
    return {
      ...rest,
      streaming: false,
      toolLog: Array.isArray(m.toolLog) ? m.toolLog : undefined,
    } as ChatMessage;
  });
}

/** 归一化会话列表（旧快照/损坏条目容错）；不做消息迁移，迁移在 applyWsState */
function normalizeConversations(raw: unknown): ChatConversation[] {
  if (!Array.isArray(raw)) return [];
  const untitled = i18n.language?.startsWith('zh') ? '未命名会话' : 'Untitled chat';
  return (raw as Array<Record<string, unknown>>)
    .filter((c) => c && typeof c === 'object' && Array.isArray(c.messages))
    .map((c) => {
      const messages = normalizeChatMessages(c.messages);
      const createdAt = typeof c.createdAt === 'string' ? c.createdAt : '';
      const updatedAt = typeof c.updatedAt === 'string'
        ? c.updatedAt
        : (messages[messages.length - 1]?.timestamp ?? createdAt);
      return {
        id: typeof c.id === 'string' && c.id ? c.id : `c_${createdAt || Date.now()}`,
        title: typeof c.title === 'string' && c.title.trim() ? c.title : untitled,
        titlePending: c.titlePending === true,
        createdAt: createdAt || updatedAt || new Date(0).toISOString(),
        updatedAt: updatedAt || createdAt || new Date(0).toISOString(),
        messages,
      } satisfies ChatConversation;
    });
}

/** 异步请求 AI 标题并回写；任何失败（未配置 Key/网络/内容异常）都保留占位标题 */
function requestConversationTitle(conversationId: string, firstQuestion: string): void {
  void (async () => {
    try {
      const title = (await generateChatTitle(firstQuestion)).replace(/\s+/g, ' ').trim();
      usePaperMindStore.getState().setConversationTitle(conversationId, title || undefined);
    } catch (err) {
      console.warn('AI 会话标题生成失败，保留首问占位标题:', err);
      usePaperMindStore.getState().setConversationTitle(conversationId, undefined);
    }
  })();
}

interface PaperMindStore {
  selectedPaper: Paper | null;
  setSelectedPaper: (paper: Paper | null) => void;

  /** 阅读器打开的标签页列表（按打开顺序） */
  readerTabs: ReaderTab[];
  /** 当前激活的标签页（论文 id） */
  activeTabId: string | null;
  /** 打开或切换到某标签页；不存在则新建追加 */
  openReaderTab: (paperId: string, title: string) => void;
  /** 关闭某标签页；自动切换到相邻标签 */
  closeReaderTab: (paperId: string) => void;
  /** 记录某标签 PDF 自动探测结果（失败态随快照持久化，重启后不再自动重试） */
  setReaderTabPdfState: (paperId: string, failed: boolean, error?: string | null) => void;
  
  latexContent: string;
  setLatexContent: (content: string) => void;
  
  /** 当前视图中的聊天消息（活跃会话的消息视图；重开会话时整体替换） */
  chatMessages: ChatMessage[];
  addChatMessage: (message: ChatMessage) => void;
  updateChatMessage: (id: string, updates: Partial<ChatMessage>) => void;
  /** 已归档的历史会话列表（持久化，按 updatedAt 倒序展示） */
  chatConversations: ChatConversation[];
  /** 当前活跃会话 id；null = 尚未建档的新对话草稿 */
  activeConversationId: string | null;
  /** 归档当前会话并开始新对话（当前草稿若已随首问建档，自然留在历史列表） */
  newChat: () => void;
  /** 重新打开某历史会话：其消息载入当前视图，可继续追问（追加进同一会话） */
  openConversation: (id: string) => void;
  /** 永久删除某历史会话（删除活跃会话时同时回到新对话草稿） */
  deleteConversation: (id: string) => void;
  /** 回写 AI 生成标题；title 为空/undefined 时仅结束 pending、保留占位标题 */
  setConversationTitle: (id: string, title?: string) => void;
  
  notes: Note[];
  addNote: (note: Note) => void;
  updateNote: (id: string, updates: Partial<Note>) => void;
  deleteNote: (id: string) => void;
  
  highlights: Highlight[];
  addHighlight: (highlight: Highlight) => void;
  removeHighlight: (id: string) => void;
  
  currentView: 'home' | 'workspace' | 'research' | 'explore' | 'mindmaps' | 'settings';
  setCurrentView: (view: 'home' | 'workspace' | 'research' | 'explore' | 'mindmaps' | 'settings') => void;

  /** 全局 AI 助手面板是否展开 */
  qaPanelOpen: boolean;
  setQaPanelOpen: (open: boolean) => void;
  /** 全局 AI 助手面板宽度（可拖拽调整，持久化） */
  qaPanelWidth: number;
  setQaPanelWidth: (width: number) => void;
  /** AI 面板宽度分隔条是否正在拖拽中（运行时标志，不持久化；阅读器据此延迟重排） */
  qaPanelResizing: boolean;
  setQaPanelResizing: (resizing: boolean) => void;
  /** Explore 左栏（搜索）宽度（可拖拽调整，持久化） */
  exploreSearchWidth: number;
  setExploreSearchWidth: (width: number) => void;
  /** Explore 左栏（搜索）是否折叠为窄条 */
  exploreSearchCollapsed: boolean;
  setExploreSearchCollapsed: (collapsed: boolean) => void;
  /** PDF 引用定位请求（QAPanel 发出，阅读器消费；nonce 用于触发重复定位） */
  pdfLocateRequest: { paperId: string; text: string; nonce: number } | null;
  requestPdfLocate: (paperId: string, text: string) => void;
  /** 选中文本发起的提问草稿（阅读器→QAPanel 输入框） */
  qaInputDraft: string;
  setQaInputDraft: (text: string) => void;
  /** 全局问答：上下文库开关（AI 依摘要自动选择，固定优先） */
  useContext: boolean;
  setUseContext: (v: boolean) => void;
  /** 全局问答：是否允许 AI 请求调用工具（检索文献 / 读取文档） */
  toolEnabled: boolean;
  setToolEnabled: (v: boolean) => void;
  /** 全局问答：固定必用的 context 项 id */
  pinnedCtxIds: number[];
  setPinnedCtxIds: (ids: number[]) => void;
  /** 全局问答：排除不用的 context 项 id */
  excludedCtxIds: number[];
  setExcludedCtxIds: (ids: number[]) => void;
  
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: Paper[];
  setSearchResults: (papers: Paper[]) => void;
  searchProvider: string | null;
  setSearchProvider: (provider: string | null) => void;
  /** 高级结构化搜索条件（跨重启持久化，配合 /api/search 字段化检索） */
  searchFilters: SearchFilters;
  setSearchFilters: (filters: SearchFilters) => void;
  /** 本次应用会话是否已执行过「进入 Explore 的首次自动检索」。
   * 不持久化：仅约束本次会话，保证 StrictMode 双调用副作用、组件重挂载、Fast Refresh
   * 都不会让启动时的自动检索重复发生（组件内 useRef 做不到这一点）。 */
  exploreAutoSearched: boolean;
  markExploreAutoSearched: () => void;
  
  aiSuggestions: AISuggestion[];
  setAISuggestions: (suggestions: AISuggestion[]) => void;
  acceptSuggestion: (id: string) => void;
  rejectSuggestion: (id: string) => void;
  generateAISuggestions: () => void;
  
  contextItems: ContextItem[];
  addContextItem: (item: ContextItem) => void;
  removeContextItem: (id: string) => void;
  /** 整体替换 context 列表（后端 /context 为准时的同步入口） */
  setContextItems: (items: ContextItem[]) => void;
  /** 局部更新单条 context（摘要编辑 / 标签变更后同步） */
  patchContextItem: (id: string, updates: Partial<ContextItem>) => void;
  
  dataBlocks: DataBlock[];
  addDataBlock: (block: DataBlock) => void;
  removeDataBlock: (id: string) => void;
  addDataBlockToLatex: (id: string) => { success: boolean; message: string };
  /** 将 context 项一键插入 LaTeX（带标题+摘要，作为 addition 建议，插到 Conclusion 前） */
  addContextToLatex: (title: string, summary: string) => { success: boolean; message: string };

  // ---------- 设置（全局：数据源目录 + LLM 配置） ----------
  /** 后端设置快照（数据源目录 / 启用优先级 / LLM 配置）：设置页与 Explore 来源筛选共用，
   * 保证"被停用的数据源"不会出现在检索筛选项里 */
  settings: SettingsSnapshot | null;
  setSettings: (snapshot: SettingsSnapshot | null) => void;
  /** 从后端拉取最新设置快照（应用启动与设置页保存后刷新） */
  refreshSettings: () => Promise<void>;

  // ---------- 工作区 ----------
  /** 工作区列表（主页展示；每次进出主页刷新） */
  workspaces: WorkspaceInfo[];
  setWorkspaces: (items: WorkspaceInfo[]) => void;
  /** 当前活跃工作区 id；null=尚未选择（显示主页引导） */
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
  /** 切换工作区：先保存当前写作文件，再加载新工作区的 main.tex */
  switchWorkspace: (id: string) => Promise<void>;
  /** 把当前 latexContent 保存到活跃工作区的 main.tex */
  saveLatexToWorkspace: () => Promise<void>;

  // ---------- 思维导图（多导图，按作用域隔离，服务端为真源） ----------
  /** 各作用域导图列表缓存：key=工作区 id（''=全局）；进入页面时 refreshMindmaps 拉取 */
  mindmapsByScope: Record<string, MindmapMeta[]>;
  /** 已打开导图的完整文档缓存：mapId → 文档（含 version/nodes，乐观编辑与 409 对账用） */
  mindmapDocs: Record<string, MindmapInfo>;
  /** 工作区内当前选中的导图 id（随工作区快照独立持久化，切工作区互不串） */
  activeWsMindmapId: string | null;
  /** 全局作用域当前选中的导图 id（随全局快照持久化） */
  activeGlobalMindmapId: string | null;
  /** 取某作用域当前选中导图 id；workspaceId=undefined 时按当前活跃工作区/全局解析 */
  getActiveMindmapId: (workspaceId?: string | null) => string | null;
  /** 设置某作用域当前选中导图（workspaceId=null 表示全局；mapId=null 取消选中） */
  setActiveMindmapId: (workspaceId: string | null, mapId: string | null) => void;
  /** 拉取某作用域导图列表（默认当前作用域）；选中导图已不在列表时清空选中 */
  refreshMindmaps: (workspaceId?: string | null) => Promise<MindmapMeta[]>;
  /** 新建空白导图（仅根节点）并选中；workspaceId=undefined 取当前活跃工作区 */
  createMindmap: (input: { title?: string; rootText?: string; workspaceId?: string | null }) => Promise<MindmapInfo>;
  /** 从 mermaid mindmap 文本导入导图并选中 */
  importMindmap: (input: { mermaid: string; title?: string; workspaceId?: string | null }) => Promise<MindmapInfo>;
  /** 读取导图完整文档（命中缓存不重复请求；force=true 强制拉服务端版本对账） */
  loadMindmapDoc: (mapId: string, workspaceId?: string | null, force?: boolean) => Promise<MindmapInfo>;
  /** 写入/更新文档缓存，并同步列表元信息（version/title/updated_at）；画布提交/AI diff 后统一入口 */
  cacheMindmapDoc: (info: MindmapInfo) => void;
  /** 重命名导图（作用域自动解析：文档缓存 → 列表缓存 → 当前作用域） */
  renameMindmap: (mapId: string, title: string) => Promise<MindmapInfo>;
  /** 删除导图：清文档缓存、从列表移除；若当前选中它则清空选中 */
  deleteMindmap: (mapId: string) => Promise<void>;

  /** 启动时从后端快照恢复全部工作状态 */
  hydrate: () => Promise<void>;
}

const INITIAL_LATEX = '';

/** 兼容旧快照中的 context 项（旧字段 description/mcpConfig），归一化到新结构。 */
function normalizeContext(item: Partial<ContextItem> & { description?: string }): ContextItem {
  return {
    id: String(item.id ?? `ctx${Date.now()}`),
    type: item.type === 'url' ? 'url' : 'paper',
    title: item.title || '',
    summary: item.summary ?? item.description ?? '',
    source: item.source || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    status: item.status || 'ready',
    addedAt: item.addedAt || new Date().toISOString(),
    paperId: item.paperId || undefined,
    url: item.url || undefined,
    pdfStatus: item.pdfStatus === 'available' || item.pdfStatus === 'unavailable'
      ? item.pdfStatus
      : (item.type === 'url' ? undefined : 'unknown'),
    pdfError: item.pdfError ?? null,
  };
}

/** 归一化论文对象：旧快照中 authors 可能是 JSON 字符串，必须还原为数组，否则渲染时 .join() 崩溃。 */
function normalizePaper(paper: Partial<Paper> | null | undefined): Paper | null {
  if (!paper || typeof paper !== 'object' || !paper.id) return null;
  if (typeof paper.authors === 'string') {
    try {
      const parsed = JSON.parse(paper.authors);
      paper.authors = Array.isArray(parsed) ? parsed : [];
    } catch {
      paper.authors = [];
    }
  }
  if (!Array.isArray(paper.authors)) paper.authors = [];
  if (!Array.isArray(paper.keywords)) paper.keywords = [];
  return paper as Paper;
}

// ---------- 思维导图作用域辅助 ----------
/**
 * 前端导图作用域 key：工作区 id 原样使用；null/undefined → ''（全局）。
 * 注意区别于 MindmapMeta.scope 的后端形态（'' / 'ws:<id>'）。
 */
export function mindmapScopeKey(workspaceId?: string | null): string {
  return workspaceId ? workspaceId : '';
}

/** 后端 scope 形态 → workspaceId（'' 或无法识别时为 null=全局）。 */
function mindmapScopeToWs(scope: string): string | null {
  return typeof scope === 'string' && scope.startsWith('ws:') ? scope.slice(3) : null;
}

/** 完整文档 → 列表元信息（去 nodes）。 */
function toMindmapMeta(info: MindmapInfo): MindmapMeta {
  const meta: MindmapMeta = {
    id: info.id,
    scope: info.scope,
    title: info.title,
    version: info.version,
    created_at: info.created_at,
    updated_at: info.updated_at,
  };
  return meta;
}

/**
 * 解析导图所属工作区（重命名/删除等只拿到 mapId 的场景）：
 * 文档缓存（携带后端 scope）最可靠 → 列表缓存 → 兜底当前活跃工作区。
 */
function resolveMindmapWs(state: PaperMindStore, mapId: string): string | null {
  const doc = state.mindmapDocs[mapId];
  if (doc) return mindmapScopeToWs(doc.scope);
  for (const [key, items] of Object.entries(state.mindmapsByScope)) {
    if (items.some((m) => m.id === mapId)) return key === '' ? null : key;
  }
  return state.activeWorkspaceId;
}

type ViewType = 'home' | 'workspace' | 'research' | 'explore' | 'mindmaps' | 'settings';

/** 视图归一化：旧快照可能存有 'search'（独立搜索页已并入 Explore），回退到 explore。 */
function normalizeView(view: unknown): ViewType {
  if (view === 'search') return 'explore';
  // 创作模块下线期间，历史快照中的 'workspace' 一律回落到主页，避免恢复出不可用页面
  if (view === 'workspace') return WRITING_ENABLED ? 'workspace' : 'home';
  if (view === 'home' || view === 'research' || view === 'explore' || view === 'mindmaps' || view === 'settings') return view;
  // 未知视图统一回落主页：不再默认进入创作页
  return 'home';
}

/**
 * 工作区专属状态字段：各工作区独立存于 'ws:<id>' 项目（页面状态互相隔离）。
 * 全局字段（activeWorkspaceId / currentView）单独存于 'default' 项目。
 */
const WS_STATE_KEYS: (keyof PaperMindStore)[] = [
  'selectedPaper',
  'latexContent',
  'chatMessages',
  'chatConversations',
  'activeConversationId',
  'notes',
  'highlights',
  'qaPanelOpen',
  'qaPanelWidth',
  'exploreSearchWidth',
  'exploreSearchCollapsed',
  'useContext',
  'toolEnabled',
  'pinnedCtxIds',
  'excludedCtxIds',
  'searchQuery',
  'searchResults',
  'searchProvider',
  'searchFilters',
  'aiSuggestions',
  'contextItems',
  'dataBlocks',
  'readerTabs',
  'activeTabId',
  // 思维导图：每个工作区记住各自最后选中的导图（列表/文档缓存不进快照，服务端为真源）
  'activeWsMindmapId',
];

/** 从当前 store 提取工作区专属字段快照。 */
function pickWsState(current: PaperMindStore): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of WS_STATE_KEYS) snapshot[key] = current[key];
  return snapshot;
}

/**
 * 把后端工作区快照归一化为 store 字段（各字段含默认值与旧数据兼容处理）。
 * 与旧 hydrate 的字段处理逻辑一致，供 hydrate / switchWorkspace 复用。
 */
function applyWsState(state: Record<string, unknown>): Partial<PaperMindStore> {
  // 旧快照迁移：没有会话列表、但存在含用户提问的裸 chatMessages（新版本前
  // 的唯一聊天记录）→ 包成一个历史会话，避免升级后旧对话失去归档入口
  const migratedMessages = normalizeChatMessages(state.chatMessages);
  let chatConversations = normalizeConversations(state.chatConversations);
  if (chatConversations.length === 0 && migratedMessages.some((m) => m.role === 'user')) {
    const first = migratedMessages.find((m) => m.role === 'user') as ChatMessage;
    const last = migratedMessages[migratedMessages.length - 1];
    chatConversations = [{
      id: `c_migrated_${first.id}`,
      title: conversationPlaceholderTitle(first.content),
      titlePending: false,
      createdAt: first.timestamp,
      updatedAt: last.timestamp,
      messages: migratedMessages,
    }];
  }
  const rawActiveId = state.activeConversationId;
  const activeConversationId = typeof rawActiveId === 'string'
    && chatConversations.some((c) => c.id === rawActiveId)
    ? rawActiveId
    : (chatConversations.length > 0 && migratedMessages.length > 0
        // 迁移场景：载入被包成会话的旧对话时直接呈现它
        && state.chatConversations === undefined
        ? chatConversations[0].id
        : null);
  return {
    selectedPaper: normalizePaper(state.selectedPaper as Partial<Paper> | null | undefined),
    latexContent: typeof state.latexContent === 'string' ? state.latexContent : INITIAL_LATEX,
    chatMessages: migratedMessages,
    chatConversations,
    activeConversationId,
    notes: Array.isArray(state.notes) ? state.notes as Note[] : [],
    highlights: Array.isArray(state.highlights) ? state.highlights as Highlight[] : [],
    qaPanelOpen: state.qaPanelOpen !== false,
    qaPanelWidth: clampQaPanelWidth(state.qaPanelWidth, true),
    exploreSearchWidth: typeof state.exploreSearchWidth === 'number' && state.exploreSearchWidth > 0
      ? state.exploreSearchWidth : 360,
    exploreSearchCollapsed: state.exploreSearchCollapsed === true,
    useContext: state.useContext !== false,
    toolEnabled: state.toolEnabled !== false,
    pinnedCtxIds: Array.isArray(state.pinnedCtxIds)
      ? state.pinnedCtxIds.filter((n) => Number.isInteger(n)) : [],
    excludedCtxIds: Array.isArray(state.excludedCtxIds)
      ? state.excludedCtxIds.filter((n) => Number.isInteger(n)) : [],
    searchQuery: typeof state.searchQuery === 'string' ? state.searchQuery : '',
    searchResults: (Array.isArray(state.searchResults) ? state.searchResults as Paper[] : [])
      .map(p => normalizePaper(p)).filter((p): p is Paper => p !== null),
    searchProvider: typeof state.searchProvider === 'string' ? state.searchProvider : null,
    searchFilters: state.searchFilters && typeof state.searchFilters === 'object'
      ? { ...INITIAL_SEARCH_FILTERS, ...(state.searchFilters as Partial<SearchFilters>) }
      : { ...INITIAL_SEARCH_FILTERS },
    aiSuggestions: Array.isArray(state.aiSuggestions) ? state.aiSuggestions as AISuggestion[] : [],
    contextItems: (Array.isArray(state.contextItems) ? state.contextItems as ContextItem[] : []).map(normalizeContext),
    dataBlocks: Array.isArray(state.dataBlocks) ? state.dataBlocks as DataBlock[] : [],
    readerTabs: (Array.isArray(state.readerTabs) ? state.readerTabs as ReaderTab[] : [])
      .filter(t => t && typeof t.paperId === 'string')
      .map(t => ({
        paperId: t.paperId,
        title: typeof t.title === 'string' ? t.title : t.paperId,
        pdfFailed: t.pdfFailed === true,
        pdfError: typeof t.pdfError === 'string' ? t.pdfError : null,
      })),
    activeTabId: typeof state.activeTabId === 'string'
      && Array.isArray(state.readerTabs) && (state.readerTabs as ReaderTab[]).some(t => t.paperId === state.activeTabId)
      ? state.activeTabId
      : null,
    // 导图选中项：快照缺失/损坏时为 null（图库页据此呈现空状态）
    activeWsMindmapId: typeof state.activeWsMindmapId === 'string' ? state.activeWsMindmapId : null,
  };
}

export const usePaperMindStore = create<PaperMindStore>((set, get) => ({
  selectedPaper: null,
  setSelectedPaper: (paper) => set({ selectedPaper: paper }),

  readerTabs: [],
  activeTabId: null,
  openReaderTab: (paperId, title) => set((state) => {
    const exists = state.readerTabs.some(t => t.paperId === paperId);
    if (exists) return { activeTabId: paperId };
    return {
      readerTabs: [...state.readerTabs, { paperId, title }],
      activeTabId: paperId,
    };
  }),
  closeReaderTab: (paperId) => set((state) => {
    const idx = state.readerTabs.findIndex(t => t.paperId === paperId);
    if (idx === -1) return {};
    const tabs = state.readerTabs.filter(t => t.paperId !== paperId);
    let activeTabId = state.activeTabId;
    if (state.activeTabId === paperId) {
      const neighbor = tabs[Math.min(idx, tabs.length - 1)];
      activeTabId = neighbor ? neighbor.paperId : null;
    }
    return { readerTabs: tabs, activeTabId };
  }),
  setReaderTabPdfState: (paperId, failed, error = null) => set((state) => ({
    readerTabs: state.readerTabs.map(t => t.paperId === paperId
      ? { ...t, pdfFailed: failed, pdfError: failed ? error : null }
      : t),
  })),
  
  latexContent: INITIAL_LATEX,
  setLatexContent: (content) => set({ latexContent: content }),
  
  chatMessages: [],
  chatConversations: [],
  activeConversationId: null,
  addChatMessage: (message) => set((state) => {
    const chatMessages = [...state.chatMessages, message];
    let { chatConversations, activeConversationId } = state;

    // 草稿的首条用户提问 → 建档：占位标题即时可见，AI 标题异步替换
    if (message.role === 'user' && !activeConversationId) {
      const id = `c${Date.now()}`;
      const nowIso = message.timestamp || new Date().toISOString();
      chatConversations = [{
        id,
        title: conversationPlaceholderTitle(message.content),
        titlePending: true,
        createdAt: nowIso,
        updatedAt: nowIso,
        messages: chatMessages,
      }, ...chatConversations];
      activeConversationId = id;
      requestConversationTitle(id, message.content);
    } else if (activeConversationId) {
      // 已建档：消息快照随流式更新同步（列表随时可切换/重开，不丢进行中的内容）
      chatConversations = chatConversations.map((c) => (
        c.id === activeConversationId
          ? { ...c, messages: chatMessages, updatedAt: message.timestamp || c.updatedAt }
          : c
      ));
    }
    return { chatMessages, chatConversations, activeConversationId };
  }),
  updateChatMessage: (id, updates) => set((state) => {
    const chatMessages = state.chatMessages.map((m) => (m.id === id ? { ...m, ...updates } : m));
    const chatConversations = state.activeConversationId
      ? state.chatConversations.map((c) => (
          c.id === state.activeConversationId
            ? { ...c, messages: chatMessages, updatedAt: new Date().toISOString() }
            : c
        ))
      : state.chatConversations;
    return { chatMessages, chatConversations };
  }),
  newChat: () => set({ chatMessages: [], activeConversationId: null }),
  openConversation: (id) => {
    const conv = get().chatConversations.find((c) => c.id === id);
    if (!conv) return;
    // 重新加载持久化消息时剥离过期实时态（toolCall / streaming 光标）
    const messages = conv.messages.map((m) => {
      const { toolCall: _toolCall, ...rest } = m;
      return { ...rest, streaming: false } as ChatMessage;
    });
    set({
      chatMessages: messages,
      activeConversationId: id,
      chatConversations: get().chatConversations.map((c) => (
        c.id === id ? { ...c, messages } : c
      )),
    });
  },
  deleteConversation: (id) => set((state) => {
    const chatConversations = state.chatConversations.filter((c) => c.id !== id);
    if (state.activeConversationId === id) {
      return { chatConversations, chatMessages: [], activeConversationId: null };
    }
    return { chatConversations };
  }),
  setConversationTitle: (id, title) => set((state) => ({
    chatConversations: state.chatConversations.map((c) => (
      c.id === id
        ? { ...c, title: title?.trim() || c.title, titlePending: false }
        : c
    )),
  })),
  
  notes: [],
  addNote: (note) => set((state) => ({ notes: [...state.notes, note] })),
  updateNote: (id, updates) => set((state) => ({ notes: state.notes.map(note => note.id === id ? { ...note, ...updates } : note) })),
  deleteNote: (id) => set((state) => ({ notes: state.notes.filter(note => note.id !== id) })),
  
  highlights: [],
  addHighlight: (highlight) => set((state) => ({ highlights: [...state.highlights, highlight] })),
  removeHighlight: (id) => set((state) => ({ highlights: state.highlights.filter(h => h.id !== id) })),
  
  // 默认落在主页（工作区管理）：不默认进入创作页
  currentView: 'home',
  // 创作模块下线期间作为兜底闸门：任何来源的 'workspace' 跳转都拦回主页
  setCurrentView: (view) => set({ currentView: !WRITING_ENABLED && view === 'workspace' ? 'home' : view }),

  qaPanelOpen: true,
  setQaPanelOpen: (open) => set({ qaPanelOpen: open }),
  qaPanelWidth: QA_PANEL_DEFAULT_WIDTH,
  setQaPanelWidth: (width) => set({ qaPanelWidth: clampQaPanelWidth(width) }),
  qaPanelResizing: false,
  setQaPanelResizing: (resizing) => set({ qaPanelResizing: resizing }),
  exploreSearchWidth: 360,
  setExploreSearchWidth: (width) => set({ exploreSearchWidth: Math.max(240, Math.min(560, Math.round(width))) }),
  exploreSearchCollapsed: false,
  setExploreSearchCollapsed: (collapsed) => set({ exploreSearchCollapsed: collapsed }),
  pdfLocateRequest: null,
  requestPdfLocate: (paperId, text) => set({
    pdfLocateRequest: { paperId, text, nonce: Date.now() },
  }),
  qaInputDraft: '',
  setQaInputDraft: (text) => set({ qaInputDraft: text }),
  useContext: true,
  setUseContext: (v) => set({ useContext: v }),
  toolEnabled: true,
  setToolEnabled: (v) => set({ toolEnabled: v }),
  pinnedCtxIds: [],
  setPinnedCtxIds: (ids) => set({ pinnedCtxIds: ids }),
  excludedCtxIds: [],
  setExcludedCtxIds: (ids) => set({ excludedCtxIds: ids }),

  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),
  searchResults: [],
  setSearchResults: (papers) => set({ searchResults: papers }),
  searchProvider: null,
  setSearchProvider: (provider) => set({ searchProvider: provider }),
  searchFilters: { ...INITIAL_SEARCH_FILTERS },
  setSearchFilters: (filters) => set({ searchFilters: filters }),
  // 会话级（不持久化）：Explore 的首次自动检索只允许发生一次
  exploreAutoSearched: false,
  markExploreAutoSearched: () => set({ exploreAutoSearched: true }),

  settings: null,
  setSettings: (snapshot) => set({ settings: snapshot }),
  refreshSettings: async () => {
    // 后端不可用时保留已有快照（不静默清空，避免 Explore 来源筛选项凭空消失）
    try {
      set({ settings: await getSettings() });
    } catch {
      // 保留旧值
    }
  },
  
  aiSuggestions: [],
  setAISuggestions: (suggestions) => set({ aiSuggestions: suggestions }),
  acceptSuggestion: (id) => set((state) => ({
    aiSuggestions: state.aiSuggestions.map(s => 
      s.id === id ? { ...s, status: 'accepted' as const } : s
    )
  })),
  rejectSuggestion: (id) => set((state) => ({
    aiSuggestions: state.aiSuggestions.map(s => 
      s.id === id ? { ...s, status: 'rejected' as const } : s
    )
  })),
  generateAISuggestions: () => set((state) => {
    const { latexContent } = state;
    const suggestions: AISuggestion[] = [];
    
    const targets = [
      {
        text: 'Sequence transduction models have traditionally relied on recurrent neural networks (RNNs) and convolutional neural networks (CNNs).',
        suggestion: 'Traditional sequence transduction models depend on recurrent neural networks (RNNs) and convolutional neural networks (CNNs).',
        type: 'improvement' as const,
        title: i18n.t('store:suggestion.clarity.title'),
        description: i18n.t('store:suggestion.clarity.description')
      },
      {
        text: 'However, these architectures suffer from computational inefficiency due to sequential processing.',
        suggestion: 'These approaches, however, are computationally inefficient because of their sequential processing nature.',
        type: 'refinement' as const,
        title: i18n.t('store:suggestion.academicTone.title'),
        description: i18n.t('store:suggestion.academicTone.description')
      },
      {
        text: 'The Transformer has become the foundation for modern NLP models including BERT, GPT, and T5.',
        suggestion: 'The Transformer has become the foundation for modern NLP models, including BERT (Devlin et al., 2019), GPT (Brown et al., 2020), and T5.',
        type: 'addition' as const,
        title: i18n.t('store:suggestion.contextualEnhancement.title'),
        description: i18n.t('store:suggestion.contextualEnhancement.description')
      },
      {
        text: 'where \\(Q\\), \\(K\\), and \\(V\\) are the query, key, and value matrices respectively, and \\(d_k\\) is the dimension of the keys.',
        suggestion: 'where \\(Q\\), \\(K\\), and \\(V\\) are the query, key, and value matrices, respectively, and \\(d_k\\) denotes the dimension of the keys.',
        type: 'correction' as const,
        title: i18n.t('store:suggestion.grammarCorrection.title'),
        description: i18n.t('store:suggestion.grammarCorrection.description')
      }
    ];
    
    targets.forEach((target, index) => {
      const start = latexContent.indexOf(target.text);
      if (start !== -1) {
        suggestions.push({
          id: `ai${Date.now()}-${index + 1}`,
          type: target.type,
          title: target.title,
          description: target.description,
          originalText: target.text,
          suggestedText: target.suggestion,
          position: { start, end: start + target.text.length },
          status: 'pending',
          confidence: 0.85 + index * 0.03
        });
      }
    });
    
    return { aiSuggestions: suggestions };
  }),
  
  contextItems: [],
  addContextItem: (item) => set((state) => ({ contextItems: [...state.contextItems, item] })),
  removeContextItem: (id) => set((state) => ({ contextItems: state.contextItems.filter(i => i.id !== id) })),
  setContextItems: (items) => set({ contextItems: items }),
  patchContextItem: (id, updates) => set((state) => ({
    contextItems: state.contextItems.map(i => i.id === id ? { ...i, ...updates } : i),
  })),
  
  dataBlocks: [],
  addDataBlock: (block) => set((state) => ({ dataBlocks: [...state.dataBlocks, block] })),
  removeDataBlock: (id) => set((state) => ({ dataBlocks: state.dataBlocks.filter(b => b.id !== id) })),
  addDataBlockToLatex: (id) => {
    const state = (usePaperMindStore.getState());
    const block = state.dataBlocks.find(b => b.id === id);
    if (!block) {
      return { success: false, message: i18n.t('store:dataBlock.notFound') };
    }
    
    const blockTypeLabel = block.type.charAt(0).toUpperCase() + block.type.slice(1);
    let latexCode = '';
    
    if (block.type === 'table' && block.headers && block.rows) {
      const colSpec = '|' + block.headers.map(() => 'l|').join('');
      const headerRow = block.headers.join(' & ') + ' \\\\\\hline';
      const bodyRows = block.rows.map(row => row.join(' & ') + ' \\\\\\hline').join('\n');
      
      latexCode = `\n\\begin{table}[h]\n\\centering\n\\begin{tabular}{${colSpec}}\n\\hline\n${headerRow}\n${bodyRows}\n\\end{tabular}\n\\caption{${block.title}}\n\\label{tab:${block.id}}\n\\end{table}\n`;
    } else if (block.type === 'chart' && block.title) {
      const figLabel = block.title.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      latexCode = `\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{${figLabel}}\n\\caption{${block.title}${block.description ? ' — ' + block.description : ''}}\n\\label{fig:${block.id}}\n\\end{figure}\n`;
    } else if (block.type === 'equation' && block.equation) {
      latexCode = `\n\\begin{equation}\n${block.equation}\n\\label{eq:${block.id}}\n\\end{equation}\n`;
    } else if (block.type === 'figure' && block.title) {
      const figLabel = block.title.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      latexCode = `\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{${figLabel}}\n\\caption{${block.title}${block.description ? ' — ' + block.description : ''}}\n\\label{fig:${block.id}}\n\\end{figure}\n`;
    }
    
    if (latexCode) {
      const conclusionMatch = state.latexContent.match(/\\section\{Conclusion\}/);
      const insertPos = conclusionMatch 
        ? state.latexContent.indexOf(conclusionMatch[0]) 
        : state.latexContent.length;
      
      const newContent = state.latexContent.replace(
        /\\section\{Conclusion\}/,
        latexCode + '\n\\section{Conclusion}'
      );
      
      const newSuggestion: AISuggestion = {
        id: `ai-datablock-${Date.now()}`,
        type: 'addition',
        title: i18n.t('store:dataBlock.insertedTitle', { type: blockTypeLabel }),
        description: i18n.t('store:dataBlock.insertedDescription', { title: block.title }),
        originalText: '',
        suggestedText: latexCode,
        position: {
          start: insertPos,
          end: insertPos + latexCode.length
        },
        status: 'pending',
        confidence: 0.95
      };
      
      set((state) => ({
        latexContent: newContent,
        aiSuggestions: [...state.aiSuggestions, newSuggestion]
      }));
      
      return { success: true, message: i18n.t('store:dataBlock.addedToPaper', { type: blockTypeLabel }) };
    }
    
    return { success: false, message: i18n.t('store:dataBlock.unsupported') };
  },

  addContextToLatex: (title, summary) => {
    const state = (usePaperMindStore.getState());
    const safeTitle = String(title || 'Context').replace(/[\\{}&$#_^%~]/g, (m) => `\\${m}`);
    const safeSummary = String(summary || '').replace(/[\\{}&$#_^%~]/g, (m) => `\\${m}`);
    const latexCode = `\n\\subsection*{Related Material: ${safeTitle}}\n${safeSummary}\n`;

    const conclusionMatch = state.latexContent.match(/\\section\{Conclusion\}/);
    const insertPos = conclusionMatch
      ? state.latexContent.indexOf(conclusionMatch[0])
      : state.latexContent.length;

    const newContent = state.latexContent.replace(
      /\\section\{Conclusion\}/,
      latexCode + '\n\\section{Conclusion}'
    );

    const newSuggestion: AISuggestion = {
      id: `ai-context-${Date.now()}`,
      type: 'addition',
      title: i18n.t('store:contextInsert.suggestionTitle', { title }),
      description: i18n.t('store:contextInsert.suggestionDescription', { title }),
      originalText: '',
      suggestedText: latexCode,
      position: { start: insertPos, end: insertPos + latexCode.length },
      status: 'pending',
      confidence: 0.9,
    };

    set((s) => ({
      latexContent: newContent,
      aiSuggestions: [...s.aiSuggestions, newSuggestion],
    }));

    return { success: true, message: i18n.t('store:contextInsert.success') };
  },

  // ---------- 工作区 ----------
  workspaces: [],
  setWorkspaces: (items) => set({ workspaces: items }),
  activeWorkspaceId: null,
  setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
  saveLatexToWorkspace: async () => {
    const { activeWorkspaceId, latexContent } = usePaperMindStore.getState();
    if (!activeWorkspaceId) return;
    try {
      await saveLatexFile(activeWorkspaceId, latexContent);
    } catch (err) {
      console.warn('写作文件保存失败:', err);
    }
  },
  switchWorkspace: async (id) => {
    const current = usePaperMindStore.getState();
    const { activeWorkspaceId } = current;
    switchingWorkspace = true;
    try {
      // 1. 离开旧工作区：先把写作文件与页面状态保存到旧工作区的独立存储
      if (activeWorkspaceId && activeWorkspaceId !== id) {
        try { await current.saveLatexToWorkspace(); } catch (err) {
          console.warn('写作文件保存失败:', err);
        }
        try {
          await saveState(pickWsState(current), activeWorkspaceId);
        } catch (err) {
          console.warn('旧工作区状态保存失败:', err);
        }
      }
      // 2. 并行加载新工作区：页面快照 + 上下文库 + 写作文件
      const [wsState, items, latex] = await Promise.all([
        loadState(id).catch(() => null),
        listContextItems(id).catch(() => null),
        readLatexFile(id).catch(() => null),
      ]);
      // 3. 原子替换为新工作区的页面状态（避免切换中途旧状态被自动保存写进新工作区）
      set({
        activeWorkspaceId: id,
        ...(wsState ? applyWsState(wsState) : {}),
        ...(items ? { contextItems: items } : {}),
        ...(latex !== null ? { latexContent: latex } : {}),
      });
      // 4. 全局记录活跃工作区（重启后据此自动进入）
      try {
        await saveState({ activeWorkspaceId: id }, '');
      } catch (err) {
        console.warn('活跃工作区记录失败:', err);
      }
    } finally {
      switchingWorkspace = false;
    }
  },

  // ---------- 思维导图 ----------
  mindmapsByScope: {},
  mindmapDocs: {},
  activeWsMindmapId: null,
  activeGlobalMindmapId: null,
  getActiveMindmapId: (workspaceId) => {
    // undefined=按当前活跃工作区解析；显式 null=强制全局；显式 id=该工作区
    const ws = workspaceId === undefined ? get().activeWorkspaceId : workspaceId;
    return ws ? get().activeWsMindmapId : get().activeGlobalMindmapId;
  },
  setActiveMindmapId: (workspaceId, mapId) => set(
    workspaceId ? { activeWsMindmapId: mapId } : { activeGlobalMindmapId: mapId }
  ),
  refreshMindmaps: async (workspaceId) => {
    const ws = workspaceId === undefined ? get().activeWorkspaceId : workspaceId;
    const key = mindmapScopeKey(ws);
    const items = await listMindmapsApi(ws ?? undefined);
    set((state) => {
      const activeId = ws ? state.activeWsMindmapId : state.activeGlobalMindmapId;
      const patch: Partial<PaperMindStore> = {
        mindmapsByScope: { ...state.mindmapsByScope, [key]: items },
      };
      // 选中导图已被删除/易主：清空选中，避免编辑器对着不存在的地图发请求
      if (activeId && !items.some((m) => m.id === activeId)) {
        if (ws) patch.activeWsMindmapId = null;
        else patch.activeGlobalMindmapId = null;
      }
      return patch;
    });
    return items;
  },
  createMindmap: async (input) => {
    const ws = input.workspaceId === undefined ? get().activeWorkspaceId : input.workspaceId;
    const info = await createMindmapApi({
      title: input.title,
      rootText: input.rootText,
      workspaceId: ws,
    });
    const key = mindmapScopeKey(ws);
    set((state) => ({
      mindmapsByScope: {
        ...state.mindmapsByScope,
        [key]: [toMindmapMeta(info), ...(state.mindmapsByScope[key] ?? [])],
      },
      mindmapDocs: { ...state.mindmapDocs, [info.id]: info },
      ...(ws ? { activeWsMindmapId: info.id } : { activeGlobalMindmapId: info.id }),
    }));
    return info;
  },
  importMindmap: async (input) => {
    const ws = input.workspaceId === undefined ? get().activeWorkspaceId : input.workspaceId;
    const info = await importMindmapApi({
      mermaid: input.mermaid,
      title: input.title,
      workspaceId: ws,
    });
    const key = mindmapScopeKey(ws);
    set((state) => ({
      mindmapsByScope: {
        ...state.mindmapsByScope,
        [key]: [toMindmapMeta(info), ...(state.mindmapsByScope[key] ?? [])],
      },
      mindmapDocs: { ...state.mindmapDocs, [info.id]: info },
      ...(ws ? { activeWsMindmapId: info.id } : { activeGlobalMindmapId: info.id }),
    }));
    return info;
  },
  loadMindmapDoc: async (mapId, workspaceId, force = false) => {
    const cached = get().mindmapDocs[mapId];
    if (cached && !force) return cached;
    const ws = workspaceId === undefined ? get().activeWorkspaceId : workspaceId;
    const info = await getMindmapApi(mapId, ws ?? undefined);
    get().cacheMindmapDoc(info);
    return info;
  },
  cacheMindmapDoc: (info) => set((state) => {
    const key = mindmapScopeKey(mindmapScopeToWs(info.scope));
    const byScope = { ...state.mindmapsByScope };
    const list = byScope[key];
    if (Array.isArray(list)) {
      const meta = toMindmapMeta(info);
      byScope[key] = list.some((m) => m.id === info.id)
        ? list.map((m) => (m.id === info.id ? meta : m))
        : [meta, ...list];
    }
    return {
      mindmapDocs: { ...state.mindmapDocs, [info.id]: info },
      mindmapsByScope: byScope,
    };
  }),
  renameMindmap: async (mapId, title) => {
    const ws = resolveMindmapWs(get(), mapId);
    const info = await renameMindmapApi(mapId, title, ws ?? undefined);
    get().cacheMindmapDoc(info);
    return info;
  },
  deleteMindmap: async (mapId) => {
    const ws = resolveMindmapWs(get(), mapId);
    await deleteMindmapApi(mapId, ws ?? undefined);
    const key = mindmapScopeKey(ws);
    set((state) => {
      const docs = { ...state.mindmapDocs };
      delete docs[mapId];
      const patch: Partial<PaperMindStore> = { mindmapDocs: docs };
      const list = state.mindmapsByScope[key];
      if (Array.isArray(list)) {
        patch.mindmapsByScope = {
          ...state.mindmapsByScope,
          [key]: list.filter((m) => m.id !== mapId),
        };
      }
      if (ws && state.activeWsMindmapId === mapId) patch.activeWsMindmapId = null;
      if (!ws && state.activeGlobalMindmapId === mapId) patch.activeGlobalMindmapId = null;
      return patch;
    });
  },

  hydrate: async () => {
    try {
      // 1. 全局状态：哪个工作区活跃 + 当前视图（跨工作区共享）
      const globalState = await loadState();
      const activeWorkspaceId = typeof globalState.activeWorkspaceId === 'string'
        ? globalState.activeWorkspaceId : null;
      // 2. 工作区专属状态：各工作区独立存于 'ws:<id>'。
      //    迁移兼容：旧版本把所有状态存在全局 default，将其作为当前活跃工作区的初始状态
      //    （仅旧版单一工作区上下文受益）。
      let wsState: Record<string, unknown> = {};
      if (activeWorkspaceId) {
        wsState = await loadState(activeWorkspaceId);
        if (Object.keys(wsState).length === 0) {
          wsState = { ...globalState };
          delete wsState.activeWorkspaceId;
          delete wsState.currentView;
        }
      }
      const restoredView = normalizeView(globalState.currentView);
      set({
        activeWorkspaceId,
        // 无活跃工作区时统一回到主页引导；「设置」与「导图」（全局作用域）不依赖工作区，允许停留
        currentView: !activeWorkspaceId && restoredView !== 'settings' && restoredView !== 'mindmaps'
          ? 'home'
          : restoredView,
        // 全局作用域导图选中项（跨重启恢复；工作区内的选中项在 applyWsState 中恢复）
        activeGlobalMindmapId: typeof globalState.activeGlobalMindmapId === 'string'
          ? globalState.activeGlobalMindmapId : null,
        ...applyWsState(wsState),
      });
      // 3. context 库以后端 /context 为准（按当前工作区过滤，避免与快照脱节）
      try {
        const items = await listContextItems(activeWorkspaceId ?? undefined);
        set({ contextItems: items });
      } catch {
        // 后端 context 接口不可用时保留快照中的 context
      }
      // 4. 工作区列表以后端为准
      try {
        const wss = await listWorkspaces();
        set({ workspaces: wss });
      } catch {
        // 后端不可用：保留空列表
      }
      // 5. 设置快照（数据源目录 / 启用优先级 / LLM 配置）：设置页与 Explore 来源筛选共用
      try {
        set({ settings: await getSettings() });
      } catch {
        // 设置接口不可用：保留 null（Explore 退回静态来源目录）
      }
      // 6. 已进入某工作区时，写作文件以工作区 main.tex 为准（覆盖快照中的 latexContent）
      if (activeWorkspaceId) {
        try {
          const content = await readLatexFile(activeWorkspaceId);
          set({ latexContent: content });
        } catch {
          // 文件不存在或后端不可用：保留快照内容
        }
      }
    } catch (err) {
      console.warn('工作状态恢复失败（后端未启动或尚无快照）:', err);
    }
  },
}));

// ---------- 自动保存：状态变化后防抖写回后端快照 ----------
// 快照按归属拆分：
//   - 全局字段（activeWorkspaceId / currentView）→ 存 'default' 项目；
//   - 工作区专属字段 → 存 'ws:<id>' 项目（各工作区页面状态互相隔离）。
const GLOBAL_STATE_KEYS: (keyof PaperMindStore)[] = ['activeWorkspaceId', 'currentView', 'activeGlobalMindmapId'];

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let hydrationDone = false;
/** 工作区切换中：暂停自动保存，避免旧状态被写进新工作区（切换函数内显式保存） */
let switchingWorkspace = false;
/** 上次写入工作区 main.tex 的 latex 内容（避免重复请求） */
let lastSavedLatex = '';

usePaperMindStore.subscribe(() => {
  if (!hydrationDone) return;  // hydrate 完成前不保存（避免用初始空状态覆盖快照）
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!hydrationDone || switchingWorkspace) return;
    const current = usePaperMindStore.getState();
    // 写作内容同步到工作区文件（main.tex）：内容有变化才请求
    if (current.activeWorkspaceId && current.latexContent !== lastSavedLatex) {
      lastSavedLatex = current.latexContent;
      saveLatexFile(current.activeWorkspaceId, current.latexContent).catch((err) => {
        console.warn('写作文件自动保存失败:', err);
      });
    }
    // 全局快照：活跃工作区 + 当前视图
    const globalSnapshot: Record<string, unknown> = {};
    for (const key of GLOBAL_STATE_KEYS) {
      globalSnapshot[key] = current[key];
    }
    saveState(globalSnapshot, '').catch((err) => {
      console.warn('全局状态自动保存失败:', err);
    });
    // 工作区快照：当前工作区的页面状态（独立存储）
    if (current.activeWorkspaceId) {
      saveState(pickWsState(current), current.activeWorkspaceId).catch((err) => {
        console.warn('工作区状态自动保存失败:', err);
      });
    }
  }, 600);
});

// 启动时先恢复；恢复完成后再开启自动保存
export async function initPersistence(): Promise<void> {
  const store = usePaperMindStore.getState();
  await store.hydrate();
  hydrationDone = true;
}
