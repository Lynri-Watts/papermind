import { Paper, SearchResponse, SearchSourceStatus, RagQueryRequest, RagQueryResponse, RagSource, GraphResponse, Note, ContextItem, ReactActionEvent, ReactObservationEvent, ToolPaper, WorkspaceInfo, WorkspaceFile, SettingsSnapshot, SettingsUpdate, SettingsTestResult } from '../types';
import i18n, { normalizeLanguage } from '../i18n';

// 后端 API 网关地址（Flask，见 backend/app.py）
export const API_BASE = 'http://127.0.0.1:5001/api';

/** 当前界面语言的 BCP-47 短码（zh/en），用于 Accept-Language 请求头。
 * 后端据此决定错误提示、设置保存/测试等文案的语言（见 backend/i18n.py）。 */
function currentLanguage(): string {
  return normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': currentLanguage(),
      ...(options?.headers as Record<string, string> | undefined),
    },
  });
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.error) message = body.error;
    } catch {
      // 非 JSON 错误体，保留默认消息
    }
    throw new Error(message);
  }
  return resp.json() as Promise<T>;
}

/** 后端原始论文记录 */
interface RawPaper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  source: string;
  external_id: string;
  url: string;
  pdf_url: string | null;
  citation_count: number | null;
  reference_count: number | null;
  publication_venue: string | null;
  doi: string | null;
}

/** 将后端论文记录映射为前端 Paper（派生渲染兼容字段）。 */
function toPaper(raw: RawPaper): Paper {
  const venue = raw.publication_venue || '';
  return {
    id: raw.id,
    title: raw.title,
    authors: raw.authors || [],
    year: raw.year || 0,
    abstract: raw.abstract || '',
    source: raw.source,
    external_id: raw.external_id,
    url: raw.url,
    pdf_url: raw.pdf_url,
    citation_count: raw.citation_count,
    reference_count: raw.reference_count,
    publication_venue: venue,
    doi: raw.doi,
    // 派生字段
    journal: venue,
    conference: venue || 'Unknown',
    citations: raw.citation_count || 0,
    pdfUrl: raw.pdf_url || '',
    keywords: [],
  };
}

export const searchPapers = async (query: string, page: number = 1, limit: number = 10): Promise<SearchResponse> => {
  const q = encodeURIComponent(query.trim() || '*');
  const data = await request<{ provider: string; papers: RawPaper[] }>(
    `/search?q=${q}&limit=${limit}`
  );
  const papers = data.papers.map(toPaper);
  return {
    papers,
    total: papers.length,
    page,
    limit,
    provider: data.provider,
  };
};

export const getPaperById = async (id: string): Promise<Paper | undefined> => {
  const raw = await request<RawPaper>(`/paper/${encodeURIComponent(id)}`);
  return toPaper(raw);
};

/** 结构化多字段搜索参数（对应后端 /api/search 的字段化检索） */
export interface StructuredSearchParams {
  /** 主关键词（快速搜索，走后端 q 参数） */
  q?: string;
  title?: string;
  abstract?: string;
  keywords?: string;
  author?: string;
  fulltext?: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  /** 数据源筛选（semantic_scholar/openalex/arxiv/core；空/缺省 = 全部已启用数据源按优先级聚合） */
  sources?: string[];
}

/**
 * 结构化多字段搜索：任一结构化字段（title/abstract/keywords/author/fulltext/年份）
 * 存在即走后端字段化检索（跨数据源），否则退化为关键词搜索。
 */
export const searchPapersStructured = async (
  params: StructuredSearchParams,
  limit: number = 12
): Promise<SearchResponse> => {
  const searchParams = new URLSearchParams();
  const push = (key: string, value: string | number | null | undefined) => {
    const v = value === null || value === undefined ? '' : String(value).trim();
    if (v !== '') searchParams.set(key, v);
  };
  push('q', params.q);
  push('title', params.title);
  push('abstract', params.abstract);
  push('keywords', params.keywords);
  push('author', params.author);
  push('fulltext', params.fulltext);
  push('year_from', params.yearFrom);
  push('year_to', params.yearTo);
  if (params.sources && params.sources.length > 0) {
    // 单一数据源请求也以逗号分隔串传输（后端同时兼容重复参数）
    searchParams.set('sources', params.sources.filter(Boolean).join(','));
  }
  searchParams.set('limit', String(limit));

  const data = await request<{ provider: string; sources?: SearchSourceStatus[]; papers: RawPaper[] }>(
    `/search?${searchParams.toString()}`
  );
  const papers = data.papers.map(toPaper);
  return {
    papers,
    total: papers.length,
    page: 1,
    limit,
    provider: data.provider,
    sources: data.sources ?? [],
  };
};

