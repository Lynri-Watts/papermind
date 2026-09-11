export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number;
  abstract: string;
  // --- 后端真实字段（来自 Semantic Scholar / OpenAlex / arXiv / CORE）---
  source: string;                // semantic_scholar | openalex | arxiv | core
  external_id: string;           // 数据源内的原始 id
  url: string;                   // 落地页
  pdf_url: string | null;
  citation_count: number | null;
  reference_count: number | null;
  publication_venue: string | null;
  doi: string | null;
  // --- 前端渲染兼容字段（api 层从后端字段派生）---
  journal: string;
  conference: string;
  citations: number;
  pdfUrl: string;
  keywords: string[];
}

/** 单个数据源在一次聚合检索中的命中状态（后端 /api/search 的 sources 字段） */
export interface SearchSourceStatus {
  source: string;
  status: 'ok' | 'empty' | 'error';
  count: number;
  error?: string;
}

export interface SearchResponse {
  papers: Paper[];
  total: number;
  page: number;
  limit: number;
  /** 实际使用的数据源：单一来源 id，或 'all'（多源合并） */
  provider?: string;
  /** 各数据源命中状态（多源聚合时用于如实展示"哪个源没返回、为什么"） */
  sources?: SearchSourceStatus[];
}

export interface RagQueryRequest {
  /** 当前论文内部 id；为空表示无论文（如写作/通用问答，仅基于上下文库/文档/检索作答） */
  paperId?: string;
  query: string;
  /** 是否启用 context 库（默认 true） */
  useContext?: boolean;
  /** 是否允许 AI 请求调用工具补充文献（默认 true） */
  enableTool?: boolean;
  /** 用户手动固定的 context item id（可选） */
  contextIds?: number[];
  /** 用户排除的 context item id（可选） */
  excludeIds?: number[];
  /** 精简对话历史（仅 user/assistant 文字，不含全文与出处详情），用于追问上下文 */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** 当前正在编辑的文档（LaTeX，写作场景）：仅作 read_document 工具的读取资源，不随提问注入 */
  document?: string;
  /** 当前活跃工作区 id；后端据此只检索该工作区的上下文库（缺省=全局库） */
  workspaceId?: string;
  /** 本次 ReAct 运行的 run_id（前端生成，/rag/cancel 停止用；缺省后端自生成） */
  runId?: string;
}

export interface RagSource {
  index: number;
  /** 来源名称（论文标题 / context 标题） */
  label?: string;
  /** 若来自 context 库，对应的 context item id；当前论文时为 null */
  context_id?: number | null;
  /** 来源若为论文，对应的论文内部 id（source:external_id），供"跳转原文"使用 */
  paper_id?: string | null;
  text: string;
  score: number;
}

export interface RagQueryResponse {
  answer: string;
  sources: string[];
  sourceDetails?: RagSource[];
  confidence: number;
}

/** 工具搜索返回的论文（论文选择卡展示用） */
export interface ToolPaper {
  id: string;
  title: string;
  authors: string[];
  year: number;
  abstract: string;
  url: string;
  pdf_url: string | null;
  citation_count: number | null;
}

/** SSE react_action 事件：AI 决定执行一个动作（工具调用），Thought 已随 thought 事件流式输出 */
export interface ReactActionEvent {
  toolName: string;
  toolLabel: string;
  /** 工具参数（人类可读展示；read_materials 为空对象） */
  arguments: Record<string, unknown>;
  /** 该步思考全文（后端冗余附上；通常已由 thought 增量累积，用作兜底） */
  thought?: string;
}

/** SSE observation 事件：工具执行结果（Observation，自动执行无需确认） */
export interface ReactObservationEvent {
  toolName: string;
  toolLabel: string;
  status: 'done' | 'error';
  provider: string | null;
  papers: ToolPaper[];
  /** 工具返回的人类可读结果摘要（论文列表文字 / 读取情况 / 错误原因） */
  toolMessage: string;
}

