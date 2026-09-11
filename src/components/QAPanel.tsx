import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageCircle, Send, BookOpen, RefreshCw, Check, FileText, Plus, X,
  Globe, BarChart3, Table, TrendingUp, FileImage, Sigma,
  ExternalLink, Sparkles, Search, Settings2, ChevronLeft, ChevronRight, Square,
} from 'lucide-react';
import { queryRAGStream, cancelRagRun, RagStreamHandlers } from '../api';
import { ChatMessage, ContextItem, DataBlock, ReactStep, ToolPaper } from '../types';
import { usePaperMindStore } from '../store';
import { addPaperContextItem, isPaperInContext } from '../lib/context';
import AssistantMessage from '../components/AssistantMessage';
import AddContextModal from '../components/AddContextModal';
import ContextItemCard from '../components/ContextItemCard';
import ResizableDivider from '../components/ResizableDivider';

/**
 * 全局 AI 助手面板：阅读 / 搜索 / 写作三大板块共用同一个问答系统。
 * - Q&A：ReAct 流式问答（AI 自动思考→调用工具→观察结果，步骤实时流式输出、
 *   完成后折叠进聊天记录；可随时停止）+ 引用定位（转发给阅读器）
 * - Context：上下文库管理（摘要/标签/插入论文）
 * - Data：数据块（图表/表格/公式/图片）插入论文
 * 当前焦点随所在板块自动变化：
 *   - 阅读视图：当前激活的论文标签作为"当前论文"候选（id=0）
 *   - 写作视图：携带当前 LaTeX 全文作为 document，AI 可经 read_document 工具主动读取
 *   - 搜索视图：仅基于上下文库 + 外部检索作答
 */