export const getGraphData = async (): Promise<GraphResponse> => {
  // 知识图谱后端暂未实现（待开发），不返回 mock 数据
  return { nodes: [], edges: [] };
};

/** 论文 PDF 二进制流的 URL（供 PDF.js 渲染；需先调用 pdfReady 确保后端已缓存） */
export const getPdfUrl = (paperId: string): string =>
  `${API_BASE}/paper/${encodeURIComponent(paperId)}/pdf`;

/** PDF 探测结果：ok=后端已缓存/可取到；reason=取不到时的具体原因（403/无全文/网络失败等） */
export interface PdfReadyResult {
  ok: boolean;
  reason?: string;
}

/**
 * 探测后端是否已有该论文的 PDF（未命中则触发后端下载缓存）。
 *
 * 用 Range 请求只取首个字节，既能触发后端的下载/缓存逻辑，又避免整份传输；
 * 失败时读取后端 JSON 错误体里的具体原因（如"PDF 访问受限（需要登录或订阅权限）"），
 * 而不是笼统报"无法获取 PDF"。
 */
export const ensurePdfReady = async (paperId: string): Promise<PdfReadyResult> => {
  const resp = await fetch(getPdfUrl(paperId), {
    headers: { Range: 'bytes=0-0', 'Accept-Language': currentLanguage() },
  });
  if (resp.ok || resp.status === 206) return { ok: true };
  let reason: string | undefined;
  try {
    const body = await resp.json();
    if (body?.error) reason = String(body.error);
  } catch {
    // 非 JSON 错误体：无具体原因
  }
  return { ok: false, reason: reason ?? `HTTP ${resp.status}` };
};

export interface RagStreamHandlers {
  /** 中间过程阶段更新（如"正在检索相关内容..."） */
  onStage?: (label: string) => void;
  /** ReAct 思考增量（Thought）：逐段实时展示 AI 在想什么 */
  onThought?: (delta: string) => void;
  /** ReAct 动作（Action）：AI 决定自动执行某个工具 */
  onAction?: (action: ReactActionEvent) => void;
  /** ReAct 观察（Observation）：工具执行结果（自动执行，无需确认） */
  onObservation?: (obs: ReactObservationEvent) => void;
  /** 回答文本增量（逐段追加显示） */
  onDelta?: (delta: string) => void;
  /** 生成完成（携带最终回答与出处） */
  onDone?: (result: RagQueryResponse) => void;
  /** 流中途出错（后端以 SSE error 事件上报） */
  onError?: (message: string) => void;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function parseRagSseFrame(frame: string, handlers: RagStreamHandlers): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim();
    else if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    // 非 JSON 帧忽略
    return;
  }
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  switch (event) {
    case 'stage':
      handlers.onStage?.(str(payload.label, i18n.t('api:stream.processing')));
      break;
    case 'thought':
      if (payload.delta && typeof payload.delta === 'string') handlers.onThought?.(payload.delta);
      break;
    case 'react_action':
      handlers.onAction?.({
        toolName: str(payload.tool_name),
        toolLabel: str(payload.tool_label, str(payload.tool_name)),
        arguments: asRecord(payload.arguments),
        thought: str(payload.thought),
      });
      break;
    case 'observation':
      handlers.onObservation?.({
        toolName: str(payload.tool_name),
        toolLabel: str(payload.tool_label, str(payload.tool_name)),
        status: payload.status === 'error' ? 'error' : 'done',
        provider: payload.provider == null ? null : String(payload.provider),
        papers: (Array.isArray(payload.papers) ? payload.papers : []) as ToolPaper[],
        toolMessage: str(payload.tool_message),
      });
      break;
    case 'delta':
      if (typeof payload.delta === 'string' && payload.delta) handlers.onDelta?.(payload.delta);
      break;
    case 'done': {
      const sources = (Array.isArray(payload.sources) ? payload.sources : []) as RagSource[];
      handlers.onDone?.({
        answer: str(payload.answer),
        sources: sources.map((s) => s.text),
        sourceDetails: sources,
        confidence: sources.length > 0 ? (sources[0].score ?? 0) : 0,
      });
      break;
    }
    case 'error':
      handlers.onError?.(str(payload.message, i18n.t('api:rag.failed')));
      break;
  }
}