/**
 * 单个 ReAct 步骤（Thought → Action → Observation 合一）：
 * 生成中存于 ChatMessage.toolCall.steps 实时流式展开，完成后折叠进 toolLog 持久化。
 * 旧版交互式会话遗留的 toolLog 条目（无 thought，带 toolMessage，status='rejected'）亦兼容。
 */
export interface ReactStep {
  id: string;
  /** AI 的思考文字（Thought）：生成中实时累积，完成后默认折叠、点击展开 */
  thought?: string;
  /** 动作：调用的工具名；缺省=纯思考步骤（如 READY 直接回答） */
  toolName?: string;
  /** 动作：工具中文标签 */
  toolLabel?: string;
  /** 动作：工具参数 */
  arguments?: Record<string, unknown>;
  /** thinking=思考中 / running=已发出动作待观察（仅实时流式态）；
   *  done=观察完成 / error=执行失败 / rejected=旧版跳过（兼容历史记录） */
  status: 'thinking' | 'running' | 'done' | 'error' | 'rejected';
  /** 观察结果（Observation）文字摘要 */
  observation?: string;
  /** 观察：实际数据源（如 semantic_scholar） */
  provider?: string | null;
  /** 观察：工具返回的论文列表 */
  papers?: ToolPaper[];
  /** 完成时间戳 */
  executedAt?: string;
}

/** 一条 ReAct 步骤记录（toolLog 持久化用；别名保持旧字段名兼容） */
export type ToolCallLog = ReactStep;

/** ReAct 实时轨迹（生成中消息持有；完成后折叠为 toolLog 并从消息清除） */
export interface ReactTrailState {
  /** 本次运行的 run_id（供 /rag/cancel 停止） */
  runId?: string;
  /** 实时展开的步骤：Thought 逐字流式出现 → Action 徽标 → Observation 追加 */
  steps: ReactStep[];
  /** 已点击停止、等待后端结束当前流 */
  cancelling?: boolean;
}

