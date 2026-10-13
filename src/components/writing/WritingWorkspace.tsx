/**
 * 写作工作区编排组件（多文件 LaTeX 写作）。
 *
 * 布局：左文件树/大纲 ｜ 中间标签页+工具栏+编辑器 ｜ 右编译 PDF/编译日志。
 *
 * 编译策略（Overleaf 式）：
 * - 无实时预览：任何编辑在停止 1500ms 后自动触发编译，
 *   触发前先 flushAll 把防抖保存（main 走 store 600ms、其余文件本组件 600ms）
 *   全部落盘；编译串行（不重入），编译期间的新编辑在结束后补编译一次；
 * - 自动编译失败 → 暂停自动编译，直到用户下次点手动「编译」；
 * - 右侧 PDF 与阅读模块共用 PdfViewer（缩放/旋转/滚动/文本选择全共享），
 *   写作模式下双击 PDF 经 SyncTeX 反向定位到源码对应行（支持 \input 子文件）。
 *
 * 状态与持久化：
 * - main.tex 内容沿用 store.latexContent（store 既有 600ms 自动保存、切换工作区
 *   先存后切、AI read_document 读取等流程全部不变）；
 * - 其余文本文件的缓冲区、dirty 状态与防抖保存由本组件管理（PUT /files/<path>）；
 * - 打开的标签页与激活标签存于 store（随工作区快照持久化）；
 * - 文件列表以后端为真源，新建/上传/删除/编译后刷新。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Undo2, Redo2, Bold, Italic, Heading1, Heading2, List, ListOrdered,
  Link2, Image as ImageIcon, Save, Play, Loader2, AlertTriangle,
  FileText, FileWarning, ListTree,
} from 'lucide-react';
import { usePaperMindStore } from '../../store';
import { useWritingReviewStore } from '../../store/writingReview';
import { registerWritingHost } from '../../lib/writing/bridge';
import {
  listWorkspaceFiles, readWorkspaceText, writeWorkspaceText,
  uploadWorkspaceFile, deleteWorkspaceFile, ensureWritingEntry,
  compileWorkspace, workspaceFileUrl, synctexInverse,
  type CompileResult,
} from '../../api';
import type { WorkspaceFile, WritingRevision } from '../../types';
import FileTree from './FileTree';
import EditorTabs from './EditorTabs';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import BinaryViewer from './BinaryViewer';
import PdfViewer, { type InverseLocatePoint } from '../PdfViewer';
import ResizableDivider from '../ResizableDivider';
import {
  MAIN_TEX, baseName, isImageFile, isTextFile, isViewableBinary,
  modeForPath, graphicxRef,
} from './utils';

interface Buffer {
  status: 'loading' | 'ready' | 'error';
  content: string;
  /** 最近一次成功保存/加载后的服务端内容（dirty 判定基线） */
  saved: string;
  error?: string;
}

type RightMode = 'pdf' | 'log';

interface CompileState {
  running: boolean;
  result: CompileResult | null;
}

/** 大纲条目（从当前 tex 解析） */
interface OutlineItem {
  level: number; // 1=section 2=subsection 3=subsubsection
  title: string;
  line: number;
}

const SAVE_DEBOUNCE_MS = 600;
/** 停止编辑多久后自动编译（需大于保存防抖，编译前还会再 flushAll 兜底） */
const AUTO_COMPILE_DELAY_MS = 1500;
/** 反向定位后等待目标编辑器（含 \input 子文件异步加载）就绪的上限 */
const LOCATE_EDITOR_WAIT_MS = 5000;

/** 右侧预览/PDF 面板尺寸约束 */
const RIGHT_PANEL_DEFAULT_WIDTH = 420;
const RIGHT_PANEL_MIN_WIDTH = 260;
const RIGHT_PANEL_MAX_WIDTH = 640;
/** 无待审块时传给 CodeEditor 的稳定空数组引用（避免每次渲染触发 effect dispatch） */
const EMPTY_REVIEW_HUNKS: WritingRevision[] = [];

function parseOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const re = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const line = content.slice(0, m.index).split('\n').length;
    items.push({
      level: m[1] === 'section' ? 1 : m[1] === 'subsection' ? 2 : 3,
      title: m[2] || '',
      line,
    });
  }
  return items;
}