/** 统一解析一条 SSE 流：按 \n\n 切帧并逐帧回调。 */
async function consumeSseStream(resp: Response, handlers: RagStreamHandlers): Promise<void> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error(i18n.t('api:stream.unsupported'));
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // TextDecoder 流式模式保证多字节字符跨 chunk 不截断
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) parseRagSseFrame(frame, handlers);
  }
  if (buffer.trim()) parseRagSseFrame(buffer, handlers);
}

/** SSE 流式 RAG 问答：自动 ReAct 循环，逐帧解析 /rag/stream 的
 * stage/thought/react_action/observation/delta/done/error 事件（无逐次确认）。 */
export const queryRAGStream = async (
  requestParams: RagQueryRequest,
  handlers: RagStreamHandlers
): Promise<void> => {
  const resp = await fetch(`${API_BASE}/rag/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': currentLanguage() },
    body: JSON.stringify({
      paper_id: requestParams.paperId ?? '',
      question: requestParams.query,
      use_context: requestParams.useContext ?? true,
      enable_tool: requestParams.enableTool ?? true,
      context_ids: requestParams.contextIds ?? [],
      exclude_ids: requestParams.excludeIds ?? [],
      history: requestParams.history ?? [],
      document: requestParams.document ?? '',
      workspace_id: requestParams.workspaceId ?? '',
      run_id: requestParams.runId ?? '',
    }),
  });
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.error) message = body.error;
    } catch {
      // 非 JSON 错误体，保留默认消息
    }
    throw new Error(message);
  }
  await consumeSseStream(resp, handlers);
};

/** 停止正在进行的 ReAct 运行（后端置位后，流会在下一个检查点以 error 事件结束）。 */
export const cancelRagRun = async (runId: string): Promise<void> => {
  await request('/rag/cancel', {
    method: 'POST',
    body: JSON.stringify({ run_id: runId }),
  });
};

interface RawNote {
  id: number;
  paper_id: string;
  content: string;
  created_at: string;
}

function toNote(raw: RawNote): Note {
  return {
    id: String(raw.id),
    paperId: raw.paper_id,
    content: raw.content,
    highlight: '',
    position: { start: 0, end: 0 },
    createdAt: raw.created_at,
  };
}

export const getNotesByPaperId = async (paperId: string): Promise<Note[]> => {
  const data = await request<{ notes: RawNote[] }>(
    `/papers/${encodeURIComponent(paperId)}/notes`
  );
  return data.notes.map(toNote);
};

export const createNote = async (note: Omit<Note, 'id' | 'createdAt'>): Promise<Note> => {
  const data = await request<{ id: number }>(
    `/papers/${encodeURIComponent(note.paperId)}/notes`,
    {
      method: 'POST',
      body: JSON.stringify({ content: note.content }),
    }
  );
  return {
    ...note,
    id: String(data.id),
    createdAt: new Date().toISOString(),
  };
};

export const updateNote = async (id: string, updates: Partial<Note>): Promise<Note> => {
  // 后端当前不提供笔记编辑接口；保留本地语义，抛出明确错误提示
  throw new Error(i18n.t('api:note.editUnsupported'));
};

export const deleteNote = async (id: string): Promise<void> => {
  await request(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

// ---------- 全局/工作区快照（持久化） ----------
// project 传工作区 id（缺省/空串=全局 'default'），由后端映射为 'ws:<id>' 独立存储，
// 实现各工作区页面状态互相隔离。
export const loadState = async (project?: string): Promise<Record<string, unknown>> => {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  const data = await request<{ project_id: string; state: Record<string, unknown> }>(`/state${q}`);
  return data.state;
};

export const saveState = async (state: Record<string, unknown>, project?: string): Promise<void> => {
  await request('/state', {
    method: 'PUT',
    body: JSON.stringify({ state, project }),
  });
};

// ---------- 上下文库 ----------
interface RawContextItem {
  id: number;
  type: 'paper' | 'url';
  title: string;
  summary: string;
  ref_id: string | null;
  url: string | null;
  tags: string[] | string;
  status: string;
  created_at: string;
  /** 后端附加（仅 paper）：available | unavailable | unknown；url 为 null */
  pdf_status?: 'available' | 'unavailable' | 'unknown' | null;
  pdf_error?: string | null;
}

function toContextItem(raw: RawContextItem): ContextItem {
  return {
    id: String(raw.id),
    type: raw.type,
    title: raw.title,
    summary: raw.summary || '',
    source: raw.type === 'url' ? (raw.url || '') : (raw.ref_id || ''),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    status: (raw.status as ContextItem['status']) || 'ready',
    addedAt: raw.created_at,
    paperId: raw.type === 'paper' ? raw.ref_id || undefined : undefined,
    url: raw.type === 'url' ? raw.url || undefined : undefined,
    pdfStatus: raw.type === 'paper' ? (raw.pdf_status ?? 'unknown') : undefined,
    pdfError: raw.type === 'paper' ? (raw.pdf_error ?? null) : undefined,
  };
}

/** 导入论文到上下文库（摘要自动取 abstract，无则 LLM 生成）。
 * summaryOverride 用于 PDF 选中文本存为摘录的场景。
 * workspaceId 指定归属工作区（缺省为全局库）。 */
export const createPaperContext = async (paperId: string, summaryOverride?: string, workspaceId?: string): Promise<ContextItem> => {
  const data = await request<RawContextItem>('/context', {
    method: 'POST',
    body: JSON.stringify({
      type: 'paper',
      paper_id: paperId,
      summary_override: summaryOverride || undefined,
      workspace_id: workspaceId || undefined,
    }),
  });
  return toContextItem(data);
};

/** 导入 URL 到上下文库（抓取网页 + LLM 摘要，无 key 降级截取） */
export const createUrlContext = async (url: string, workspaceId?: string): Promise<ContextItem> => {
  const data = await request<RawContextItem>('/context', {
    method: 'POST',
    body: JSON.stringify({ type: 'url', url, workspace_id: workspaceId || undefined }),
  });
  return toContextItem(data);
};

/** 列出上下文库：workspaceId 指定工作区（缺省=全局库，仅无活跃工作区时使用）。 */
export const listContextItems = async (workspaceId?: string): Promise<ContextItem[]> => {
  const q = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
  const data = await request<{ items: RawContextItem[] }>(`/context${q}`);
  return data.items.map(toContextItem);
};

/** 更新 title / summary / tags（手动编辑摘要与分组） */
export const updateContextItem = async (id: string, updates: Partial<Pick<ContextItem, 'title' | 'summary' | 'tags'>>): Promise<ContextItem> => {
  const data = await request<RawContextItem>(`/context/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  return toContextItem(data);
};

/** 重新生成摘要 / 重新抓取网页 */
export const refreshContextItem = async (id: string): Promise<ContextItem> => {
  const data = await request<RawContextItem>(`/context/${id}/refresh`, { method: 'POST' });
  return toContextItem(data);
};

/**
 * 手动重新尝试获取 paper 上下文的全文/PDF（失败后唯一的重试入口）。
 * 后端无论这次成功与否都返回 200 与最新 pdf_status，由调用方据此更新徽标。
 */
export const retryContextPaperPdf = async (id: string): Promise<ContextItem> => {
  const data = await request<RawContextItem>(`/context/${id}/retry-pdf`, { method: 'POST' });
  return toContextItem(data);
};

export const deleteContextItem = async (id: string): Promise<void> => {
  await request(`/context/${id}`, { method: 'DELETE' });
};

/** 按需获取 context 项全文（前端展开查看用；RAG 在服务端直接拉取） */
export const getContextContent = async (id: string): Promise<{ id: number; type: string; title: string; text: string }> => {
  return request(`/context/${id}/content`);
};

// ---------- 工作区（服务器端受控目录，见 backend/storage/workspace.py） ----------
interface RawWorkspace extends WorkspaceInfo {}

export const listWorkspaces = async (): Promise<WorkspaceInfo[]> => {
  const data = await request<{ workspaces: RawWorkspace[] }>('/workspaces');
  return data.workspaces;
};

export const createWorkspace = async (name: string, description: string = ''): Promise<WorkspaceInfo> => {
  const data = await request<{ workspace: RawWorkspace }>('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
  return data.workspace;
};

export const deleteWorkspace = async (wsId: string): Promise<void> => {
  await request(`/workspaces/${encodeURIComponent(wsId)}`, { method: 'DELETE' });
};

export const listWorkspaceFiles = async (wsId: string): Promise<WorkspaceFile[]> => {
  const data = await request<{ files: WorkspaceFile[] }>(`/workspaces/${encodeURIComponent(wsId)}/files`);
  return data.files;
};

/** 上传文件到工作区（multipart）；PDF 上传后返回的 paper_id 即本地文献 id。 */
export const uploadWorkspaceFile = async (wsId: string, file: File): Promise<WorkspaceFile> => {
  const form = new FormData();
  form.append('file', file);
  const resp = await fetch(`${API_BASE}/workspaces/${encodeURIComponent(wsId)}/files`, {
    method: 'POST',
    headers: { 'Accept-Language': currentLanguage() },
    body: form,
  });
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.error) message = body.error;
    } catch {
      // 非 JSON 错误体，保留默认消息
    }
    throw new Error(message);
  }
  const data = await resp.json();
  return data.file as WorkspaceFile;
};

