/**
 * 非 mindmap 图（flowchart / sequenceDiagram / timeline …）的源码面板。
 *
 * 与思维导图代码面板（MindmapCodePanel）的分工：
 * - 该图没有节点树，文本即真源：编辑 textarea 直接修改 mermaid 原文，
 *   「保存」经 PUT /mindmaps/<id>/source 整段替换（store.replaceMindmapSource）；
 * - 保存后图类型可能变化：改成 mindmap 头 → 解析成树，外层自动切到树画布；
 *   改成另一种图 → 仍在本视图，只是图类型徽标变化（无数据损失，不需要确认）；
 * - 语法体检不在编辑期模拟：预览渲染（useMermaidRender，mermaid 官方引擎）
 *   是唯一错误来源，与画布渲染严格一致；
 * - 乐观锁冲突（MindmapConflictError）时落服务端最新文档并提示刷新。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Eye, Code2, PencilLine, RotateCcw, Save, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MindmapConflictError } from '../../api';
import { detectDiagramHeader } from '../../lib/mindmap';
import { useMermaidRender } from '../../lib/mindmap/useMermaidRender';
import { usePaperMindStore } from '../../store';

export interface MermaidSourcePanelProps {
  mapId: string;
  /** 服务端当前原文（保存成功后由上层 info 变化传入新值） */
  source: string;
  className?: string;
}

type Mode = 'edit' | 'preview';

const MermaidSourcePanel: React.FC<MermaidSourcePanelProps> = ({
  mapId,
  source,
  className,
}) => {
  const { t } = useTranslation('mindmap');
  const replaceMindmapSource = usePaperMindStore((s) => s.replaceMindmapSource);
  const cacheMindmapDoc = usePaperMindStore((s) => s.cacheMindmapDoc);

  const [text, setText] = useState(source);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [mode, setMode] = useState<Mode>('edit');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);

  // 外部原文变化（保存成功 / 冲突对账）：干净态实时镜像
  useEffect(() => {
    if (!dirtyRef.current) setText(source);
  }, [source]);

  const previewState = useMermaidRender(mode === 'preview' ? text : '', 400);
  useEffect(() => {
    if (previewState.status === 'ready' && previewHostRef.current) {
      previewHostRef.current.innerHTML = previewState.svg;
    }
  }, [previewState]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setSaveError(null);
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
  }, []);

  const handleReset = useCallback(() => {
    setText(source);
    dirtyRef.current = false;
    setDirty(false);
    setSaveError(null);
  }, [source]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    // 结构识别：缺图头直接拒绝（具体语法合法性由渲染引擎反馈）
    const header = detectDiagramHeader(text);
    if (!header) {
      setSaveError(t('source.headerRequired'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await replaceMindmapSource(mapId, text);
      // 成功：若仍是同一类型，canonical 随 props 更新；若转成 mindmap，本面板随外层卸载
      dirtyRef.current = false;
      setDirty(false);
    } catch (e) {
      if (e instanceof MindmapConflictError) {
        // 落服务端最新文档（画布/原文都以它为准），编辑回到干净态
        cacheMindmapDoc(e.currentMindmap);
        setText(e.currentMindmap.source ?? '');
        dirtyRef.current = false;
        setDirty(false);
        setSaveError(t('source.conflict'));
      } else if (e instanceof Error) {
        setSaveError(e.message);
      } else {
        setSaveError(String(e));
      }
    } finally {
      setSaving(false);
    }
  }, [saving, text, t, replaceMindmapSource, mapId, cacheMindmapDoc]);

  return (
    <aside
      className={`flex h-full w-full flex-col border-l border-border bg-surface ${className ?? ''}`}
      data-mm-source-panel="1"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Code2 size={15} className="text-textSecondary" />
        <span className="text-sm font-medium text-text">{t('source.title')}</span>
        {dirty && (
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
          {previewState.status === 'idle' && (
            <div className="text-xs text-textSecondary">{t('view.empty')}</div>
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

      {saveError && mode === 'edit' && (
        <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">{saveError}</span>
          </div>
        </div>
      )}

      {mode === 'edit' && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || saving}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-textSecondary transition-colors hover:bg-white/5 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={12} />
            {t('code.reset')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {t('source.save')}
          </button>
        </div>
      )}
    </aside>
  );
};

export default MermaidSourcePanel;
