import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FileText, Plus, X, Loader2, Upload, FolderOpen, BookOpen, ExternalLink, Check, BookmarkPlus, BookmarkCheck, RefreshCw } from 'lucide-react';
import { ensurePdfReady, getPdfUrl, getPaperById, createPaperContext, uploadWorkspaceFile } from '../api';
import { Paper, Note, ReaderTab } from '../types';
import { usePaperMindStore } from '../store';
import { addPaperContextItem } from '../lib/context';
import PdfViewer, { PdfViewerHandle } from '../components/PdfViewer';

/** 阅读器标签页的本地状态（含 PDF 加载状态；store 只持久化 paperId+title） */
interface ReaderTabState {
  paper: Paper;
  pdfUrl: string | null;
  pdfError: string | null;
  pdfChecking: boolean;
}

/** 生成字段齐全的占位论文（元数据尚未从后端取回时使用，保证渲染不崩） */
function makePlaceholderPaper(id: string, title: string): Paper {
  return {
    id,
    title,
    authors: [],
    year: 0,
    abstract: '',
    source: 'placeholder',
    external_id: '',
    url: '',
    pdf_url: null,
    citation_count: null,
    reference_count: null,
    publication_venue: null,
    doi: null,
    journal: '',
    conference: '',
    citations: 0,
    pdfUrl: '',
    keywords: [],
  };
}

/**
 * 纯阅读器：多标签 PDF 阅读 + 选中文本（高亮/笔记/存摘录/提问）。
 * 问答已上移到全局 QAPanel（src/components/QAPanel.tsx），
 * 本组件只负责：监听 pdfLocateRequest 定位原文、把 onAsk 转发为 qaInputDraft。
 */
