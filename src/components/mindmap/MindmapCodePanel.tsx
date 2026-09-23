/**
 * Mermaid 代码面板 —— 几何画布与 mermaid 文本的融合点（FR-2）。
 *
 * 语义分工：
 * - 画布 doc 是真源，面板文本默认实时镜像 docToMermaid(doc)（含稳定 ID 注解）；
 * - 用户编辑期间（dirty）不被外部更新覆盖，顶部给出「未应用」提示；
 * - 编辑时持续做语法体检（debounce 300ms，走与后端逐字节对齐的 parseMermaid），
 *   错误显示行号，点击可跳转；有错误时禁止应用；
 * - 「应用到画布」：parseMermaid → mergeDoc（结构以文本为准、几何以画布为准）
 *   → onApplyTarget，最终通过 /actions 增量管线落库，不做整文档替换；
 * - 「预览」用动态 import 的 mermaid 库只读渲染（独立 chunk，不拖慢首屏），
 *   预览失败不影响编辑与应用。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, Code2, PencilLine, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MindmapDoc } from '../../types';
import { MindmapError, docToMermaid, mergeDoc, parseMermaid } from '../../lib/mindmap';

export interface MindmapCodePanelProps {
  doc: MindmapDoc;
  onApplyTarget: (target: MindmapDoc) => void;
  readOnly?: boolean;
  className?: string;
}

interface LintError {
  line: number | null;
  key: string;
  params: Record<string, unknown>;
}

type Mode = 'edit' | 'preview';

/** mermaid 库只在首次切到预览时加载，所有面板实例共享同一个 Promise */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let previewSeq = 0;