export interface ChatMessage {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
  // RAG 回答附带出处（供前端渲染）
  sources?: string[];
  sourceDetails?: RagSource[];
  /** 生成中标记：SSE 流式输出时用于显示中间过程与打字光标 */
  streaming?: boolean;
  // ---- ReAct 工具轨迹（自动执行：Thought→Action→Observation） ----
  /** 实时轨迹（生成中消息持有：步骤流式展开 + run_id 供停止） */
  toolCall?: ReactTrailState;
  /** 完成后的步骤记录（折叠为紧凑卡片，持久化保留） */
  toolLog?: ToolCallLog[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'paper' | 'author' | 'topic';
  x?: number;
  y?: number;
  size?: number;
  color?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'cites' | 'author' | 'related';
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Note {
  id: string;
  paperId: string;
  content: string;
  highlight: string;
  position: { start: number; end: number };
  createdAt: string;
}

export interface Highlight {
  id: string;
  paperId: string;
  text: string;
  position: { page: number; start: number; end: number };
  color: string;
  createdAt: string;
}

export interface AISuggestion {
  id: string;
  type: 'improvement' | 'correction' | 'addition' | 'refinement';
  title: string;
  description: string;
  originalText: string;
  suggestedText: string;
  position: { start: number; end: number };
  status: 'pending' | 'accepted' | 'rejected';
  confidence: number;
}

export interface ContextItem {
  id: string;
  /** paper：从 Explore 论文实例导入；url：网页正文抓取 */
  type: 'paper' | 'url';
  title: string;
  /** 摘要：paper→abstract(无则LLM生成)；url→网页摘要。常驻，问答只带它 */
  summary: string;
  /** 出处展示：url 时为链接；paper 时为内部 id */
  source: string;
  tags: string[];
  /** ready：摘要可用；pending：生成中；failed：失败 */
  status: 'ready' | 'pending' | 'failed';
  addedAt: string;
  /** paper 特有：论文内部 id（source:external_id） */
  paperId?: string;
  /** url 特有：原始链接 */
  url?: string;
  /** paper 特有：PDF/全文可打开性（unknown=从未自动探测；仅 paper 有值） */
  pdfStatus?: 'available' | 'unavailable' | 'unknown';
  /** paper 特有：最近一次无法打开的具体原因（后端本地化文案） */
  pdfError?: string | null;
}

export interface MCPSkillConfig {
  name: string;
  serverName: string;
  toolName: string;
  parameters: Record<string, string>;
}

export interface DataBlock {
  id: string;
  type: 'chart' | 'table' | 'figure' | 'equation';
  title: string;
  description?: string;
  source?: string;
  data?: number[];
  labels?: string[];
  headers?: string[];
  rows?: string[][];
  equation?: string;
  figureCaption?: string;
  addedAt: string;
}

/** 阅读器标签页：Deep Research 左侧可同时打开多篇论文 */
export interface ReaderTab {
  /** 论文内部 id（source:external_id / local:<ws_id>:<path>） */
  paperId: string;
  title: string;
  /** PDF 自动探测已失败：重启后直接呈现失败态，不再自动重试（仅手动刷新） */
  pdfFailed?: boolean;
  /** 失败原因（后端本地化文案），用于失败态展示与 tooltip */
  pdfError?: string | null;
}

// ---------- 设置（数据源与 LLM 服务） ----------
/** 单个数据源的凭据与启用/优先级状态（后端 GET /api/settings 的 sources 项） */
export interface SettingsSource {
  id: string;
  label: string;
  /** 凭据字段名（如 "API Key"）；为 null 表示该源无需任何配置 */
  credential_label: string | null;
  /** true=密钥（只回掩码）；false=可明文回显（如邮箱） */
  secret: boolean;
  required: boolean;
  help_url: string | null;
  description: string;
  /** 是否已配置凭据 */
  configured: boolean;
  /** 是否已启用（出现在聚合优先级中） */
  enabled: boolean;
  /** 聚合优先级下标；-1=未启用 */
  priority: number;
  /** 凭据当前值：密钥为掩码，非密钥为明文；无凭据字段时缺省 */
  value?: string;
}

/** LLM 服务配置（GET /api/settings 的 llm 字段；密钥只回"是否配置 + 掩码"） */
export interface SettingsLLM {
  base_url: string;
  model: string;
  api_key_configured: boolean;
  api_key_hint: string;
}

export interface SettingsSnapshot {
  llm: SettingsLLM;
  /** 启用者按优先级在前，禁用者随后 */
  sources: SettingsSource[];
}

/** PUT /api/settings 请求体：字段出现即更新（credentials 传空串表示清除） */
export interface SettingsUpdate {
  llm?: { base_url?: string; model?: string; api_key?: string };
  /** 数据源 id → 凭据明文；仅需提交要改动的源 */
  credentials?: Record<string, string>;
  /** 启用的数据源有序列表（顺序即聚合优先级）；至少一个 */
  source_order?: string[];
}

/** 连通性测试结果（失败属被测对象结果，接口仍 HTTP 200） */
export interface SettingsTestResult {
  ok: boolean;
  message: string;
  latency_ms?: number;
}

// ---------- 工作区 ----------
/** 工作区：服务器端受控文件夹，存放用户上传的文献与正在写作的文件 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  /** 文件数量（列表接口计算返回） */
  file_count?: number;
}

/** 工作区内文件条目 */
export interface WorkspaceFile {
  /** 相对路径（POSIX 风格，可含子目录） */
  path: string;
  size: number;
  mtime: number;
  kind: 'pdf' | 'latex' | 'text' | 'other';
  /** PDF 文件映射的本地文献 id（local:<ws_id>:<path>），供阅读/上下文/问答复用 */
  paper_id: string | null;
}
