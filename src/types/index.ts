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

/**
 * 用户在 PDF 阅读器中框选原文后发起提问时携带的「引用片段」语境。
 * 让模型明确知道用户做了什么操作、片段出自哪篇论文哪一页，而不是把原文误当成问题。
 */
export interface QuoteContext {
  /** 片段所属论文内部 id（source:external_id / local:工作区:路径） */
  paperId: string;
  /** 论文标题（展示与模型语境用） */
  title: string;
  authors?: string[];
  year?: number | null;
  /** 片段所在页码（1 基；无法确定时为 null） */
  page?: number | null;
  /** 用户框选的原文（已折叠空白） */
  text: string;
  /** 片段前文（论文原文截取，可能缺失） */
  before?: string;
  /** 片段后文（论文原文截取，可能缺失） */
  after?: string;
}

/** history 中携带的精简引用语境（只保留定位与辨识信息，不含前后文，控制体积） */
export type HistoryQuote = Pick<QuoteContext, 'paperId' | 'title' | 'page' | 'text'>;

export interface RagQueryRequest {
  /** 当前论文内部 id；为空表示无论文（如写作/通用问答，仅基于上下文库/文档/检索作答） */
  paperId?: string;
  query: string;
  /** 阅读器框选提问：用户选中的原文片段及来源语境（自动附带前后文） */
  quote?: QuoteContext;
  /** 是否启用 context 库（默认 true） */
  useContext?: boolean;
  /** 是否允许 AI 请求调用工具补充文献（默认 true） */
  enableTool?: boolean;
  /** 用户手动固定的 context item id（可选） */
  contextIds?: number[];
  /** 用户排除的 context item id（可选） */
  excludeIds?: number[];
  /** 精简对话历史（仅 user/assistant 文字，不含全文与出处详情），用于追问上下文；
   *  user 轮可带 quote 标注该轮问题针对的是哪个引用片段 */
  history?: { role: 'user' | 'assistant'; content: string; quote?: HistoryQuote }[];
  /** 当前正在编辑的文档（LaTeX 快照，写作场景）：仅用于系统提示判断焦点，
   *  AI 读稿一律走 read_file 直接读盘（发送前写作侧会先把缓冲区全部落盘） */
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
  /** 检索分块全文：仅用于 PDF 原文定位兜底，不在界面展示 */
  text: string;
  /** 该引用对应的原文核心句（AI 逐字摘录/后端校验回退）；缺失时界面只显示来源行 */
  quote?: string | null;
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
  /** 工具参数（人类可读展示，如 read_paper 的 paper_ids/query） */
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
  /** 用户消息：该轮提问针对的阅读器选中片段（气泡上展示来源芯片，多轮历史带给模型） */
  quote?: QuoteContext;
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
  // ---- 本次回答中 AI 对思维导图的编辑（一问一事务，可整事务撤销） ----
  mindmapEdits?: ChatMindmapEdit[];
  // ---- 本次回答中 AI 对写作工作区文件的编辑（一问一事务，可整事务回滚） ----
  writingEdit?: ChatWritingEdit;
  /** 非阻断提示（如本次无可用文献材料、回答未引用来源）；随消息持久化 */
  notice?: string;
}

/**
 * 一轮归档的问答会话。「清空对话」不再直接删除消息，而是把当前会话
 * 归档到 chatConversations 列表，用户可随时重新打开继续追问。
 * 当前未归档的草稿（chatMessages + activeConversationId=null）不入此结构，
 * 首条用户提问发出时才建档。
 */
export interface ChatConversation {
  id: string;
  /** 会话标题：首问截断占位 → 后端 LLM 生成后异步替换 */
  title: string;
  /** AI 标题是否仍在生成（列表可显示轻量等待态）；失败时置 false 保留占位标题 */
  titlePending?: boolean;
  /** 建档时间（首条用户提问时间，ISO） */
  createdAt: string;
  /** 最近一条消息时间（ISO）；列表按此倒序排列 */
  updatedAt: string;
  messages: ChatMessage[];
}