/** 复制到剪贴板（clipboard API 不可用时退回 execCommand） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

const WritingWorkspace: React.FC = () => {
  const { t } = useTranslation('writing');
  const {
    activeWorkspaceId, latexContent, setLatexContent, latexDirty,
    writingTabs, activeWritingFile, setWritingTabs, setActiveWritingFile,
    saveLatexToWorkspace, adoptLatexFromServer,
  } = usePaperMindStore();
  const wsId = activeWorkspaceId as string;

  // ---------- AI 写作审核（边写边审）：待审修订/编译事件/回滚补丁 ----------
  const pendingReviewMap = useWritingReviewStore((s) => s.revisionsByWs[wsId]);
  const reviewSyncNonce = useWritingReviewStore((s) => s.syncNonceByWs[wsId] ?? 0);
  const reviewBusyHunk = useWritingReviewStore((s) => s.busyHunk);
  const createdNonce = useWritingReviewStore((s) => s.createdNonceByWs[wsId] ?? 0);
  const compileEventWrap = useWritingReviewStore((s) => s.compileByWs[wsId]);
  const filePatch = useWritingReviewStore((s) => s.filePatchByWs[wsId]);
  const aiStreaming = useWritingReviewStore((s) => s.aiStreaming);

  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** 非 main.tex 文本文件的缓冲区（main 走 store.latexContent） */
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  /** 非 main 的未保存集合（main 用 latexDirty） */
  const [dirtySet, setDirtySet] = useState<Set<string>>(new Set());
  /** 保存中的文件（转圈状态） */
  const [savingSet, setSavingSet] = useState<Set<string>>(new Set());
  const [rightMode, setRightMode] = useState<RightMode>('pdf');
  const [compile, setCompile] = useState<CompileState>({ running: false, result: null });
  const [pdfVersion, setPdfVersion] = useState(0);
  /** 自动编译失败后暂停：直到下次手动编译解除（解除/置位以 autoPausedRef 为准） */
  const [autoPaused, setAutoPaused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  /** 右侧预览/PDF 面板宽度（可拖拽，双击分隔条恢复默认） */
  const [rightWidth, setRightWidth] = useState(RIGHT_PANEL_DEFAULT_WIDTH);

  /** 防抖保存定时器（按文件路径） */
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const editorRefs = useRef<Map<string, CodeEditorHandle>>(new Map());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 进行中/待触发的保存 Promise（手动保存、编译前 flush、卸载前 flush 用） */
  const pendingSaves = useRef<Map<string, Promise<void>>>(new Map());

  // ---------- 空闲自动编译（Overleaf 式） ----------
  /** 空闲倒计时；每次编辑重置 */
  const autoCompileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 有尚未编译的编辑（无编辑/已成功编译后为 false，避免无意义编译） */
  const needsCompileRef = useRef(false);
  /** 编译进行中（串行保护；期间编辑转为"结束后补一次"） */
  const compilingRef = useRef(false);
  /** 编译期间又发生了编辑：本轮结束后需补编译 */
  const pendingRecompileRef = useRef(false);
  /** 自动编译失败暂停态的镜像（定时器闭包读最新值） */
  const autoPausedRef = useRef(false);
  /** 最新 runCompile 的镜像（定时器在稳定回调里触发编译） */
  const runCompileRef = useRef<(source: 'manual' | 'auto') => Promise<void>>(async () => {});

  // ---------- 通用提示 ----------
  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  // ---------- 文件列表 ----------
  const refreshFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      setFiles(await listWorkspaceFiles(wsId));
    } catch (err) {
      flashNotice(err instanceof Error ? err.message : t('files.loadFailed'));
    } finally {
      setFilesLoading(false);
    }
  }, [wsId, t, flashNotice]);

  // ---------- 初始化：确保 main.tex + 拉文件列表 + 载入 main 内容 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureWritingEntry(wsId);
      } catch {
        // 后端不可用时下面列表也会失败，统一由刷新提示
      }
      try {
        const list = await listWorkspaceFiles(wsId);
        if (cancelled) return;
        setFiles(list);
        // 旧工作区首次补建了 main.tex 骨架，或本地尚无内容时，以服务端为准载入
        const hasMain = list.some((f) => f.path === MAIN_TEX);
        if (hasMain && usePaperMindStore.getState().latexContent === '') {
          try {
            const content = await readWorkspaceText(wsId, MAIN_TEX);
            if (!cancelled) setLatexContent(content);
          } catch {
            // 保留空内容
          }
        }
      } catch {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅随工作区切换执行；setLatexContent 稳定
  }, [wsId, setLatexContent]);

  // 工作区切换：清掉上一个工作区的缓冲区与定时器
  useEffect(() => () => {
    Object.values(saveTimers.current).forEach(clearTimeout);
    saveTimers.current = {};
    if (autoCompileTimerRef.current) {
      clearTimeout(autoCompileTimerRef.current);
      autoCompileTimerRef.current = null;
    }
    needsCompileRef.current = false;
    pendingRecompileRef.current = false;
    autoPausedRef.current = false;
    compilingRef.current = false;
    setAutoPaused(false);
    // 右面板不携带旧工作区的编译结果（避免残留失败日志 tab / PDF 版本号）
    setCompile({ running: false, result: null });
    setRightMode('pdf');
    setPdfVersion(0);
    setBuffers({});
    setDirtySet(new Set());
  }, [wsId]);

  // ---------- 缓冲区加载与保存 ----------
  const loadBuffer = useCallback(async (path: string) => {
    if (path === MAIN_TEX) return;
    setBuffers((prev) => (prev[path]?.status === 'ready'
      ? prev : { ...prev, [path]: { status: 'loading', content: '', saved: '' } }));
    try {
      const content = await readWorkspaceText(wsId, path);
      setBuffers((prev) => ({
        ...prev,
        [path]: { status: 'ready', content, saved: content },
      }));
      setDirtySet((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } catch (err) {
      setBuffers((prev) => ({
        ...prev,
        [path]: {
          status: 'error', content: '', saved: '',
          error: err instanceof Error ? err.message : t('files.loadFailed'),
        },
      }));
    }
  }, [wsId, t]);

  /** 立即写盘一个非 main 文本文件 */
  const saveBufferNow = useCallback((path: string, content: string) => {
    const oldTimer = saveTimers.current[path];
    if (oldTimer) {
      clearTimeout(oldTimer);
      delete saveTimers.current[path];
    }
    const task = (async () => {
      setSavingSet((prev) => new Set(prev).add(path));
      try {
        await writeWorkspaceText(wsId, path, content);
        setBuffers((prev) => (prev[path]
          ? { ...prev, [path]: { ...prev[path], saved: content } }
          : prev));
        setDirtySet((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } catch (err) {
        flashNotice(`${baseName(path)}: ${err instanceof Error ? err.message : t('files.saveFailed')}`);
      } finally {
        setSavingSet((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        pendingSaves.current.delete(path);
      }
    })();
    pendingSaves.current.set(path, task);
    return task;
  }, [wsId, t, flashNotice]);

  /**
   * 重新安排空闲自动编译（每次编辑调用，倒计时被重置）。
   * - 已暂停（上次自动编译失败）时不安排，等手动编译解除；
   * - 倒计时到点时若正在编译，仅标记"结束后补一次"，绝不并发重入。
   */
  const scheduleAutoCompile = useCallback(() => {
    if (autoCompileTimerRef.current) clearTimeout(autoCompileTimerRef.current);
    // AI RAG 流进行中不排本地空闲编译（AI 可能自行 compile_document；
    // 流末由 aiStreaming 下降边沿统一补编一次）
    if (useWritingReviewStore.getState().aiStreaming) {
      autoCompileTimerRef.current = null;
      return;
    }
    if (autoPausedRef.current) {
      autoCompileTimerRef.current = null;
      return;
    }
    autoCompileTimerRef.current = setTimeout(() => {
      autoCompileTimerRef.current = null;
      if (!needsCompileRef.current || autoPausedRef.current) return;
      if (compilingRef.current) {
        pendingRecompileRef.current = true;
        return;
      }
      void runCompileRef.current('auto');
    }, AUTO_COMPILE_DELAY_MS);
  }, []);

  /** 文本变更：更新缓冲区、标记 dirty、防抖保存 */
  const handleTextChange = useCallback((path: string, content: string) => {
    // 任意源码编辑都标记"有待编译改动"并重置空闲倒计时
    needsCompileRef.current = true;
    scheduleAutoCompile();
    if (path === MAIN_TEX) {
      setLatexContent(content);
      return;
    }
    setBuffers((prev) => {
      const buf = prev[path];
      if (!buf) return prev;
      return { ...prev, [path]: { ...buf, status: 'ready', content } };
    });
    setDirtySet((prev) => {
      const saved = buffers[path]?.saved ?? '';
      const shouldDirty = content !== saved;
      if (shouldDirty === prev.has(path)) return prev;
      const next = new Set(prev);
      if (shouldDirty) next.add(path);
      else next.delete(path);
      return next;
    });
    const oldTimer = saveTimers.current[path];
    if (oldTimer) clearTimeout(oldTimer);
    // 与磁盘基线一致（如 AI 远程内容灌入后的回环）：不落无意义的 PUT
    if (content === (buffers[path]?.saved ?? '')) {
      delete saveTimers.current[path];
      return;
    }
    saveTimers.current[path] = setTimeout(() => {
      delete saveTimers.current[path];
      saveBufferNow(path, content);
    }, SAVE_DEBOUNCE_MS);
  }, [buffers, setLatexContent, saveBufferNow, scheduleAutoCompile]);

  /** 手动保存 / 编译前落盘：main + 所有防抖队列与在途保存 */
  const flushAll = useCallback(async () => {
    const tasks: Promise<void>[] = [saveLatexToWorkspace()];
    // 非 main：合并防抖队列中的最新内容
    for (const [path, timer] of Object.entries(saveTimers.current)) {
      clearTimeout(timer);
      delete saveTimers.current[path];
      const content = buffers[path]?.content;
      if (content !== undefined) tasks.push(saveBufferNow(path, content));
    }
    // 已在请求途中的保存也要等完，避免编译早于落盘
    tasks.push(...pendingSaves.current.values());
    await Promise.all(tasks);
  }, [buffers, saveLatexToWorkspace, saveBufferNow]);

  /**
   * 采纳服务端文件内容为本地真相（AI 落盘同步 / 拒绝单块 / 事务回滚）。
   * - main.tex 走 adoptLatexFromServer（同步自动保存基线，latexDirty 清零）；
   * - 子文件把缓冲区 content/saved 一起换、清 dirty，并撤销挂起的防抖保存；
   * - CodeEditor 见到 value 变化后以 addToHistory=false 的远程事务替换文档，
   *   AI 的整批写入不污染用户撤销栈。
   */
  const applyServerFile = useCallback((path: string, content: string) => {
    if (path === MAIN_TEX) {
      adoptLatexFromServer(content);
      return;
    }
    const timer = saveTimers.current[path];
    if (timer) {
      clearTimeout(timer);
      delete saveTimers.current[path];
    }
    setBuffers((prev) => (prev[path]
      ? { ...prev, [path]: { ...prev[path], status: 'ready' as const, content, saved: content } }
      : prev));
    setDirtySet((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, [adoptLatexFromServer]);

  // 供卸载/切工作区闭包读取最新缓冲区内容
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  // 向 QA 面板注册 flush 桥：发送提问前确保 AI 读到的是已落盘内容
  useEffect(() => {
    registerWritingHost({ flushAll: () => flushAll() });
    return () => registerWritingHost(null);
  }, [flushAll]);

  // 挂载/切工作区：与后端对账待审修订（跨刷新可审）；切走时清旧 ws 缓存
  useEffect(() => {
    void useWritingReviewStore.getState().hydrate(wsId);
    return () => useWritingReviewStore.getState().resetWs(wsId);
  }, [wsId]);

  // AI 落盘/对账后：按 pending 修订涉及的路径拉取磁盘最新内容并远程灌入。
  // 200ms 合并同一轮流中连续到达的多个 diff；未打开的子文件跳过（打开时 loadBuffer 即新版）。
  useEffect(() => {
    if (!reviewSyncNonce) return undefined;
    const map = useWritingReviewStore.getState().revisionsByWs[wsId];
    if (!map) return undefined;
    const paths = Array.from(new Set(Object.values(map).map((r) => r.path)));
    if (paths.length === 0) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        for (const p of paths) {
          if (cancelled) return;
          if (p !== MAIN_TEX && !usePaperMindStore.getState().writingTabs.includes(p)) continue;
          try {
            const content = await readWorkspaceText(wsId, p);
            if (!cancelled) applyServerFile(p, content);
          } catch {
            // 文件可能在此期间被拒绝/回滚删除：忽略，等下一次 nonce
          }
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wsId, reviewSyncNonce, applyServerFile]);

  // AI 新建文件落盘后刷新文件树
  useEffect(() => {
    if (createdNonce > 0) void refreshFiles();
  }, [createdNonce, refreshFiles]);

  // 切走工作区/卸载前：把尚未防抖落盘的文件立即写回。
  // cleanup 闭包捕获的是旧 wsId 与旧 saveBufferNow，请求发往旧工作区，不影响新工作区
  useEffect(() => () => {
    for (const [path, timer] of Object.entries(saveTimers.current)) {
      clearTimeout(timer);
      delete saveTimers.current[path];
      const content = buffersRef.current[path]?.content;
      if (content !== undefined) void saveBufferNow(path, content);
    }
  }, [wsId, saveBufferNow]);

  // ---------- 标签操作 ----------
  const openFile = useCallback((path: string) => {
    if (!writingTabs.includes(path)) {
      setWritingTabs([...writingTabs, path]);
    }
    setActiveWritingFile(path);
    if (isTextFile(path)) void loadBuffer(path);
  }, [writingTabs, setWritingTabs, setActiveWritingFile, loadBuffer]);

  // 激活的文本标签若还没有缓冲区（例如从持久化快照恢复），自动拉取
  useEffect(() => {
    if (activeWritingFile !== MAIN_TEX
      && isTextFile(activeWritingFile)
      && !buffers[activeWritingFile]) {
      void loadBuffer(activeWritingFile);
    }
  }, [activeWritingFile, buffers, loadBuffer]);

  /**
   * 从本地移除若干文件的全部痕迹（防抖定时器/缓冲区/dirty/标签）。
   * 关闭标签、用户删除、AI 拒绝/回滚删除共用；main.tex 永不被驱逐。
   * 若激活标签被关，激活位切到其左侧最近的幸存标签（与手动关闭的邻接选择一致）。
   */
  const evictLocalFiles = useCallback((paths: string[]): boolean => {
    const removed = new Set(paths.filter((p) => p !== MAIN_TEX));
    if (removed.size === 0) return false;
    for (const p of removed) {
      const timer = saveTimers.current[p];
      if (timer) {
        clearTimeout(timer);
        delete saveTimers.current[p];
      }
    }
    setBuffers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of removed) {
        if (p in next) {
          delete next[p];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setDirtySet((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of removed) {
        if (next.has(p)) {
          next.delete(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    const tabs = usePaperMindStore.getState().writingTabs;
    const nextTabs = tabs.filter((p) => !removed.has(p));
    if (nextTabs.length === tabs.length) return false;
    const active = usePaperMindStore.getState().activeWritingFile;
    setWritingTabs(nextTabs);
    if (active && removed.has(active)) {
      const idx = tabs.indexOf(active);
      const leftNeighbor = tabs.slice(0, idx).filter((p) => !removed.has(p)).pop();
      setActiveWritingFile(leftNeighbor ?? nextTabs[0] ?? MAIN_TEX);
    }
    return true;
  }, [setWritingTabs, setActiveWritingFile]);

  const closeTab = useCallback((path: string) => {
    if (path === MAIN_TEX) return;
    if (!writingTabs.includes(path)) return;
    if (dirtySet.has(path) && !window.confirm(t('files.closeDirtyConfirm', { name: baseName(path) }))) {
      return;
    }
    // 用户确认放弃 → 挂起的防抖保存一并撤销（evictLocalFiles 内清理）
    evictLocalFiles([path]);
  }, [writingTabs, dirtySet, t, evictLocalFiles]);

  // ---------- 文件增删传 ----------
  const handleCreate = useCallback(async (relPath: string) => {
    await writeWorkspaceText(wsId, relPath, '');
    await refreshFiles();
    openFile(relPath);
  }, [wsId, refreshFiles, openFile]);

  const handleUpload = useCallback(async (fileList: FileList) => {
    setUploading(true);
    const failures: string[] = [];
    for (const file of Array.from(fileList)) {
      try {
        await uploadWorkspaceFile(wsId, file);
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    setUploading(false);
    await refreshFiles();
    if (failures.length > 0) {
      window.alert(`${t('files.uploadFailed')}\n${failures.join('\n')}`);
    }
  }, [wsId, t, refreshFiles]);

  const handleDelete = useCallback(async (path: string) => {
    if (path === MAIN_TEX) return;
    if (!window.confirm(t('files.deleteConfirm', { name: baseName(path) }))) return;
    try {
      await deleteWorkspaceFile(wsId, path);
      evictLocalFiles([path]);
      await refreshFiles();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t('files.deleteFailed'));
    }
  }, [wsId, t, refreshFiles, evictLocalFiles]);

  // ---------- AI 修改的逐块接受 / 拒绝（CodeEditor 内联审核条回调） ----------
  const handleReviewAction = useCallback(async (revId: number, action: 'accept' | 'reject') => {
    const review = useWritingReviewStore.getState();
    const rev = review.revisionsByWs[wsId]?.[revId];
    if (!rev) return;
    if (action === 'accept') {
      const ok = await review.acceptHunk(wsId, revId);
      if (!ok) {
        flashNotice(useWritingReviewStore.getState().lastError ?? t('review.actionFailed'));
      }
      return;
    }
    const result = await review.rejectHunk(wsId, revId);
    if (!result) {
      flashNotice(useWritingReviewStore.getState().lastError ?? t('review.actionFailed'));
      return;
    }
    // 文本类修订：服务端已反向还原，用返回内容回填（远程事务，不进撤销栈）
    if (result.file) applyServerFile(result.file.path, result.file.content);
    // create 修订：文件被删除，关标签并刷新文件树
    if (result.deleted) {
      evictLocalFiles([result.deleted]);
      void refreshFiles();
    }
  }, [wsId, t, flashNotice, applyServerFile, evictLocalFiles, refreshFiles]);

  const copyImageRef = useCallback(async (path: string): Promise<boolean> => {
    const ok = await copyText(`\\includegraphics{${graphicxRef(path)}}`);
    flashNotice(ok ? t('files.refCopied', { path }) : t('files.copyFailed'));
    return ok;
  }, [t, flashNotice]);

  // ---------- 编译（手动 / 空闲自动） ----------
  /**
   * 执行一次编译。source 决定失败后的策略：
   * - 自动编译失败 → 暂停自动编译（autoPaused），直到下次手动编译；
   * - 成功后重置待编译标记、刷新 PDF；log tab 仅失败时存在，成功必回 pdf tab；
   * - 编译期间又有编辑（pendingRecompile）：若未被暂停，结束后再排一次自动编译。
   */
  const runCompile = useCallback(async (source: 'manual' | 'auto') => {
    compilingRef.current = true;
    setCompile((prev) => ({ ...prev, running: true }));
    let result: CompileResult;
    try {
      // 先落盘全部改动（main + 各标签），保证编译的是最新内容
      await flushAll();
      result = await compileWorkspace(wsId);
    } catch (err) {
      result = {
        ok: false,
        message: err instanceof Error ? err.message : t('compile.failed'),
        log: '',
        pdf: null,
      };
    }
    setCompile({ running: false, result });
    compilingRef.current = false;

    if (result.ok) {
      needsCompileRef.current = false;
      setPdfVersion((v) => v + 1);
      setRightMode('pdf');
      void refreshFiles();
      if (source === 'manual') flashNotice(result.message || t('compile.ok'));
    } else {
      // 失败展示日志；自动触发的失败 → 暂停自动编译，等待手动恢复
      setRightMode('log');
      if (source === 'auto') {
        autoPausedRef.current = true;
        setAutoPaused(true);
      }
    }

    if (pendingRecompileRef.current) {
      pendingRecompileRef.current = false;
      if (!autoPausedRef.current && needsCompileRef.current) scheduleAutoCompile();
    }
  }, [wsId, t, flushAll, refreshFiles, flashNotice, scheduleAutoCompile]);
  // 供稳定的空闲定时器闭包调用最新版本
  runCompileRef.current = runCompile;

  // AI compile_document 结果：直接刷新编译面板与 PDF（本地 needsCompile 清掉，
  // 避免流末补编与 AI 自己的编译重复）
  useEffect(() => {
    if (!compileEventWrap) return;
    const ev = compileEventWrap.event;
    needsCompileRef.current = false;
    setCompile({
      running: false,
      result: {
        ok: ev.ok,
        message: ev.message,
        // SSE 不带整段 log；结构化错误清单已足够，日志面板缺省走 noLog 文案
        log: '',
        pdf: null,
        errors: ev.errors,
      },
    });
    if (ev.ok) {
      setPdfVersion((v) => v + 1);
      setRightMode('pdf');
      void refreshFiles();
    } else {
      setRightMode('log');
    }
  }, [compileEventWrap, refreshFiles]);

  // 整事务回滚的物理结果：回填被还原文件、驱逐被删文件，冲突/保留给出提示
  useEffect(() => {
    if (!filePatch) return;
    for (const f of filePatch.files) applyServerFile(f.path, f.content);
    if (filePatch.deleted.length > 0) {
      evictLocalFiles(filePatch.deleted);
      void refreshFiles();
    }
    if (filePatch.error) {
      flashNotice(filePatch.error);
    } else if (filePatch.kept.length > 0) {
      flashNotice(t('review.rollbackKept', {
        names: filePatch.kept.map((p) => baseName(p)).join(', '),
      }));
    }
  }, [filePatch, applyServerFile, evictLocalFiles, refreshFiles, flashNotice, t]);

  // AI 流结束（下降沿）：流期间挂起的空闲自动编译在此补一次；
  // AI 已自行 compile_document 时 needsCompile 已被上面的事件清零，不会重复编译
  const streamingPrevRef = useRef(aiStreaming);
  useEffect(() => {
    const wasStreaming = streamingPrevRef.current;
    streamingPrevRef.current = aiStreaming;
    if (wasStreaming && !aiStreaming
      && needsCompileRef.current && !autoPausedRef.current && !compilingRef.current) {
      void runCompileRef.current('auto');
    }
  }, [aiStreaming]);

  /** 手动编译：同时作为"恢复自动编译"的唯一动作 */
  const handleManualCompile = useCallback(() => {
    autoPausedRef.current = false;
    setAutoPaused(false);
    if (autoCompileTimerRef.current) {
      clearTimeout(autoCompileTimerRef.current);
      autoCompileTimerRef.current = null;
    }
    needsCompileRef.current = true;
    pendingRecompileRef.current = false;
    void runCompileRef.current('manual');
  }, []);

  // ---------- 双击 PDF → SyncTeX 反向定位源码 ----------
  /**
   * 跳转到指定文件的指定行。多文件文档命中的可能是尚未打开的 \input 子文件：
   * openFile 会触发标签挂载与缓冲区网络加载，这里轮询等 CodeMirror 就绪
   * （CodeEditor 仅在 buffer ready 后才挂载，挂载即带完整内容），再 scrollToLine。
   */
  const locateInEditor = useCallback(async (path: string, line: number) => {
    const waitUntil = Date.now() + LOCATE_EDITOR_WAIT_MS;
    let handle = editorRefs.current.get(path);
    while ((!handle || !handle.isReady()) && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 60));
      handle = editorRefs.current.get(path);
    }
    if (!handle || !handle.isReady()) {
      flashNotice(t('compile.locateTimeout', { name: baseName(path) }));
      return;
    }
    handle.scrollToLine(line);
  }, [flashNotice, t]);

  const handleInverseLocate = useCallback(async (point: InverseLocatePoint) => {
    try {
      const loc = await synctexInverse(wsId, point);
      if (!isTextFile(loc.file)) {
        flashNotice(t('compile.locateUnsupported', { name: baseName(loc.file) }));
        return;
      }
      // 子文件：打开标签（已打开则仅激活）并触发缓冲区加载，再等就绪跳行
      if (loc.file !== activeWritingFile) openFile(loc.file);
      await locateInEditor(loc.file, loc.line);
    } catch (err) {
      flashNotice(err instanceof Error ? err.message : t('compile.locateFailed'));
    }
  }, [wsId, activeWritingFile, openFile, locateInEditor, flashNotice, t]);

  // ---------- 大纲 ----------
  const activePath = activeWritingFile;
  const activeIsText = isTextFile(activePath);
  const activeTextContent = activePath === MAIN_TEX
    ? latexContent
    : (buffers[activePath]?.status === 'ready' ? buffers[activePath].content : '');
  const outline = useMemo(
    () => (activePath.endsWith('.tex') ? parseOutline(activeTextContent) : []),
    [activePath, activeTextContent],
  );

  const activeEditor = (): CodeEditorHandle | null =>
    activeIsText ? (editorRefs.current.get(activePath) ?? null) : null;

  const imageFiles = useMemo(() => files.filter((f) => isImageFile(f.path)), [files]);

  // 待审 AI 修改块按文件分组（供各 CodeEditor 内联 diff；引用稳定避免多余 dispatch）
  const reviewHunksByPath = useMemo(() => {
    const grouped: Record<string, WritingRevision[]> = {};
    if (pendingReviewMap) {
      for (const rev of Object.values(pendingReviewMap)) {
        (grouped[rev.path] ??= []).push(rev);
      }
      for (const arr of Object.values(grouped)) arr.sort((a, b) => a.id - b.id);
    }
    return grouped;
  }, [pendingReviewMap]);

  const dirtyAll = useMemo(() => {
    const all = new Set(dirtySet);
    if (latexDirty) all.add(MAIN_TEX);
    return all;
  }, [dirtySet, latexDirty]);

  const anySaving = savingSet.size > 0 || compile.running;
  /** 工作区内已有编译产物（即便本次会话尚未点过编译，也可直接查看） */
  const hasPdf = files.some((f) => f.path === 'main.pdf');
  const pdfUrl = `${workspaceFileUrl(wsId, 'main.pdf')}?v=${pdfVersion}`;

  // ---------- 渲染 ----------
  return (
    <div className="h-full flex min-h-0">
      {/* 左：文件树 + 大纲 */}
      <aside className="w-56 flex-shrink-0 flex flex-col min-h-0 bg-surface/30 border-r border-border">
        <div className="flex-1 min-h-0">
          <FileTree
            files={files}
            activePath={activePath}
            openTabs={new Set(writingTabs)}
            loading={filesLoading}
            uploading={uploading}
            onOpen={openFile}
            onRefresh={refreshFiles}
            onCreate={handleCreate}
            onUpload={handleUpload}
            onDelete={handleDelete}
            onCopyImageRef={copyImageRef}
          />
        </div>
        <div className="h-48 flex-shrink-0 border-t border-border flex flex-col min-h-0">
          <button
            type="button"
            className="flex items-center justify-between px-2.5 py-2 text-xs font-medium text-textSecondary hover:text-text transition-colors"
            onClick={() => setOutlineCollapsed((v) => !v)}
          >
            <span className="flex items-center gap-1.5">
              <ListTree size={13} />
              {t('structure.title')}
            </span>
            {outlineCollapsed ? '+' : '−'}
          </button>
          {!outlineCollapsed && (
            <div className="flex-1 overflow-y-auto pb-2">
              {outline.length === 0 ? (
                <p className="px-3 py-2 text-xs text-textSecondary/60">{t('structure.empty')}</p>
              ) : (
                outline.map((item, i) => (
                  <button
                    key={`${item.line}-${i}`}
                    type="button"
                    onClick={() => activeEditor()?.scrollToLine(item.line)}
                    className={[
                      'w-full text-left truncate py-1 pr-2 text-xs text-textSecondary hover:text-text hover:bg-white/5 transition-colors',
                      item.level === 1 ? 'font-medium text-text' : '',
                    ].join(' ')}
                    style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
                    title={item.title}
                  >
                    {item.title || `L${item.line}`}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </aside>

      {/* 中：标签页 + 工具栏 + 编辑区 */}
      <section className="flex-1 min-w-0 flex flex-col h-full bg-background">
        <EditorTabs
          tabs={writingTabs}
          activePath={activePath}
          dirty={dirtyAll}
          onSelect={(p) => {
            setActiveWritingFile(p);
            if (isTextFile(p)) void loadBuffer(p);
          }}
          onClose={closeTab}
        />

        {activeIsText && (
          <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-surface/40 flex-shrink-0">
            <ToolbarButton title={t('toolbar.undo')} onClick={() => activeEditor()?.undo()}>
              <Undo2 size={14} />
            </ToolbarButton>
            <ToolbarButton title={t('toolbar.redo')} onClick={() => activeEditor()?.redo()}>
              <Redo2 size={14} />
            </ToolbarButton>
            <span className="w-px h-4 bg-border mx-1" />
            <ToolbarButton title={t('toolbar.section')} onClick={() => activeEditor()?.insertLineCommand('\\section')}>
              <Heading1 size={14} />
            </ToolbarButton>
            <ToolbarButton title={t('toolbar.subsection')} onClick={() => activeEditor()?.insertLineCommand('\\subsection')}>
              <Heading2 size={14} />
            </ToolbarButton>
            <ToolbarButton
              title={t('toolbar.bold')}
              onClick={() => activeEditor()?.wrapSelection('\\textbf{', '}', 'text')}
            >
              <Bold size={14} />
            </ToolbarButton>
            <ToolbarButton
              title={t('toolbar.italic')}
              onClick={() => activeEditor()?.wrapSelection('\\textit{', '}', 'text')}
            >
              <Italic size={14} />
            </ToolbarButton>
            <ToolbarButton
              title={t('toolbar.itemize')}
              onClick={() => activeEditor()?.wrapLinesInEnvironment('itemize', true)}
            >
              <List size={14} />
            </ToolbarButton>
            <ToolbarButton
              title={t('toolbar.enumerate')}
              onClick={() => activeEditor()?.wrapLinesInEnvironment('enumerate', true)}
            >
              <ListOrdered size={14} />
            </ToolbarButton>
            <ToolbarButton
              title={t('toolbar.link')}
              onClick={() => activeEditor()?.insertText('\\href{}{}', '\\href{'.length)}
            >
              <Link2 size={14} />
            </ToolbarButton>
            {activePath.endsWith('.tex') && imageFiles.length > 0 && (
              <div className="relative group">
                <ToolbarButton title={t('toolbar.image')}>
                  <ImageIcon size={14} />
                </ToolbarButton>
                <div className="absolute left-0 top-full z-30 hidden group-hover:block pt-1">
                  <div className="max-h-56 w-52 overflow-y-auto rounded-md border border-border bg-surface shadow-xl py-1">
                    {imageFiles.map((f) => (
                      <button
                        key={f.path}
                        type="button"
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-textSecondary hover:bg-white/10 hover:text-text truncate"
                        onClick={() => activeEditor()?.insertText(`\\includegraphics{${graphicxRef(f.path)}}`)}
                        title={f.path}
                      >
                        <ImageIcon size={12} className="text-violet-400 flex-shrink-0" />
                        <span className="truncate">{baseName(f.path)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1" />

            {/* 保存状态 + 保存/编译 */}
            <span className="flex items-center gap-1 text-[11px] text-textSecondary/60 mr-1">
              {savingSet.has(activePath) && <Loader2 size={11} className="animate-spin" />}
              {savingSet.has(activePath)
                ? t('status.saving')
                : dirtyAll.has(activePath) ? t('status.unsaved') : t('status.saved')}
            </span>
            <button
              type="button"
              onClick={() => void flushAll()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-textSecondary hover:text-text hover:bg-white/10 transition-colors"
              title={t('toolbar.save')}
            >
              <Save size={13} />
              <span className="hidden lg:inline">{t('toolbar.save')}</span>
            </button>
            <button
              type="button"
              onClick={handleManualCompile}
              disabled={compile.running}
              className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors"
              title={t('toolbar.compile')}
            >
              {compile.running
                ? <Loader2 size={13} className="animate-spin" />
                : <Play size={13} />}
              {t('toolbar.compile')}
            </button>
          </div>
        )}

        {/* 编辑/预览主区域：所有已打开的文本编辑器常驻（display 切换保留撤销栈） */}
        <div className="flex-1 min-h-0 relative">
          {writingTabs.filter(isTextFile).map((path) => {
            const isActive = path === activePath;
            if (path === MAIN_TEX) {
              return (
                <CodeEditor
                  key={path}
                  ref={(handle) => {
                    if (handle) editorRefs.current.set(path, handle);
                    else editorRefs.current.delete(path);
                  }}
                  path={path}
                  value={latexContent}
                  mode={modeForPath(path)}
                  active={isActive}
                  requireFocusOnActive
                  onChange={(v) => handleTextChange(path, v)}
                  reviewHunks={reviewHunksByPath[path] ?? EMPTY_REVIEW_HUNKS}
                  reviewBusyId={reviewBusyHunk}
                  onReviewAction={handleReviewAction}
                />
              );
            }
            const buf = buffers[path];
            if (!buf || buf.status === 'loading') {
              return isActive ? (
                <CenteredState key={path}>
                  <Loader2 size={18} className="animate-spin text-textSecondary" />
                </CenteredState>
              ) : null;
            }
            if (buf.status === 'error') {
              return isActive ? (
                <CenteredState key={path}>
                  <FileWarning size={20} className="text-amber-400" />
                  <p className="text-xs text-textSecondary mt-2">{buf.error}</p>
                  <div className="flex gap-2 mt-3">
                    <button
                      type="button"
                      className="px-2.5 py-1 text-xs rounded bg-white/10 text-text hover:bg-white/20"
                      onClick={() => void loadBuffer(path)}
                    >
                      {t('files.retry')}
                    </button>
                    <button
                      type="button"
                      className="px-2.5 py-1 text-xs rounded text-textSecondary hover:bg-white/10"
                      onClick={() => closeTab(path)}
                    >
                      {t('files.close')}
                    </button>
                  </div>
                </CenteredState>
              ) : null;
            }
            return (
              <CodeEditor
                key={path}
                ref={(handle) => {
                  if (handle) editorRefs.current.set(path, handle);
                  else editorRefs.current.delete(path);
                }}
                path={path}
                value={buf.content}
                mode={modeForPath(path)}
                active={isActive}
                requireFocusOnActive
                onChange={(v) => handleTextChange(path, v)}
                reviewHunks={reviewHunksByPath[path] ?? EMPTY_REVIEW_HUNKS}
                reviewBusyId={reviewBusyHunk}
                onReviewAction={handleReviewAction}
              />
            );
          })}

          {/* 二进制预览标签覆盖在编辑区 */}
          {!activeIsText && isViewableBinary(activePath) && (
            <div className="absolute inset-0">
              <BinaryViewer wsId={wsId} path={activePath} onCopyImageRef={copyImageRef} />
            </div>
          )}

          {/* 既不可编辑也不可预览 */}
          {!activeIsText && !isViewableBinary(activePath) && (
            <CenteredState>
              <FileText size={20} className="text-textSecondary/60" />
              <p className="text-xs text-textSecondary mt-2">{t('files.notEditable')}</p>
            </CenteredState>
          )}

          {/* 全局轻提示 */}
          {notice && (
            <div className="absolute left-1/2 bottom-4 -translate-x-1/2 z-40 px-3 py-1.5 rounded-md bg-white/10 border border-border text-xs text-text shadow-lg">
              {notice}
            </div>
          )}
          {anySaving && !compile.running && (
            <div className="absolute right-3 bottom-3 z-40 flex items-center gap-1.5 text-[11px] text-textSecondary/60">
              <Loader2 size={11} className="animate-spin" />
              {t('status.saving')}
            </div>
          )}
        </div>
      </section>

      {/* 右：编译 PDF / 编译日志（宽度可拖拽；阅读器与阅读模块共用 PdfViewer） */}
      <ResizableDivider
        placement="right"
        size={rightWidth}
        min={RIGHT_PANEL_MIN_WIDTH}
        max={RIGHT_PANEL_MAX_WIDTH}
        onResize={setRightWidth}
        onDoubleClickReset={() => setRightWidth(RIGHT_PANEL_DEFAULT_WIDTH)}
      />
      <aside
        className="flex-shrink-0 flex flex-col min-h-0 border-l border-border bg-background"
        style={{ width: `${rightWidth}px` }}
      >
        <div className="flex items-center gap-1 px-2 pt-1.5 border-b border-border flex-shrink-0">
          <RightTab active={rightMode === 'pdf'} onClick={() => setRightMode('pdf')}>
            {t('compile.pdfTab')}
          </RightTab>
          {compile.result && !compile.result.ok && (
            <RightTab active={rightMode === 'log'} onClick={() => setRightMode('log')} danger>
              <AlertTriangle size={11} className="mr-1" />
              {t('compile.logTab')}
            </RightTab>
          )}
        </div>

        {/* relative：为内部 absolute 空状态（如 PDF 未编译提示）提供定位边界，
            避免其逃逸到视口铺满全屏、拦截整页点击 */}
        <div className="flex-1 min-h-0 relative">
          {rightMode === 'pdf' && (
            pdfVersion === 0 && !hasPdf ? (
              <CenteredState>
                <Play size={22} className="text-textSecondary/60" />
                <p className="text-xs text-textSecondary mt-2 text-center leading-relaxed px-6">
                  {t('compile.pdfEmpty')}
                </p>
                <button
                  type="button"
                  onClick={handleManualCompile}
                  disabled={compile.running}
                  className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-60"
                >
                  {compile.running && <Loader2 size={12} className="animate-spin" />}
                  {t('toolbar.compile')}
                </button>
              </CenteredState>
            ) : (
              <div className="h-full">
                <PdfViewer url={pdfUrl} onInverseLocate={handleInverseLocate} />
                {compile.running && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface/95 border border-border text-[11px] text-textSecondary shadow-lg">
                    <Loader2 size={11} className="animate-spin" />
                    {t('status.compiling')}
                  </div>
                )}
              </div>
            )
          )}
          {rightMode === 'log' && compile.result && (
            <div className="h-full flex flex-col min-h-0">
              <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border-b border-red-500/30 flex-shrink-0">
                <AlertTriangle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-red-300">{compile.result.message}</p>
                </div>
              </div>
              {autoPaused && (
                <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 flex-shrink-0">
                  <AlertTriangle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] leading-relaxed text-amber-200/90">{t('compile.autoPaused')}</p>
                    <button
                      type="button"
                      onClick={handleManualCompile}
                      disabled={compile.running}
                      className="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 disabled:opacity-60 transition-colors"
                    >
                      {compile.running && <Loader2 size={11} className="animate-spin" />}
                      {t('compile.resume')}
                    </button>
                  </div>
                </div>
              )}
              <pre className="flex-1 min-h-0 overflow-auto m-0 p-3 text-[11px] leading-relaxed font-mono text-textSecondary whitespace-pre-wrap break-words">
                {compile.result.log || t('compile.noLog')}
              </pre>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};

// ---------- 局部小元件 ----------
const ToolbarButton: React.FC<{
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    className="p-1.5 rounded text-textSecondary hover:text-text hover:bg-white/10 transition-colors"
  >
    {children}
  </button>
);

const RightTab: React.FC<{
  active: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, danger, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={[
      'flex items-center px-2.5 py-1.5 text-xs rounded-t-md border border-b-0 transition-colors',
      active
        ? (danger ? 'text-red-300 bg-red-500/10 border-red-500/30' : 'text-text bg-surface border-border')
        : 'text-textSecondary hover:text-text border-transparent',
    ].join(' ')}
  >
    {children}
  </button>
);

const CenteredState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center">
    {children}
  </div>
);

export default WritingWorkspace;