const DeepResearch: React.FC = () => {
  const { t } = useTranslation('research');
  const {
    selectedPaper,
    setSelectedPaper,
    highlights,
    addHighlight,
    notes,
    addNote,
    contextItems,
    addContextItem,
    readerTabs: storeReaderTabs,
    activeTabId: storeActiveTabId,
    openReaderTab: openReaderTabStore,
    closeReaderTab: closeReaderTabStore,
    setReaderTabPdfState: setReaderTabPdfStateStore,
    setQaInputDraft,
    setQaPanelOpen,
    pdfLocateRequest,
    activeWorkspaceId,
  } = usePaperMindStore();

  const [tabs, setTabs] = useState<ReaderTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // 本地文献上传弹窗
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** 正在加入上下文库的论文 id（按钮防重入 + 显示「加入中」） */
  const [addingContextId, setAddingContextId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [notification, setNotification] = useState<{ show: boolean; message: string; type: 'success' | 'error' }>({
    show: false,
    message: '',
    type: 'success',
  });
  const pdfViewerRef = useRef<PdfViewerHandle | null>(null);

  const activeTabState = tabs.find((t) => t.paper.id === activeTabId) ?? null;
  const currentPaper = activeTabState?.paper ?? null;
  /** 当前标签论文是否已在上下文库（不含同论文的选中摘录条目） */
  const currentInContext = !!currentPaper
    && contextItems.some((i) => i.type === 'paper' && i.paperId === currentPaper.id);
  const addingCurrentContext = !!currentPaper && addingContextId === currentPaper.id;

  const showNotification = useCallback((message: string, type: 'success' | 'error') => {
    setNotification({ show: true, message, type });
    setTimeout(() => {
      setNotification({ show: false, message: '', type: 'success' });
    }, 2500);
  }, []);

  /** 一键把当前标签论文加入当前工作区的上下文库（共享幂等链路：lib/context） */
  const handleAddCurrentToContext = useCallback(async () => {
    if (!currentPaper || addingContextId) return;
    setAddingContextId(currentPaper.id);
    try {
      const item = await addPaperContextItem(currentPaper.id, activeWorkspaceId ?? undefined);
      showNotification(t('notice.addedToContext', { title: item.title }), 'success');
    } catch (e) {
      showNotification(e instanceof Error ? e.message : t('notice.addToContextFailed'), 'error');
    } finally {
      setAddingContextId(null);
    }
  }, [currentPaper, addingContextId, activeWorkspaceId, showNotification, t]);

  // 探测某论文 PDF 可用性并写入对应标签（失败时带上后端给出的具体原因）。
  // 结果同时持久化到 store 的标签快照：失败后重启不再自动探测，只允许手动刷新，
  // 避免反复请求数据源触发限流。
  const probePdf = useCallback((paperId: string) => {
    ensurePdfReady(paperId)
      .then((result) => {
        if (result.ok) {
          setTabs((prev) => prev.map((tab) =>
            tab.paper.id === paperId
              ? { ...tab, pdfChecking: false, pdfUrl: getPdfUrl(paperId), pdfError: null }
              : tab
          ));
          setReaderTabPdfStateStore(paperId, false);
        } else {
          const reason = result.reason ?? t('pdf.unavailable');
          setTabs((prev) => prev.map((tab) =>
            tab.paper.id === paperId
              ? { ...tab, pdfChecking: false, pdfUrl: null, pdfError: reason }
              : tab
          ));
          setReaderTabPdfStateStore(paperId, true, reason);
        }
      })
      .catch((e) => {
        const reason = e instanceof Error ? e.message : t('pdf.fetchFailed');
        setTabs((prev) => prev.map((tab) =>
          tab.paper.id === paperId
            ? { ...tab, pdfChecking: false, pdfUrl: null, pdfError: reason }
            : tab
        ));
        setReaderTabPdfStateStore(paperId, true, reason);
      });
  }, [t, setReaderTabPdfStateStore]);

  /** 手动刷新：用户在失败面板点击「重试」时唯一允许的重新获取入口 */
  const retryPdf = useCallback((paperId: string) => {
    setTabs((prev) => prev.map((tab) =>
      tab.paper.id === paperId
        ? { ...tab, pdfChecking: true, pdfError: null }
        : tab
    ));
    probePdf(paperId);
  }, [probePdf]);

  // 打开/切换到某论文标签
  const openTab = useCallback((paper: Paper) => {
    setTabs((prev) => {
      const exists = prev.some((t) => t.paper.id === paper.id);
      if (!exists) {
        probePdf(paper.id);
        getPaperById(paper.id)
          .then((meta) => {
            if (meta) setTabs((p) => p.map((t) => (t.paper.id === meta.id ? { ...t, paper: meta } : t)));
          })
          .catch(() => { /* 保留占位 Paper */ });
        return [...prev, { paper, pdfUrl: null, pdfError: null, pdfChecking: true }];
      }
      return prev;
    });
    setActiveTabId(paper.id);
    setSelectedPaper(paper);
    openReaderTabStore(paper.id, paper.title || t('tabs.untitled'));
  }, [probePdf, openReaderTabStore, setSelectedPaper, t]);

  // 关闭某标签
  const closeTab = useCallback((paperId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.paper.id === paperId);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.paper.id !== paperId);
      // 关闭的是当前激活标签：激活态转移给相邻标签（无则清空）
      if (paperId === activeTabId) {
        const neighbor = next[Math.min(idx, next.length - 1)] ?? null;
        setActiveTabId(neighbor ? neighbor.paper.id : null);
        setSelectedPaper(neighbor ? neighbor.paper : null);
      } else if (selectedPaper?.id === paperId) {
        // 防御：全局选中论文恰好指向被关闭的非激活标签（历史快照可能残留），
        // 改指当前激活标签，避免刷新时被恢复逻辑重新塞回
        setSelectedPaper(next.find((t) => t.paper.id === activeTabId)?.paper ?? null);
      }
      return next;
    });
    closeReaderTabStore(paperId);
  }, [activeTabId, selectedPaper, closeReaderTabStore, setSelectedPaper]);

  // 从 paperId + title 打开标签
  const openTabByMeta = useCallback((paperId: string, title: string) => {
    openTab(makePlaceholderPaper(paperId, title));
  }, [openTab]);

  // 启动时从 store 恢复标签页。打开标签的唯一真相源是 readerTabs：
  // 曾经在此把不在标签列表里的 selectedPaper 重新塞回，导致"关闭标签后刷新
  // 又出现"——已移除；selectedPaper 仅代表 Explore 的选中项，不是打开的标签。
  // 关键：上次已判定 PDF 无法打开的标签（pdfFailed）恢复为失败态即可，
  // **不再自动探测**，避免每次启动都重新请求数据源而触发限流；重试只由
  // 失败面板上的手动刷新按钮触发（retryPdf）。
  useEffect(() => {
    if (storeReaderTabs.length === 0) {
      // 无打开标签：清空可能残留的全局选中论文（自愈旧版本快照），不复活任何标签
      if (selectedPaper) setSelectedPaper(null);
      return;
    }
    const papers = storeReaderTabs.map((t) => makePlaceholderPaper(t.paperId, t.title));
    const savedMap = new Map<string, ReaderTab>(storeReaderTabs.map((t) => [t.paperId, t]));
    setTabs(papers.map((p) => {
      const saved = savedMap.get(p.id);
      return saved?.pdfFailed
        ? { paper: p, pdfUrl: null, pdfChecking: false, pdfError: saved.pdfError || t('pdf.unavailable') }
        : { paper: p, pdfUrl: null, pdfError: null, pdfChecking: true };
    }));
    // activeTabId 已在 store 水合时按 readerTabs 校验过；非法时兜底首个
    const restoredActiveId = storeActiveTabId ?? papers[0].id;
    setActiveTabId(restoredActiveId);
    // 同步全局选中论文为实际激活标签（清除指向已关闭论文的历史残留）
    setSelectedPaper(papers.find((p) => p.id === restoredActiveId) ?? null);
    papers.forEach((p) => {
      // 仅未被标记为失败的标签才自动尝试一次
      if (!savedMap.get(p.id)?.pdfFailed) probePdf(p.id);
      getPaperById(p.id)
        .then((meta) => {
          if (meta) {
            setTabs((prev) => prev.map((tab) => (tab.paper.id === meta.id ? { ...tab, paper: meta } : tab)));
          }
        })
        .catch(() => { /* 元数据补取失败时保留占位 Paper */ });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 论文搜索防抖（已移除：搜索整合到 Explore；本阅读器通过本地文件上传打开文献）
  // 上传本地文件到当前工作区：PDF 自动注册为本地文献并打开阅读
  const handleUpload = useCallback((file: File) => {
    if (!activeWorkspaceId) {
      setUploadError(t('upload.needWorkspace'));
      return;
    }
    setUploading(true);
    setUploadError(null);
    uploadWorkspaceFile(activeWorkspaceId, file)
      .then((info) => {
        showNotification(t('upload.uploaded', { path: info.path }), 'success');
        if (info.paper_id) {
          // PDF：注册为本地文献并直接打开阅读
          openTabByMeta(info.paper_id, file.name.replace(/\.pdf$/i, ''));
        }
        setUploadOpen(false);
      })
      .catch((e) => {
        setUploadError(e instanceof Error ? e.message : t('upload.failed'));
      })
      .finally(() => setUploading(false));
  }, [activeWorkspaceId, openTabByMeta, showNotification, t]);

  // 消费全局 PDF 引用定位请求（QAPanel 点击 [Source N] / 定位链接时发出）
  useEffect(() => {
    if (!pdfLocateRequest) return;
    const { paperId, text } = pdfLocateRequest;
    // 打开/激活对应论文标签
    const title = storeReaderTabs.find((t) => t.paperId === paperId)?.title ?? t('tabs.untitled');
    openTabByMeta(paperId, title);
    // 等待标签切换 & PDF 加载后定位（PDF 未就绪时可能一次定位失败，稍作重试）
    const attempt = (retries: number) => {
      if (pdfViewerRef.current && pdfViewerRef.current.paperId === paperId) {
        pdfViewerRef.current.locateText(text).then((ok) => {
          if (!ok) {
            const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 60);
            showNotification(t('notice.locateFailed', { snippet: `${snippet}${text.length > 60 ? '…' : ''}` }), 'error');
          }
        });
        return;
      }
      if (retries > 0) setTimeout(() => attempt(retries - 1), 250);
    };
    setTimeout(() => attempt(8), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfLocateRequest]);

  // ---------- PDF 选中文本回调 ----------
  const handleAddHighlight = (hl: Omit<import('../types').Highlight, 'id' | 'createdAt'>) => {
    const newHl: import('../types').Highlight = {
      ...hl,
      id: `hl${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    addHighlight(newHl);
    showNotification(t('notice.highlightAdded'), 'success');
  };

  const handleNoteFromSelection = (text: string) => {
    if (!currentPaper) return;
    const note: Note = {
      id: `n${Date.now()}`,
      paperId: currentPaper.id,
      content: text,
      highlight: text,
      position: { start: 0, end: 0 },
      createdAt: new Date().toISOString(),
    };
    addNote(note);
    showNotification(t('notice.noteAdded'), 'success');
  };

  const handleContextFromSelection = async (text: string) => {
    if (!currentPaper) return;
    try {
      // 上下文库按工作区隔离：归属当前活跃工作区
      const item = await createPaperContext(currentPaper.id, text, activeWorkspaceId ?? undefined);
      addContextItem(item);
      showNotification(t('notice.contextAdded'), 'success');
    } catch (e) {
      showNotification(e instanceof Error ? e.message : t('notice.contextFailed'), 'error');
    }
  };

  const handleAskFromSelection = (text: string) => {
    if (!currentPaper) {
      showNotification(t('notice.selectPaperFirst'), 'error');
      return;
    }
    // 转发给全局 QAPanel：填入输入框并自动提问
    setQaInputDraft(text);
    setQaPanelOpen(true);
  };

  return (
    <div className="h-full flex flex-col">
      {/* 顶部：标题 + 当前工作区 + 新增（上传本地文献） */}
      <div className="px-4 py-3 border-b border-border bg-surface flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-shrink-0">
          <FileText className="w-5 h-5 text-primary" />
          <span className="font-semibold text-text">{t('header.title')}</span>
          <span className="mx-1 text-border">|</span>
          <div className="flex items-center gap-1.5 text-xs text-textSecondary">
            <FolderOpen className="w-3.5 h-3.5 text-accent" />
            <span className="max-w-[160px] truncate">{activeWorkspaceId ? t('header.workspace') : t('header.noWorkspace')}</span>
          </div>
        </div>
        <button
          onClick={() => {
            setUploadError(null);
            setUploadOpen(true);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors flex-shrink-0"
          title={t('header.uploadTitle')}
        >
          <Upload className="w-4 h-4" />
          {t('header.upload')}
        </button>
      </div>

      {/* 多标签页导航栏 */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-1.5 bg-background border-b border-border overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.paper.id === activeTabId;
            return (
              <div
                key={tab.paper.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  setActiveTabId(tab.paper.id);
                  // 切换标签同步全局选中论文，保证 closeTab 等逻辑读到的当前论文准确
                  setSelectedPaper(tab.paper);
                  openReaderTabStore(tab.paper.id, tab.paper.title || t('tabs.untitled'));
                }}
                className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs cursor-pointer whitespace-nowrap transition-colors border ${
                  isActive
                    ? 'bg-primary/15 border-primary/40 text-text'
                    : 'bg-surface border-border text-textSecondary hover:bg-background'
                }`}
              >
                <FileText className="w-3 h-3 flex-shrink-0" />
                <span className="max-w-[140px] truncate">{tab.paper.title || t('tabs.untitled')}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.paper.id);
                  }}
                  className="ml-0.5 p-0.5 rounded hover:bg-white/10 text-textSecondary hover:text-text flex-shrink-0"
                  title={t('tabs.close')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          {/* 新增标签：上传本地文献到工作区并打开阅读 */}
          <button
            onClick={() => {
              setUploadError(null);
              setUploadOpen(true);
            }}
            className="ml-1 flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-textSecondary hover:text-text hover:bg-background transition-colors whitespace-nowrap"
            title={t('tabs.addTitle')}
          >
            <Plus className="w-3.5 h-3.5" />
            {t('tabs.add')}
          </button>
        </div>
      )}

      {/* 元数据栏 */}
      <div className="px-4 py-3 bg-background/50 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <BookOpen className="w-4 h-4 text-textSecondary flex-shrink-0" />
            <span className="text-textSecondary truncate">
              {currentPaper ? (currentPaper.authors.length > 0 ? currentPaper.authors.join(', ') : t('meta.unknownAuthors')) : t('meta.noPaper')}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-textSecondary">
            <span>{currentPaper ? (currentPaper.conference || currentPaper.publication_venue || t('meta.unknownVenue')) : '—'}</span>
            <span className="text-border">|</span>
            <span>{currentPaper ? currentPaper.year : '—'}</span>
            <span className="text-border">|</span>
            <span>{currentPaper ? t('meta.citations', { count: currentPaper.citations, formatted: currentPaper.citations.toLocaleString() }) : '—'}</span>
            {currentPaper?.source && (
              <>
                <span className="text-border">|</span>
                <span className="px-1.5 py-0.5 bg-accent/10 text-accent rounded">{currentPaper.source}</span>
              </>
            )}
          </div>
        </div>
        {/* 一键把当前标签论文加入当前工作区的上下文库 */}
        {currentPaper && (
          currentInContext ? (
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-sm font-medium flex-shrink-0 cursor-default"
              title={t('meta.inContextTitle')}
            >
              <BookmarkCheck className="w-4 h-4" />
              {t('meta.inContext')}
            </span>
          ) : (
            <button
              onClick={handleAddCurrentToContext}
              disabled={addingCurrentContext}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/15 text-secondary text-sm font-medium hover:bg-secondary/25 transition-colors flex-shrink-0 disabled:opacity-60 disabled:cursor-wait"
              title={t('meta.addToContextTitle')}
            >
              {addingCurrentContext ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <BookmarkPlus className="w-4 h-4" />
              )}
              {addingCurrentContext ? t('meta.addingToContext') : t('meta.addToContext')}
            </button>
          )
        )}
      </div>

      {/* PDF 主体 */}
      <div className="flex-1 overflow-auto relative">
        {activeTabState?.pdfChecking ? (
          <div className="flex flex-col items-center justify-center py-16 text-textSecondary">
            <Loader2 className="w-8 h-8 animate-spin mb-3" />
            <p className="text-sm">{t('pdf.preparing')}</p>
          </div>
        ) : activeTabState?.pdfUrl ? (
          <div className="h-full" key={activeTabId}>
            <PdfViewer
              ref={pdfViewerRef}
              url={activeTabState.pdfUrl}
              title={activeTabState.paper.title}
              paperId={activeTabState.paper.id}
              highlights={highlights.filter((h) => h.paperId === activeTabId)}
              onAddHighlight={handleAddHighlight}
              onNote={handleNoteFromSelection}
              onContext={handleContextFromSelection}
              onAsk={handleAskFromSelection}
            />
          </div>
        ) : activeTabState?.paper ? (
          <div className="p-6">
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-red-400 flex-shrink-0" />
                <span className="text-xs text-red-400 font-medium truncate" title={activeTabState.pdfError || t('pdf.unavailable')}>
                  {activeTabState.pdfError || t('pdf.unavailable')}
                </span>
              </div>
              {/* 失败后不自动重试：仅提供手动刷新，避免反复请求触发数据源限流 */}
              <button
                onClick={() => retryPdf(activeTabState.paper.id)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary/15 text-secondary text-xs font-medium hover:bg-secondary/25 transition-colors flex-shrink-0"
                title={t('pdf.retryTitle')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {t('pdf.retry')}
              </button>
            </div>
            <h3 className="text-base font-semibold text-text mb-1">{activeTabState.paper.title}</h3>
            <p className="text-xs text-textSecondary mb-4">
              {activeTabState.paper.authors.length > 0 ? activeTabState.paper.authors.join(', ') : t('meta.unknownAuthors')}
              {activeTabState.paper.year ? ` · ${activeTabState.paper.year}` : ''}
            </p>
            <div className="bg-background/60 border border-border rounded-lg p-4">
              <p className="text-[11px] font-medium text-textSecondary uppercase tracking-wide mb-2">{t('paper.abstract')}</p>
              <p className="text-sm text-textSecondary leading-relaxed whitespace-pre-wrap">
                {activeTabState.paper.abstract || t('paper.noAbstract')}
              </p>
            </div>
            {activeTabState.paper.url && (
              <a
                href={activeTabState.paper.url}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-xs text-secondary hover:text-secondary/80"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {t('paper.viewSource', { url: activeTabState.paper.url })}
              </a>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-textSecondary">
            <FileText className="w-8 h-8 mb-3 opacity-50" />
            <p className="text-sm">{t('empty.hint')}</p>
          </div>
        )}
      </div>

      {/* 上传文献弹窗：上传到当前工作区，与搜索到的文献同权 */}
      {uploadOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => {
            if (!uploading) setUploadOpen(false);
          }}
        >
          <div
            className="w-[420px] max-w-[90vw] bg-surface border border-border rounded-2xl shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-text">{t('upload.panelTitle')}</h3>
              </div>
              <button
                onClick={() => setUploadOpen(false)}
                disabled={uploading}
                className="p-1.5 rounded-lg hover:bg-background text-textSecondary hover:text-text transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!activeWorkspaceId ? (
              <div className="bg-background/60 border border-border rounded-lg p-4 text-sm text-textSecondary leading-relaxed">
                <Trans ns="research" i18nKey="upload.needWorkspaceHint" components={{ home: <span className="text-primary font-medium" /> }} />
              </div>
            ) : (
              <>
                <div
                  className="border-2 border-dashed border-border hover:border-primary/50 rounded-xl p-8 flex flex-col items-center gap-2 cursor-pointer bg-background/40 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FolderOpen className="w-8 h-8 text-textSecondary" />
                  <p className="text-sm text-text">{t('upload.pick')}</p>
                  <p className="text-xs text-textSecondary text-center">
                    {t('upload.supported')}
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.tex,.bib,.txt,.md"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = '';  // 允许重复选择同一文件
                    }}
                  />
                </div>
                {uploading && (
                  <div className="flex items-center gap-2 mt-4 text-sm text-textSecondary">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('upload.uploading')}
                  </div>
                )}
                {uploadError && (
                  <div className="mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
                    {uploadError}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

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
  );
};

export default DeepResearch;