/** 读取工作区文本文件（.tex/.bib/.txt/.md）内容 */
export const readWorkspaceText = async (wsId: string, path: string): Promise<string> => {
  const data = await request<{ path: string; content: string }>(
    `/workspaces/${encodeURIComponent(wsId)}/files/${encodeURIComponent(path)}?text=1`
  );
  return data.content;
};

/** 写入工作区文本文件 */
export const writeWorkspaceText = async (wsId: string, path: string, content: string): Promise<WorkspaceFile> => {
  const data = await request<{ file: WorkspaceFile }>(
    `/workspaces/${encodeURIComponent(wsId)}/files/${encodeURIComponent(path)}`,
    { method: 'PUT', body: JSON.stringify({ content }) }
  );
  return data.file;
};

export const deleteWorkspaceFile = async (wsId: string, path: string): Promise<void> => {
  await request(`/workspaces/${encodeURIComponent(wsId)}/files/${encodeURIComponent(path)}`, { method: 'DELETE' });
};

/** 读取当前写作文件（main.tex）；不存在返回空串 */
export const readLatexFile = async (wsId: string): Promise<string> => {
  const data = await request<{ content: string }>(`/workspaces/${encodeURIComponent(wsId)}/latex`);
  return data.content;
};

/** 保存当前写作文件（main.tex） */
export const saveLatexFile = async (wsId: string, content: string): Promise<void> => {
  await request(`/workspaces/${encodeURIComponent(wsId)}/latex`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
};

// ---------- 设置（数据源与 LLM 服务，见 backend/routes/settings.py） ----------
/** 读取当前设置（密钥只回掩码与"是否已配置"，绝不回明文） */
export const getSettings = async (): Promise<SettingsSnapshot> => {
  return request<SettingsSnapshot>('/settings');
};

/** 保存设置（写入 backend/.env 并立即生效，无需重启后端） */
export const updateSettings = async (payload: SettingsUpdate): Promise<SettingsSnapshot> => {
  return request<SettingsSnapshot>('/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
};

/** 连通性测试：target='llm' 或数据源 id（失败属被测对象结果，返回 ok=false） */
export const testSettingConnection = async (target: string): Promise<SettingsTestResult> => {
  return request<SettingsTestResult>('/settings/test', {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
};