const MindmapCodePanel: React.FC<MindmapCodePanelProps> = ({
  doc,
  onApplyTarget,
  readOnly = false,
  className,
}) => {
  const { t } = useTranslation('mindmap');
  const canonical = useMemo(() => docToMermaid(doc), [doc]);

  const [text, setText] = useState(canonical);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [mode, setMode] = useState<Mode>('edit');
  const [lint, setLint] = useState<LintError | null>(null);
  const [previewState, setPreviewState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'ready'; svg: string } | { status: 'failed'; message: string }
  >({ status: 'idle' });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);

  // 外部文档变化（画布编辑 / AI diff / 对账重映射）：干净态实时镜像
  useEffect(() => {
    if (!dirtyRef.current) setText(canonical);
  }, [canonical]);

  // 编辑期持续体检（300ms 防抖）
  useEffect(() => {
    if (!dirty) {
      setLint(null);
      return;
    }
    const handle = window.setTimeout(() => {
      try {
        parseMermaid(text);
        setLint(null);
      } catch (e) {
        if (e instanceof MindmapError) {
          const line = typeof e.params.line === 'number' ? (e.params.line as number) : null;
          setLint({ line, key: e.key, params: e.params });
        } else {
          // parseMermaid 契约只抛 MindmapError；走到这里属于内核缺陷，暴露而非吞掉
          throw e;
        }
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [text, dirty]);

  const errText = useCallback(
    (e: LintError) => {
      const short = e.key.startsWith('mindmap.') ? e.key.slice('mindmap.'.length) : e.key;
      return t(`err.${short}`, e.params as Record<string, string | number>);
    },
    [t]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
  }, []);

  const handleReset = useCallback(() => {
    setText(canonical);
    dirtyRef.current = false;
    setDirty(false);
    setLint(null);
  }, [canonical]);

  const handleApply = useCallback(() => {
    let parsed: MindmapDoc;
    try {
      parsed = parseMermaid(text);
    } catch (e) {
      if (e instanceof MindmapError) {
        const line = typeof e.params.line === 'number' ? (e.params.line as number) : null;
        setLint({ line, key: e.key, params: e.params });
      } else {
        throw e;
      }
      return;
    }
    // 结构以文本为准、几何以画布为准；新节点由 tidy-tree 补位
    const merged = mergeDoc(structuredClone(doc), structuredClone(parsed));
    onApplyTarget(merged);
    // 应用后以合并结果的规范序列化覆盖编辑缓冲（ID 注解等被归一）
    const nextCanonical = docToMermaid(merged);
    setText(nextCanonical);
    dirtyRef.current = false;
    setDirty(false);
    setLint(null);
  }, [text, doc, onApplyTarget]);

  const jumpToLine = useCallback((line: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    const lineLen = Math.min(lines[line - 1]?.length ?? 0, 200);
    ta.focus();
    ta.setSelectionRange(offset, offset + lineLen);
    const approxTop = (offset / Math.max(text.length, 1)) * ta.scrollHeight;
    ta.scrollTop = Math.max(0, approxTop - ta.clientHeight / 3);
  }, [text]);

  // 预览：mermaid 动态加载 + 400ms 防抖 + 过期结果丢弃
  useEffect(() => {
    if (mode !== 'preview') return;
    const seq = ++previewSeq;
    setPreviewState({ status: 'loading' });
    let cancelled = false;
    const timer = window.setTimeout(() => {
      loadMermaid()
        .then(async (mermaid) => {
          if (cancelled || seq !== previewSeq) return;
          try {
            const id = `mmd-preview-${Date.now()}-${seq}`;
            const { svg } = await mermaid.render(id, text);
            if (!cancelled && seq === previewSeq) setPreviewState({ status: 'ready', svg });
          } catch (e) {
            if (!cancelled && seq === previewSeq) {
              const message = e instanceof Error ? e.message : String(e);
              setPreviewState({ status: 'failed', message });
            }
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && seq === previewSeq) {
            setPreviewState({
              status: 'failed',
              message: e instanceof Error ? e.message : String(e),
            });
          }
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, text]);

  // 预览 svg 注入
  useEffect(() => {
    if (previewState.status === 'ready' && previewHostRef.current) {
      previewHostRef.current.innerHTML = previewState.svg;
    }
  }, [previewState]);

  const applyDisabled = readOnly || !dirty || lint !== null;

  return (
    <aside
      className={`flex h-full w-full flex-col border-l border-border bg-surface ${className ?? ''}`}
      data-mm-code-panel="1"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Code2 size={15} className="text-textSecondary" />
        <span className="text-sm font-medium text-text">{t('code.title')}</span>
        {dirty && !readOnly && (
          <span
            className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
            title={t('code.dirty')}
          >
            {t('code.dirty')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-md border border-border p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`flex items-center gap-1 rounded px-2 py-1 ${
                mode === 'edit' ? 'bg-white/10 text-text' : 'text-textSecondary hover:text-text'
              }`}
            >
              <PencilLine size={12} />
              {t('code.edit')}
            </button>
            <button
              type="button"
              onClick={() => setMode('preview')}
              className={`flex items-center gap-1 rounded px-2 py-1 ${
                mode === 'preview' ? 'bg-white/10 text-text' : 'text-textSecondary hover:text-text'
              }`}
            >
              <Eye size={12} />
              {t('code.preview')}
            </button>
          </div>
        </div>
      </div>

      {mode === 'edit' ? (
        <div className="relative min-h-0 flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            readOnly={readOnly}
            spellCheck={false}
            data-mm-editing="1"
            className="h-full w-full resize-none bg-background p-3 font-mono text-xs leading-5 text-text outline-none placeholder:text-textSecondary/50"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-background p-4">
          {previewState.status === 'loading' && (
            <div className="text-xs text-textSecondary">{t('code.previewLoading')}</div>
          )}
          {previewState.status === 'failed' && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle size={13} />
                {t('code.previewFailed')}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-red-300/80">
                {previewState.message}
              </pre>
            </div>
          )}
          <div ref={previewHostRef} className="mmd-preview-host flex justify-center [&_svg]:max-w-full" />
        </div>
      )}

      {lint && mode === 'edit' && (
        <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              {lint.line !== null && (
                <button
                  type="button"
                  onClick={() => jumpToLine(lint.line as number)}
                  title={t('code.gotoLine', { line: lint.line })}
                  className="mr-1.5 rounded bg-red-500/20 px-1.5 py-0.5 font-mono font-semibold text-red-200 hover:bg-red-500/30"
                >
                  L{lint.line}
                </button>
              )}
              <span className="break-words">{errText(lint)}</span>
            </div>
          </div>
        </div>
      )}

      {mode === 'edit' && !readOnly && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-textSecondary transition-colors hover:bg-white/5 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={12} />
            {t('code.reset')}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={applyDisabled}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('code.apply')}
          </button>
        </div>
      )}
    </aside>
  );
};

export default MindmapCodePanel;