const QAPanel: React.FC = () => {
  // 命名单一命名空间 'qa'，本域键写相对路径（t('tab.qa')）；跨命名空间用冒号（t('common:action.clear')）。
  const { t } = useTranslation('qa');
  // ---- 面板开关 ----
  const qaPanelOpen = usePaperMindStore((s) => s.qaPanelOpen);
  const setQaPanelOpen = usePaperMindStore((s) => s.setQaPanelOpen);
  // ---- 面板宽度（可拖拽调整，持久化） ----
  const qaPanelWidth = usePaperMindStore((s) => s.qaPanelWidth);
  const setQaPanelWidth = usePaperMindStore((s) => s.setQaPanelWidth);
  // ---- 全局问答控制（持久化） ----
  const useContext = usePaperMindStore((s) => s.useContext);
  const setUseContext = usePaperMindStore((s) => s.setUseContext);
  const toolEnabled = usePaperMindStore((s) => s.toolEnabled);
  const setToolEnabled = usePaperMindStore((s) => s.setToolEnabled);
  const pinnedCtxIds = usePaperMindStore((s) => s.pinnedCtxIds);
  const setPinnedCtxIds = usePaperMindStore((s) => s.setPinnedCtxIds);
  const excludedCtxIds = usePaperMindStore((s) => s.excludedCtxIds);
  const setExcludedCtxIds = usePaperMindStore((s) => s.setExcludedCtxIds);
  // ---- 跨组件通信 ----
  const qaInputDraft = usePaperMindStore((s) => s.qaInputDraft);
  const setQaInputDraft = usePaperMindStore((s) => s.setQaInputDraft);
  const requestPdfLocate = usePaperMindStore((s) => s.requestPdfLocate);
  // ---- 当前焦点（板块 + 论文/文档） ----
  const currentView = usePaperMindStore((s) => s.currentView);
  const setCurrentView = usePaperMindStore((s) => s.setCurrentView);
  const readerTabs = usePaperMindStore((s) => s.readerTabs);
  const activeTabId = usePaperMindStore((s) => s.activeTabId);
  const openReaderTab = usePaperMindStore((s) => s.openReaderTab);
  const latexContent = usePaperMindStore((s) => s.latexContent);
  // ---- 问答会话 ----
  const chatMessages = usePaperMindStore((s) => s.chatMessages);
  const addChatMessage = usePaperMindStore((s) => s.addChatMessage);
  const updateChatMessage = usePaperMindStore((s) => s.updateChatMessage);
  const clearChatMessages = usePaperMindStore((s) => s.clearChatMessages);
  // ---- 上下文库 ----
  const contextItems = usePaperMindStore((s) => s.contextItems);
  const addContextItem = usePaperMindStore((s) => s.addContextItem);
  const removeContextItem = usePaperMindStore((s) => s.removeContextItem);
  const patchContextItem = usePaperMindStore((s) => s.patchContextItem);
  const addContextToLatex = usePaperMindStore((s) => s.addContextToLatex);
  // ---- 数据块 ----
  const dataBlocks = usePaperMindStore((s) => s.dataBlocks);
  const addDataBlockToLatex = usePaperMindStore((s) => s.addDataBlockToLatex);

  const [activeTab, setActiveTab] = useState<'qa' | 'context' | 'data'>('qa');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamStage, setStreamStage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showCtxSelector, setShowCtxSelector] = useState(false);
  const [showAddContextModal, setShowAddContextModal] = useState(false);
  const [ctxTagFilter, setCtxTagFilter] = useState<string | null>(null);
  const [addingBlockId, setAddingBlockId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ show: boolean; message: string; type: 'success' | 'error' }>({
    show: false,
    message: '',
    type: 'success',
  });

  // 当前焦点论文：仅阅读视图下取激活标签（写作/搜索视图无"当前论文"）
  const paperId = currentView === 'research' ? (activeTabId ?? '') : '';
  const focusPaperTitle = currentView === 'research'
    ? (readerTabs.find((t) => t.paperId === activeTabId)?.title ?? '')
    : '';

  // 上下文库全部标签（Context 页分组筛选）
  const ctxAllTags: string[] = Array.from(new Set(contextItems.flatMap((i) => i.tags)));

  const showNotification = useCallback((message: string, type: 'success' | 'error') => {
    setNotification({ show: true, message, type });
    setTimeout(() => {
      setNotification({ show: false, message: '', type: 'success' });
    }, 2500);
  }, []);

  // ---------- 阅读器选中文本发起的提问：填充输入框并自动发送 ----------
  useEffect(() => {
    const text = qaInputDraft.trim();
    if (!text) return;
    setQaInputDraft('');
    setActiveTab('qa');
    setQaPanelOpen(true);
    setInput(text);
    setTimeout(() => {
      handleSubmitWithText(text);
    }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qaInputDraft]);

  // ---------- ReAct 自动运行（AI 自主思考→调用工具→观察，无逐次确认） ----------
  /** 正在运行的 run_id（生成中持有一份，供"停止"按钮取消） */
  const activeRunIdRef = useRef<string | null>(null);

  /**
   * 自动 ReAct 流式问答：把后端 SSE 的 thought/react_action/observation 增量实时
   * 累积为 trail（步骤逐个流式展开），在阶段边界收尾纯思考步骤；结束后折叠为 toolLog。
   */
  const runReActAnswer = useCallback(async (
    assistantId: string,
    runId: string,
    requestFn: (handlers: RagStreamHandlers) => Promise<void>,
  ) => {
    activeRunIdRef.current = runId;
    let cancelling = false;
    updateChatMessage(assistantId, {
      streaming: true,
      toolCall: { runId, steps: [], cancelling: false },
    });
    setLoading(true);
    setStreamStage(t('stage.connecting'));

    let answerText = '';
    let trail: ReactStep[] = [];
    let openIndex = -1; // 当前正在接收 Thought 增量的步骤（-1=无开放步骤）
    let seq = 0;

    const isOpen = (i: number) => i >= 0 && i < trail.length;
    const openStep = (): ReactStep => {
      if (!isOpen(openIndex)) {
        openIndex = trail.length;
        trail.push({ id: `react${Date.now()}_${++seq}`, status: 'thinking', thought: '' });
      }
      return trail[openIndex];
    };
    const sync = () => updateChatMessage(assistantId, {
      toolCall: { runId, steps: trail.map((s) => ({ ...s })), cancelling },
    });
    /** 把当前"纯思考"步骤收尾为终态（空思考直接丢弃）：供阶段切换边界调用 */
    const flushThinking = () => {
      if (!isOpen(openIndex) || trail[openIndex].status !== 'thinking') return;
      const step = trail[openIndex];
      if (!(step.thought ?? '').trim()) {
        trail.splice(openIndex, 1);
        openIndex = -1;
        return;
      }
      step.status = 'done';
      step.executedAt = new Date().toISOString();
      openIndex = -1;
    };
    /** 整轮结束：把仍开放（思考中/运行中）的步骤收敛为终态 */
    const finalizeTrail = () => {
      if (!isOpen(openIndex)) return;
      const step = trail[openIndex];
      if (step.status === 'running') {
        step.status = 'error';
        step.observation = cancelling ? t('step.stoppedNoResult') : t('step.interruptedNoResult');
      } else if (step.status === 'thinking') {
        step.status = 'done';
      }
      step.executedAt = new Date().toISOString();
      openIndex = -1;
    };
    /** 收尾并落盘：折叠进 toolLog（仅保留有内容的步骤），清空实时轨迹 */
    const commit = () => {
      finalizeTrail();
      const logs = trail.filter((s) => (s.thought ?? '').trim() || s.toolName);
      updateChatMessage(assistantId, {
        toolLog: logs.length > 0 ? logs : undefined,
        toolCall: undefined,
      });
    };

    try {
      await requestFn({
        onStage: (label) => {
          setStreamStage(label);
          // 阶段切换（材料判断 / 每轮思考 / 检索回答）：先把上一段纯思考收尾，
          // 保证后续思考开新步骤（工具运行中 emitted 的读取进度 stage 不影响 running 步骤）
          flushThinking();
        },
        onThought: (delta) => {
          const step = openStep();
          step.thought = (step.thought ?? '') + delta;
          sync();
        },
        onAction: (action) => {
          // 当前开放步骤往往就是该动作的思考，直接落上动作信息转为 running
          const step = openStep();
          step.status = 'running';
          step.toolName = action.toolName;
          step.toolLabel = action.toolLabel;
          step.arguments = action.arguments;
          if (!(step.thought ?? '').trim() && action.thought) step.thought = action.thought;
          sync();
        },
        onObservation: (obs) => {
          const idx = isOpen(openIndex) && trail[openIndex].status === 'running'
            ? openIndex
            : trail.findIndex((s) => s.status === 'running' && s.toolName === obs.toolName);
          if (idx >= 0) {
            const step = trail[idx];
            step.status = obs.status;
            step.observation = obs.toolMessage
              || (obs.status === 'error' ? t('step.execFailed', { tool: obs.toolLabel }) : undefined);
            step.provider = obs.provider;
            step.papers = obs.papers?.length ? obs.papers : undefined;
            step.executedAt = new Date().toISOString();
          } else if (isOpen(openIndex) && trail[openIndex].status === 'thinking') {
            // 观察落到一个尚未动作化的思考步骤上（如判断材料失败即返回 error）：
            // 直接把结果挂到该思考步骤并关闭，避免遗留"思考中"的悬空卡
            const step = trail[openIndex];
            step.status = obs.status;
            step.observation = obs.toolMessage
              || (obs.status === 'error' ? t('step.failed', { tool: obs.toolLabel }) : undefined);
            step.provider = obs.provider;
            step.papers = obs.papers?.length ? obs.papers : undefined;
            step.executedAt = new Date().toISOString();
          }
          openIndex = -1;
          sync();
        },
        onDelta: (delta) => {
          answerText += delta;
          updateChatMessage(assistantId, { content: answerText });
        },
        onDone: (result) => {
          commit();
          updateChatMessage(assistantId, {
            content: answerText || result.answer,
            sources: result.sources,
            sourceDetails: result.sourceDetails,
            streaming: false,
          });
        },
        onError: (message) => {
          commit();
          updateChatMessage(assistantId, {
            content: answerText || t('error.ragFailedWith', { message }),
            streaming: false,
          });
        },
      });
    } catch (error) {
      commit();
      const message = error instanceof Error
        ? (error.message.includes('请先') ? error.message : t('error.ragFailedWith', { message: error.message }))
        : t('error.ragFailed');
      updateChatMessage(assistantId, {
        content: answerText || message,
        streaming: false,
      });
    } finally {
      if (activeRunIdRef.current === runId) activeRunIdRef.current = null;
      setLoading(false);
      setStreamStage(null);
    }
  }, [updateChatMessage, t]);

  /** 停止当前 ReAct 运行：通知后端 + 标记正在停止（流在下一检查点结束） */
  const handleStopStream = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    activeRunIdRef.current = null;
    const msgs = usePaperMindStore.getState().chatMessages;
    const msg = msgs.find((m) => m.toolCall?.runId === runId);
    if (msg?.toolCall) {
      updateChatMessage(msg.id, { toolCall: { ...msg.toolCall, cancelling: true } });
    }
    try {
      await cancelRagRun(runId);
    } catch {
      // 取消通知失败不影响界面：后端流仍会在超时/结束后清理
    }
  }, [updateChatMessage]);

  const handleAddToolPaperToContext = useCallback(async (paper: ToolPaper) => {
    try {
      // 上下文库按工作区隔离：归属当前活跃工作区
      const item = await addPaperContextItem(
        paper.id,
        usePaperMindStore.getState().activeWorkspaceId ?? undefined,
      );
      showNotification(t('notice.addedToContextWithTitle', { title: item.title }), 'success');
    } catch (e) {
      showNotification(e instanceof Error ? e.message : t('error.addContextFailed'), 'error');
    }
  }, [showNotification, t]);

  const handleOpenToolPaper = useCallback((paper: ToolPaper) => {
    openReaderTab(paper.id, paper.title || t('label.paper'));
    setCurrentView('research');
    showNotification(t('notice.openedInReader', { title: paper.title }), 'success');
  }, [openReaderTab, setCurrentView, showNotification, t]);

  // ---------- 引用定位：发出全局请求，由阅读器消费 ----------
  const handleOpenSource = useCallback((sourceIndex: number, msg: ChatMessage) => {
    if (!msg.sourceDetails) return;
    const src = msg.sourceDetails.find((s) => s.index === sourceIndex);
    if (!src || !src.paper_id || !src.text) return;
    openReaderTab(src.paper_id, src.label || t('label.paper'));
    setCurrentView('research');
    requestPdfLocate(src.paper_id, src.text);
  }, [openReaderTab, setCurrentView, requestPdfLocate, t]);

  // ---------- 显式文本提交（ReAct 自动流式：思考/动作/观察/回答 一体化输出） ----------
  /** 阅读焦点自动入上下文库：仅阅读视图存在当前论文时生效。
   * 幂等（本地 store 已收录则跳过；后端 /context 亦按 ref_id 判重）。
   * 先于问答请求完成，确保后端在同一请求读取全文时该论文已是"受管收藏"（全文可落库）。 */
  const ensureReadingFocusInContext = async () => {
    if (!paperId) return;
    if (isPaperInContext(paperId)) return;
    try {
      await addPaperContextItem(
        paperId,
        usePaperMindStore.getState().activeWorkspaceId ?? undefined,
      );
    } catch (e) {
      // 自动收录失败不阻断问答：仅当次失去"全文落库"资格，不影响提问
      console.warn('阅读焦点自动加入上下文失败（不影响本次问答）:', e);
    }
  };

  const handleSubmitWithText = async (query: string) => {
    if (!query.trim()) return;
    await ensureReadingFocusInContext();
    // 精简历史：仅取之前的 user/assistant 文字（不含全文与出处详情）
    const history = chatMessages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim())
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.trim().slice(0, 1500) }))
      .slice(-6);
    const userMessage: ChatMessage = {
      id: `u${Date.now()}`,
      content: query,
      role: 'user',
      timestamp: new Date().toISOString(),
    };
    addChatMessage(userMessage);
    setInput('');
    const assistantId = `a${Date.now()}`;
    const runId = (crypto.randomUUID?.() ?? `rag${Date.now()}_${Math.random().toString(36).slice(2)}`);
    addChatMessage({
      id: assistantId,
      content: '',
      role: 'assistant',
      timestamp: new Date().toISOString(),
      streaming: true,
      toolCall: { runId, steps: [], cancelling: false },
    });
    await runReActAnswer(assistantId, runId, (handlers) =>
      queryRAGStream(
        {
          paperId: paperId || undefined,
          query,
          useContext,
          enableTool: toolEnabled,
          contextIds: pinnedCtxIds,
          excludeIds: excludedCtxIds,
          history,
          // 写作视图：携带当前 LaTeX 全文，AI 可经 read_document 工具主动读取（不随提问注入）
          document: currentView === 'workspace' ? latexContent : '',
          // 上下文库按工作区隔离：RAG 只检索当前工作区的上下文
          workspaceId: usePaperMindStore.getState().activeWorkspaceId ?? undefined,
          runId,
        },
        handlers
      )
    );
  };

  const handleSubmit = async () => {
    if (!input.trim()) return;
    await handleSubmitWithText(input);
  };

  const handleCopy = async (messageId: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedId(messageId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // ---------- 上下文库操作 ----------
  const handleContextAdded = (item: ContextItem) => {
    addContextItem(item);
    showNotification(t('notice.addedToContext'), 'success');
  };

  const handleContextChanged = (item: ContextItem) => {
    patchContextItem(item.id, item);
  };

  const handleContextDelete = (id: string) => {
    removeContextItem(id);
  };

  const handleInsertContextToPaper = (item: ContextItem) => {
    const result = addContextToLatex(item.title, item.summary);
    showNotification(result.success ? t('notice.contextInserted') : result.message, result.success ? 'success' : 'error');
    if (result.success) {
      setTimeout(() => setCurrentView('workspace'), 800);
    }
  };

  /** 把上下文库中的论文转移到阅读器：复用与 Explore 相同的打开链路
   *  （openReaderTab 持久化标签 → 切到研究视图，DeepResearch 挂载时自动恢复） */
  const handleOpenContextInReader = useCallback((item: ContextItem) => {
    if (!item.paperId) return;
    openReaderTab(item.paperId, item.title);
    setCurrentView('research');
  }, [openReaderTab, setCurrentView]);

  // ---------- 数据块操作 ----------
  const handleAddToPaper = (blockId: string) => {
    setAddingBlockId(blockId);
    setTimeout(() => {
      const result = addDataBlockToLatex(blockId);
      setAddingBlockId(null);
      if (result.success) {
        const block = dataBlocks.find((b) => b.id === blockId);
        showNotification(t('notice.dataBlockAdded', { type: block ? getBlockTypeLabel(block.type) : '' }), 'success');
        setTimeout(() => {
          setCurrentView('workspace');
        }, 800);
      } else {
        showNotification(result.message, 'error');
      }
    }, 600);
  };

  const getBlockIcon = (type: DataBlock['type']) => {
    switch (type) {
      case 'chart': return <BarChart3 className="w-4 h-4 text-primary" />;
      case 'table': return <Table className="w-4 h-4 text-secondary" />;
      case 'equation': return <Sigma className="w-4 h-4 text-accent" />;
      case 'figure': return <FileImage className="w-4 h-4 text-purple-400" />;
      default: return <BarChart3 className="w-4 h-4 text-primary" />;
    }
  };

  const getBlockTypeLabel = (type: DataBlock['type']) => {
    switch (type) {
      case 'chart': return t('data.blockType.chart');
      case 'table': return t('data.blockType.table');
      case 'equation': return t('data.blockType.equation');
      case 'figure': return t('data.blockType.figure');
      default: return t('data.blockType.data');
    }
  };

  const renderDataBlock = (block: DataBlock) => {
    const isAdding = addingBlockId === block.id;
    return (
      <div className={`bg-surface border border-border rounded-xl p-4 transition-all hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 ${isAdding ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''}`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {getBlockIcon(block.type)}
            <span className="font-medium text-text text-sm">{block.title}</span>
            <span className="px-1.5 py-0.5 bg-background border border-border rounded text-[10px] text-textSecondary">
              {getBlockTypeLabel(block.type)}
            </span>
          </div>
          <button
            onClick={() => handleAddToPaper(block.id)}
            disabled={isAdding}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              isAdding
                ? 'bg-accent/30 text-accent cursor-wait'
                : 'bg-accent/20 text-accent hover:bg-accent/30 hover:shadow-sm'
            }`}
          >
            {isAdding ? (
              <>
                <Sparkles className="w-3 h-3 animate-pulse" />
                {t('data.adding')}
              </>
            ) : (
              <>
                <Plus className="w-3 h-3" />
                {t('data.addToPaper')}
              </>
            )}
          </button>
        </div>

        {block.description && (
          <p className="text-xs text-textSecondary mb-2">{block.description}</p>
        )}

        {block.source && (
          <div className="flex items-center gap-1 mb-3 text-[10px] text-textSecondary/70">
            <ExternalLink className="w-3 h-3" />
            <span>{block.source}</span>
          </div>
        )}

        {block.type === 'table' && block.headers && block.rows && (
          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-background">
                  {block.headers.map((header, idx) => (
                    <th key={idx} className="px-3 py-2 text-left border-b border-border text-textSecondary font-medium">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-background/50 transition-colors">
                    {row.map((cell, cidx) => (
                      <td key={cidx} className="px-3 py-2 border-b border-border/30 text-text">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {block.type === 'chart' && block.data && block.labels && (
          <div className="bg-background/50 rounded-lg p-3">
            <div className="flex items-end gap-1.5 h-36">
              {block.data.map((value, idx) => (
                <div key={idx} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className="w-full bg-gradient-to-t from-primary/70 to-primary/30 rounded-t transition-all hover:from-primary/90 hover:to-primary/50 cursor-pointer group relative"
                    style={{ height: `${(value / Math.max(...block.data)) * 100}%` }}
                  >
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] text-textSecondary opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                      {value.toLocaleString()}
                    </span>
                  </div>
                  <span className="text-[10px] text-textSecondary truncate w-full text-center">{block.labels[idx]}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {block.type === 'equation' && block.equation && (
          <div className="bg-background/50 rounded-lg p-4 flex items-center justify-center min-h-[80px]">
            <div className="text-text font-mono text-center text-sm">
              {block.equation.replace(/\\text\{([^}]+)\}/g, '$1')}
            </div>
          </div>
        )}
      </div>
    );
  };

  const quickQuestions = [
    t('quick.q1'),
    t('quick.q2'),
    t('quick.q3'),
    t('quick.q4'),
  ];

  // ---------- 折叠态：仅保留一个展开按钮 ----------
  if (!qaPanelOpen) {
    return (
      <div className="w-9 flex-shrink-0 border-l border-border bg-surface flex flex-col items-center py-3 gap-2">
        <button
          onClick={() => setQaPanelOpen(true)}
          className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
          title={t('panel.expand')}
        >
          <MessageCircle className="w-5 h-5" />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* 可拖拽分隔条：调宽 AI 面板（范围 300-640，持久化） */}
      <ResizableDivider onDelta={(dx) => setQaPanelWidth(qaPanelWidth + dx)} />
      <div
        style={{ width: qaPanelWidth }}
        className="flex-shrink-0 border-l border-border bg-surface flex flex-col overflow-hidden"
      >
      {/* 头部：三标签 + 折叠 */}
      <div className="px-3 py-2.5 border-b border-border bg-surface">
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-1 bg-background rounded-lg p-0.5 flex-1 min-w-0">
            <button
              onClick={() => setActiveTab('qa')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                activeTab === 'qa'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-textSecondary hover:text-text'
              }`}
            >
              <MessageCircle className="w-3.5 h-3.5" />
              {t('tab.qa')}
            </button>
            <button
              onClick={() => setActiveTab('context')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                activeTab === 'context'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-textSecondary hover:text-text'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              {t('tab.context')}
            </button>
            <button
              onClick={() => setActiveTab('data')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                activeTab === 'data'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-textSecondary hover:text-text'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              {t('tab.data')}
            </button>
          </div>

          {activeTab === 'qa' && (
            <button
              onClick={clearChatMessages}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-textSecondary hover:text-text hover:border-red-400 transition-colors text-xs"
              title={t('panel.clearChat')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
          {activeTab === 'context' && (
            <button
              onClick={() => setShowAddContextModal(true)}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-accent hover:bg-accent/80 text-white text-xs transition-colors"
              title={t('panel.addExternalLink')}
            >
              <Globe className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setQaPanelOpen(false)}
            className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
            title={t('panel.collapse')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* 当前焦点提示 */}
        <div className="mt-2 flex items-center gap-2 px-2.5 py-1.5 bg-background/60 border border-border rounded-lg">
          {currentView === 'research' ? (
            <BookOpen className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          ) : currentView === 'workspace' ? (
            <FileText className="w-3.5 h-3.5 text-secondary flex-shrink-0" />
          ) : (
            <Search className="w-3.5 h-3.5 text-accent flex-shrink-0" />
          )}
          <span className="text-[11px] text-textSecondary truncate">
            {currentView === 'research'
              ? (focusPaperTitle ? t('focus.reading', { title: focusPaperTitle }) : t('focus.readingEmpty'))
              : currentView === 'workspace'
                ? t('focus.writing')
                : t('focus.explore')}
          </span>
        </div>
      </div>

      {/* ---------- Q&A ---------- */}
      {activeTab === 'qa' && (
        <>
          <div className="px-3 py-2 bg-background/50 border-b border-border">
            <p className="text-[11px] text-textSecondary mb-1.5">{t('quick.heading')}</p>
            <div className="flex flex-wrap gap-1.5">
              {quickQuestions.map((question, index) => (
                <button
                  key={index}
                  onClick={() => setInput(question)}
                  className="px-2 py-0.5 bg-surface border border-border rounded-md text-[11px] text-textSecondary hover:text-text hover:border-primary transition-colors"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-auto p-3">
            <div className="space-y-3">
              {chatMessages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-textSecondary">
                  <MessageCircle className="w-8 h-8 mb-3 opacity-40" />
                  <p className="text-xs text-center px-6 leading-relaxed">
                    {t('empty.intro')}
                  </p>
                </div>
              )}
              {chatMessages.map((message) => (
                message.role === 'assistant' ? (
                  <AssistantMessage
                    key={message.id}
                    message={message}
                    streamStage={streamStage}
                    copiedId={copiedId}
                    onCopy={handleCopy}
                    onOpenSource={(idx) => handleOpenSource(idx, message)}
                    onAddToContext={handleAddToolPaperToContext}
                    onOpenPaper={handleOpenToolPaper}
                  />
                ) : (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%]">
                      <div className="relative px-4 py-2.5 rounded-xl bg-gradient-to-br from-primary to-primary/80 text-white rounded-br-sm">
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
                        <span className="block text-xs text-textSecondary mt-1 text-right">
                          {new Date(message.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              ))}
            </div>
          </div>

          <div className="px-3 py-2.5 border-t border-border bg-surface">
            {/* 上下文控制条 */}
            <div className="flex items-center gap-2.5 mb-2">
              <button
                onClick={() => setUseContext(!useContext)}
                className="flex items-center gap-1.5 text-[11px] text-textSecondary hover:text-text transition-colors"
                title={t('toggle.contextHint')}
              >
                <span className={`w-7 h-4 rounded-full relative transition-colors ${useContext ? 'bg-primary' : 'bg-border'}`}>
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${useContext ? 'left-3.5' : 'left-0.5'}`} />
                </span>
                <Globe className="w-3 h-3" />
                {t('toggle.context')}
              </button>
              <button
                onClick={() => setToolEnabled(!toolEnabled)}
                className="flex items-center gap-1.5 text-[11px] text-textSecondary hover:text-text transition-colors"
                title={t('toggle.searchHint')}
              >
                <span className={`w-7 h-4 rounded-full relative transition-colors ${toolEnabled ? 'bg-secondary' : 'bg-border'}`}>
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${toolEnabled ? 'left-3.5' : 'left-0.5'}`} />
                </span>
                <Search className="w-3 h-3" />
                {t('toggle.search')}
              </button>
              <button
                onClick={() => setShowCtxSelector((v) => !v)}
                className={`flex items-center gap-1 px-1.5 py-1 rounded-lg text-[11px] transition-colors ${
                  pinnedCtxIds.length > 0 || excludedCtxIds.length > 0
                    ? 'bg-accent/20 text-accent'
                    : 'text-textSecondary hover:text-text'
                }`}
                title={t('toggle.manageHint')}
              >
                <Settings2 className="w-3 h-3" />
                {t('toggle.manage')}
              </button>
              {pinnedCtxIds.length > 0 && <span className="text-[10px] text-accent">{t('ctx.pinnedCount', { count: pinnedCtxIds.length })}</span>}
              {excludedCtxIds.length > 0 && <span className="text-[10px] text-red-400">{t('ctx.excludedCount', { count: excludedCtxIds.length })}</span>}
            </div>

            {/* 固定 / 排除选择器 */}
            {showCtxSelector && (
              <div className="mb-2 border border-border rounded-lg bg-background max-h-48 overflow-auto">
                {contextItems.length === 0 ? (
                  <p className="px-3 py-3 text-[11px] text-textSecondary">
                    {t('ctx.selectorEmpty')}
                  </p>
                ) : (
                  contextItems.map((item) => {
                    const numId = Number(item.id);
                    const pinned = pinnedCtxIds.includes(numId);
                    const excluded = excludedCtxIds.includes(numId);
                    const togglePin = () => setPinnedCtxIds(
                      pinned ? pinnedCtxIds.filter((x) => x !== numId) : [...pinnedCtxIds, numId]
                    );
                    const toggleExclude = () => setExcludedCtxIds(
                      excluded ? excludedCtxIds.filter((x) => x !== numId) : [...excludedCtxIds, numId]
                    );
                    return (
                      <div key={item.id} className="flex items-center gap-2 px-3 py-2 border-b border-border/50 last:border-b-0">
                        {item.type === 'url'
                          ? <Globe className="w-3 h-3 text-secondary flex-shrink-0" />
                          : <BookOpen className="w-3 h-3 text-primary flex-shrink-0" />}
                        <span className="flex-1 min-w-0 truncate text-[11px] text-textSecondary">{item.title}</span>
                        <button
                          onClick={togglePin}
                          className={`px-1.5 py-0.5 rounded-md text-[10px] transition-colors ${
                            pinned ? 'bg-accent/30 text-accent' : 'bg-surface border border-border text-textSecondary hover:border-accent/50'
                          }`}
                          title={t('ctx.pinHint')}
                        >
                          {pinned ? t('ctx.pinned') : t('ctx.pin')}
                        </button>
                        <button
                          onClick={toggleExclude}
                          className={`px-1.5 py-0.5 rounded-md text-[10px] transition-colors ${
                            excluded ? 'bg-red-500/30 text-red-400' : 'bg-surface border border-border text-textSecondary hover:border-red-500/50'
                          }`}
                          title={t('ctx.excludeHint')}
                        >
                          {excluded ? t('ctx.excluded') : t('ctx.exclude')}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <div className="flex items-end gap-2">
              <div className="flex-1 relative">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSubmit())}
                  placeholder={t('input.placeholder')}
                  className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-text placeholder-textSecondary focus:outline-none focus:border-secondary resize-none transition-colors text-sm"
                  rows={2}
                />
              </div>
              {loading ? (
                <button
                  onClick={handleStopStream}
                  className="p-3 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                  title={t('input.stop')}
                >
                  <Square className="w-3.5 h-3.5" fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!input.trim()}
                  className={`p-3 rounded-lg transition-all ${
                    input.trim()
                      ? 'bg-gradient-to-br from-secondary to-secondary/80 text-white hover:shadow-lg hover:shadow-secondary/30'
                      : 'bg-surface border border-border text-textSecondary cursor-not-allowed'
                  }`}
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ---------- Context ---------- */}
      {activeTab === 'context' && (
        <div className="flex-1 overflow-auto p-3">
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setCtxTagFilter(null)}
              className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${
                ctxTagFilter === null
                  ? 'bg-primary/20 text-primary border border-primary/30'
                  : 'bg-surface text-textSecondary border border-border hover:border-primary/30'
              }`}
            >
              {t('ctx.all', { count: contextItems.length })}
            </button>
            {ctxAllTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setCtxTagFilter(ctxTagFilter === tag ? null : tag)}
                className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${
                  ctxTagFilter === tag
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-surface text-textSecondary border border-border hover:border-primary/30'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {(ctxTagFilter ? contextItems.filter((i) => i.tags.includes(ctxTagFilter)) : contextItems).length === 0 && (
              <p className="text-center text-[11px] text-textSecondary py-10">
                {t('ctx.empty')}
              </p>
            )}
            {(ctxTagFilter ? contextItems.filter((i) => i.tags.includes(ctxTagFilter)) : contextItems).map((item) => (
              <ContextItemCard
                key={item.id}
                item={item}
                onDelete={handleContextDelete}
                onChanged={handleContextChanged}
                onInsert={handleInsertContextToPaper}
                onOpenInReader={handleOpenContextInReader}
                onError={(m) => showNotification(m, 'error')}
              />
            ))}
          </div>
        </div>
      )}

      {/* ---------- Data ---------- */}
      {activeTab === 'data' && (
        <div className="flex-1 overflow-auto p-3">
          <div className="mb-3 p-3 bg-primary/5 border border-primary/20 rounded-xl">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium text-primary">{t('data.heading')}</span>
            </div>
            <p className="text-[11px] text-textSecondary">
              {t('data.intro')}
            </p>
          </div>

          <div className="space-y-4">
            {dataBlocks.map((block) => renderDataBlock(block))}
          </div>

          <div className="mt-5 bg-surface border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4 text-primary" />
              <span className="font-medium text-text text-sm">{t('data.toolsHeading')}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button className="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-textSecondary hover:text-text hover:border-primary transition-colors text-xs">
                <FileImage className="w-4 h-4" />
                {t('data.tool.chart')}
              </button>
              <button className="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-textSecondary hover:text-text hover:border-primary transition-colors text-xs">
                <Table className="w-4 h-4" />
                {t('data.tool.table')}
              </button>
              <button className="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-textSecondary hover:text-text hover:border-primary transition-colors text-xs">
                <BarChart3 className="w-4 h-4" />
                {t('data.tool.stats')}
              </button>
              <button className="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg text-textSecondary hover:text-text hover:border-primary transition-colors text-xs">
                <ChevronRight className="w-4 h-4" />
                {t('data.tool.export')}
              </button>
            </div>
          </div>
        </div>
      )}

      <AddContextModal
        open={showAddContextModal}
        onClose={() => setShowAddContextModal(false)}
        onAdded={handleContextAdded}
        initialMode="url"
      />

      {notification.show && (
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
      </div>
    </div>
  );
};

export default QAPanel;