/** 一次回答中 AI 对某张导图的事务编辑记录（用于「撤销本次 AI 修改 / 保留」） */
export interface ChatMindmapEdit {
  mapId: string;
  /** 同一次回答共享一个事务 id，是整事务撤销的单位；
   *  null 表示 AI 仅新建了导图（无编辑修订，不提供撤销，仅可打开/删除） */
  transactionId: string | null;
  /** 收到最后一个 diff 后的导图版本（撤销成功前用于状态展示） */
  version: number;
  /** 编辑发生时的作用域（null=全局库；撤销请求必须带同一作用域） */
  workspaceId?: string | null;
  /** 用户已在本消息上撤销该事务 */
  undone?: boolean;
  /** 用户选择保留（关闭提示条），不再展示撤销入口 */
  kept?: boolean;
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

/** 问答正文读取粒度偏好（后端 settings_store.reading_scope） */
export type ReadingScope = 'auto' | 'full' | 'passages';

export interface SettingsSnapshot {
  llm: SettingsLLM;
  /** 启用者按优先级在前，禁用者随后 */
  sources: SettingsSource[];
  /** AI 问答读取论文/上下文正文的粒度偏好 */
  reading_scope: ReadingScope;
}

/** PUT /api/settings 请求体：字段出现即更新（credentials 传空串表示清除） */
export interface SettingsUpdate {
  llm?: { base_url?: string; model?: string; api_key?: string };
  /** 数据源 id → 凭据明文；仅需提交要改动的源 */
  credentials?: Record<string, string>;
  /** 启用的数据源有序列表（顺序即聚合优先级）；至少一个 */
  source_order?: string[];
  /** 问答正文读取粒度偏好 */
  reading_scope?: ReadingScope;
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
  kind: 'pdf' | 'latex' | 'text' | 'image' | 'other';
  /** PDF 文件映射的本地文献 id（local:<ws_id>:<path>），供阅读/上下文/问答复用 */
  paper_id: string | null;
}

// ---------- 思维导图（mindmap） ----------
// 自定义 JSON 文档为唯一真源，mermaid mindmap 文本为互换格式；
// 字段与后端 backend/services/mindmap_doc.py 逐字段对齐。
/** 节点类型：普通主题 / 论文引用（paper 节点必须带合法 paperId） */
export type MindmapNodeKind = 'topic' | 'paper';

/**
 * 节点形状（与 mermaid mindmap 语法一一对应；画布据此渲染，初始布局由同源
 * mermaid 引擎给出几何）。mermaid 不支持的形状（如 bang/cloud）不在本子集内。
 * - default：纯文本无边框（mermaid 默认）
 * - rect：矩形 [x]；rounded：圆角 (x)；circle：圆形 ((x))；hexagon：六边形 {{x}}
 * 根节点规范形状恒为 circle；paper 节点在 mermaid 中即 [标题](paper:...) 矩形链接。
 */
export type MindmapNodeShape = 'default' | 'rect' | 'rounded' | 'circle' | 'hexagon';

/** 思维导图节点（GUI 与 AI 共用的最小结构单元，v1 限定单根树、无交叉边） */
export interface MindmapNode {
  /** 稳定 ID（n_<8hex>），一律由服务端生成；add_node 传入的 id 仅为批内临时 ID */
  id: string;
  /** 父节点 ID；全图唯一根为 null */
  parentId: string | null;
  /** 同级位置（同父下唯一非负；每批动作提交后服务端规范化为 0..n-1） */
  order: number;
  text: string;
  kind: MindmapNodeKind;
  /**
   * 视觉形状（对应 mermaid 形状语法）。缺省视为 'default'（旧文档无此字段）；
   * 根节点序列化为 circle；paper 节点渲染时恒按矩形卡片处理。
   */
  shape?: MindmapNodeShape;
  /** kind=paper 时必填且形如 source:external_id；topic 时必须为 null */
  paperId: string | null;
  /** 几何坐标：mermaid 不表达几何；手动拖拽写回，未布局节点为 0 由前端布局引擎补位 */
  x: number;
  y: number;
  /** 折叠分支：为 true 时画布隐藏其子树 */
  collapsed?: boolean;
}

/**
 * 导图文档（mindmaps.doc 列存储的 JSON）。
 * - mindmap 类型：diagramType 缺省/'mindmap'，nodes 为节点树，源码由树序列化派生；
 * - 其他 mermaid 图（flowchart/sequenceDiagram/…）：nodes 为空，diagramType 为
 *   mermaid 首声明 token，source 为原始源码，画布只读渲染（不可结构化编辑）。
 */
export interface MindmapDoc {
  nodes: MindmapNode[];
  diagramType?: string;
  /** 非 mindmap 图的 mermaid 源码；mindmap 类型缺省 */
  source?: string | null;
}

/** 导图元信息（列表项，不含 nodes/source） */
export interface MindmapMeta {
  id: string;
  /** 作用域：''=全局；'ws:<工作区id>'=工作区。由后端归一化，前端只透传 workspace_id */
  scope: string;
  title: string;
  version: number;
  /** 图类型：'mindmap' 或 mermaid 首声明 token（flowchart/sequenceDiagram/…） */
  diagramType: string;
  created_at: string | null;
  updated_at: string | null;
}

/** 导图完整文档（后端 _serialize 将 doc.nodes/diagramType/source 展开到顶层） */
export interface MindmapInfo extends MindmapMeta {
  nodes: MindmapNode[];
  /** 非 mindmap 图的 mermaid 源码；mindmap 类型为 null */
  source: string | null;
}

/** 删除节点策略：promote=直系孩子上提（默认）；delete_branch=整支删除 */
export type MindmapDeleteStrategy = 'promote' | 'delete_branch';

/**
 * 结构化编辑动作（POST /mindmaps/<id>/actions 的 actions[] 元素）。
 * 一批动作顺序应用到服务端深拷贝上，任一非法即整批拒绝（无半截写入）。
 * 临时 ID：add_node 可带 id（批内引用用），正式 ID 经响应 idMap 回填。
 */
export type MindmapAction =
  | {
      op: 'add_node';
      /** 客户端临时 ID（可选）；同批后续动作可用它引用新节点 */
      id?: string;
      /** 父节点 ID；null 仅在图为空、添加唯一根时合法 */
      parentId: string | null;
      text?: string;
      kind?: MindmapNodeKind;
      shape?: MindmapNodeShape;
      paperId?: string | null;
      x?: number;
      y?: number;
      /** 缺省追加到同父末尾 */
      order?: number;
    }
  | {
      op: 'update_node';
      id: string;
      text?: string;
      kind?: MindmapNodeKind;
      shape?: MindmapNodeShape;
      paperId?: string | null;
      x?: number;
      y?: number;
      collapsed?: boolean;
    }
  | { op: 'move_node'; id: string; newParentId: string; newOrder?: number }
  | { op: 'delete_node'; id: string; strategy?: MindmapDeleteStrategy }
  | { op: 'set_collapsed'; id: string; collapsed: boolean }
  | { op: 'attach_paper'; id: string; paperId: string };

/** POST /actions 成功响应 */
export interface MindmapActionsResult {
  mindmap: MindmapInfo;
  /** 客户端临时 ID → 服务端正式 ID 映射 */
  idMap: Record<string, string>;
}

/** POST /undo-ai 的字段级逆向统计（后端 mindmap_undo.revert_transaction） */
export interface MindmapUndoStats {
  /** 事务新增、当前仍存活而被移除的节点数 */
  removed: number;
  /** 事务删除而被重建的节点数 */
  restored: number;
  /** 恢复的字段数（current 仍等于事务末值才恢复） */
  fields_restored: number;
  /** 因用户后续修改而跳过的字段数 */
  fields_skipped: number;
}

/** POST /undo-ai 响应 */
export interface MindmapUndoResult {
  mindmap: MindmapInfo;
  stats: MindmapUndoStats;
  transactionId: string;
}

/**
 * SSE mindmap_diff 事件（RAG 流中 AI 编辑导图的实时推送，Task 11 接入）。
 * 前端收到后与本地编辑走同一动作应用函数，实现画布无刷新增量更新。
 */
export interface MindmapDiffEvent {
  mapId: string;
  /** AI 提交后的服务端新版本号 */
  version: number;
  actions: MindmapAction[];
  idMap: Record<string, string>;
  /** 同一次问答共享一个 transactionId，是整事务撤销的单位 */
  transactionId: string;
}

/** AI 新建导图（可能 from_mermaid 一次成图，之后没有任何 diff） */
export interface MindmapCreatedEvent {
  mapId: string;
  version: number;
  title: string;
  /** 图类型：mindmap（可编辑树）或其他 mermaid 首声明 token（只读视图） */
  diagramType?: string;
}

// ---------- AI 写作工具组（边写边审 / 一问一事务回滚） ----------
/** 修订动作类型：edit=锚点替换；input=main.tex 接线（\\input/\\bibliography 等）；
 *  append=.bib 整块追加；create=新建整文件 */
export type WritingRevisionKind = 'edit' | 'input' | 'append' | 'create';

/** 修订状态：pending 待审 / accepted 已接受 / rejected 已逐块拒绝 /
 *  reverted 已随事务回滚 / stale 锚点失效 */
export type WritingRevisionStatus =
  | 'pending' | 'accepted' | 'rejected' | 'reverted' | 'stale';

/** GET /writing/revisions 返回的待审修订（跨刷新对账） */
export interface WritingRevision {
  id: number;
  runId: string;
  transactionId: string;
  /** 事务内顺序（跨文件连续，回滚按其逆序） */
  seq: number;
  kind: WritingRevisionKind;
  /** 工作区相对路径（POSIX） */
  path: string;
  /** 被替换/删除的旧文本（create/append 为空串） */
  oldText: string;
  /** 新写入的文本（create 为整个文件内容，append 为追加块） */
  newText: string;
  baseHash: string;
  newHash: string;
  status: WritingRevisionStatus;
  createdAt: string;
}

/** SSE document_diff 事件中的单个审核块（比 REST 行多了实时行号位置） */
export interface WritingHunk {
  id: number;
  kind: WritingRevisionKind;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  oldText: string;
  newText: string;
}

/** SSE document_diff：AI 对某文件落盘了一批可逐块审核的修改 */
export interface WritingDiffEvent {
  kind: 'diff';
  path: string;
  transactionId: string;
  hunks: WritingHunk[];
  /** 修改后文件 hash（LF 归一化） */
  newHash: string;
}

/** SSE document_created：AI 新建了文件（刷新文件树） */
export interface WritingCreatedEvent {
  kind: 'created';
  path: string;
  transactionId: string;
}

/** LaTeX 编译错误（后端 parse_log_errors 解析 main.log） */
export interface WritingCompileError {
  file: string;
  /** 1 基行号；无法解析时为 0/null */
  line: number | null;
  kind: 'error';
  text: string;
}

/** SSE compile_result：AI 调 compile_document 的真实编译结果 */
export interface WritingCompileEvent {
  kind: 'compile';
  ok: boolean;
  errors: WritingCompileError[];
  message: string;
}

/** POST /writing/hunks/<id>/reject 响应（文本类还原返回新内容；create 返回 deleted） */
export interface WritingRejectResult {
  ok: boolean;
  revId: number;
  status: 'rejected';
  file: { path: string; content: string; hash: string } | null;
  deleted: string | null;
}

/** POST /writing/transactions/<txn>/accept 响应 */
export interface WritingAcceptTxnResult {
  ok: boolean;
  transactionId: string;
  count: number;
}

/** POST /writing/transactions/<txn>/rollback 响应（409 冲突时同结构 + error） */
export interface WritingRollbackResult {
  ok: boolean;
  transactionId: string;
  /** 实际物理还原的修订数 */
  count: number;
  /** 被还原的文本文件（含最新内容，编辑器直接替换缓冲区） */
  files: { path: string; content: string; hash: string }[];
  /** 被删除的新建文件路径 */
  deleted: string[];
  /** 创建后又被修改而保留的文件路径（未删除，需用户手动处理） */
  kept: string[];
  /** 冲突时的已本地化错误文案（HTTP 409） */
  error?: string;
  processedCount?: number;
}

/** 一次回答中 AI 写作事务的消息挂载（回答卡片上的「全部接受 / 撤销本次写作」） */
export interface ChatWritingEdit {
  transactionId: string;
  /** 编辑发生时的工作区 id */
  workspaceId?: string | null;
  /** 已全部接受（消标记） */
  accepted?: boolean;
  /** 已整事务回滚 */
  undone?: boolean;
}
