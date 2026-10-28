/**
 * Markdown 源码面板 —— 几何画布与 Markdown 嵌套列表文本的融合点。
 *
 * 语义分工：
 * - 画布 doc 是真源，面板文本默认实时镜像 docToMarkdown(doc)（含稳定 ID 注解）；
 * - 用户编辑期间（dirty）不被外部更新覆盖，顶部给出「未应用」提示；
 * - 编辑时持续做语法体检（debounce 300ms，走与后端逐字节对齐的 parseMarkdown），
 *   错误显示行号，点击可跳转；有错误时禁止应用；
 * - 「应用到画布」：parseMarkdown → mergeDoc（结构以文本为准、几何以画布为准）
 *   → onApplyTarget，最终通过 /actions 增量管线落库，不做整文档替换；
 * - 画布是实时预览（treeLayout 算初始位置，用户可拖拽调整），
 *   源码面板不做独立 SVG 渲染。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Code2, PencilLine, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MindmapDoc } from '../../types';
import {
  MindmapError,
  docToElixir,
  elixirToDoc,
  mergeDoc,
} from '../../lib/mindmap';
import { parseMarkdownToElixir, elixirToMarkdown } from '../../lib/mindmap/elixirMarkdown';

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

const MindmapCodePanel: React.FC<MindmapCodePanelProps> = ({
  doc,
  onApplyTarget,
  readOnly = false,
  className,
}) => {
  const { t } = useTranslation('mindmap');
  const canonical = useMemo(() => elixirToMarkdown(docToElixir(doc)), [doc]);

  const [text, setText] = useState(canonical);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [lint, setLint] = useState<LintError | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        // parseMarkdownToElixir 返回 MindElixirData（嵌套树），验证格式正确即可
        parseMarkdownToElixir(text);
        setLint(null);
      } catch (e) {
        if (e instanceof MindmapError) {
          const line = typeof e.params.line === 'number' ? (e.params.line as number) : null;
          setLint({ line, key: e.key, params: e.params });
        } else {
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
    let elixirData;
    try {
      elixirData = parseMarkdownToElixir(text);
    } catch (e) {
      if (e instanceof MindmapError) {
        const line = typeof e.params.line === 'number' ? (e.params.line as number) : null;
        setLint({ line, key: e.key, params: e.params });
      } else {
        throw e;
      }
      return;
    }
    const parsed = elixirToDoc(elixirData);
    // 结构以文本为准、几何以画布为准（画布现在用 mind-elixir，几何由它内部管，
    // MindmapDoc 里的 x/y 字段也不再使用）
    const merged = mergeDoc(structuredClone(doc), structuredClone(parsed));
    onApplyTarget(merged);
    // 应用后以合并结果的规范序列化覆盖编辑缓冲
    const nextCanonical = elixirToMarkdown(docToElixir(merged));
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
      </div>

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

      {lint && (
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

      {!readOnly && (
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
