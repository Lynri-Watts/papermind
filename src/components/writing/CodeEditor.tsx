/**
 * CodeMirror 6 受控编辑器（写作模块唯一的文本编辑内核）。
 *
 * 设计要点（替代旧版 contentEditable + dangerouslySetInnerHTML 的反模式）：
 * - EditorView 在挂载时创建一次，文档由 CM 自己管理；光标、IME 组合输入、
 *   撤销栈完全交给 CM，React 重渲染不再重建 DOM；
 * - ``value`` 仅在与编辑器当前文档不一致时才下发（外部加载/远程更新），
 *   普通键入产生的 onChange 回环不会重置光标；
 * - 每个打开的文本标签各持一个实例，通过父容器 display 切换显隐，
 *   从而保留各自的撤销历史；active 变 true 时重新测量并聚焦；
 * - 通过 ref 暴露 insert/wrap/scrollToLine 等命令式操作供工具栏、大纲使用。
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { latex } from 'codemirror-lang-latex';
import type { EditorMode } from './utils';
import type { WritingRevision } from '../../types';

export interface CodeEditorHandle {
  focus: () => void;
  /** CodeMirror 视图是否已创建（外部命令式操作前的就绪判定，如打开新标签后等跳行） */
  isReady: () => boolean;
  undo: () => void;
  redo: () => void;
  /** 在光标处插入文本；cursorDelta 为插入后光标相对插入起点的偏移（默认置于文本末尾） */
  insertText: (text: string, cursorDelta?: number) => void;
  /** 用 before/after 包裹当前选区（如 \\textbf{...}）；无选区时插入 placeholder 并选中 */
  wrapSelection: (before: string, after: string, emptyPlaceholder?: string) => void;
  /** 在当前行首插入块级命令（如 \\section{}），光标落入大括号内 */
  insertLineCommand: (command: string) => void;
  /** 用环境包裹选中的行（itemize/enumerate 等），并给每行加 \\item */
  wrapLinesInEnvironment: (env: string, itemize?: boolean) => void;
  /** 滚动到指定行（1 起）并移动光标 */
  scrollToLine: (line: number) => void;
}

interface CodeEditorProps {
  /** 文件相对路径（用于文件名相关的语言特性） */
  path: string;
  value: string;
  mode: EditorMode;
  /** 是否为当前显示的标签：显示时重新测量并（按 requireFocus）聚焦 */
  active: boolean;
  onChange: (value: string) => void;
  /** 切换到该标签时是否自动聚焦（鼠标点击标签需要；程序化切换避免抢焦点） */
  requireFocusOnActive?: boolean;
  placeHolder?: string;
  /** 本文件待审的 AI 修改块（内联高亮 + ✓/✕；空数组/缺省不装饰） */
  reviewHunks?: WritingRevision[];
  /** 正在接受/拒绝的审核块 id（按钮转圈禁用） */
  reviewBusyId?: number | null;
  /** 审核按钮事件（来自不可编辑块控件的冒泡 CustomEvent） */
  onReviewAction?: (id: number, action: 'accept' | 'reject') => void;
}

function languageExtension(mode: EditorMode, path: string) {
  if (mode === 'latex') {
    return latex({
      fileName: path,
      enableAutocomplete: true,
      autoCloseTags: true,
      autoCloseBrackets: true,
      enableLinting: false,
      enableTooltips: false,
    });
  }
  if (mode === 'markdown') return markdown();
  return [];
}

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
  },
  '.cm-scroller': {
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
    lineHeight: '1.65',
  },
  '.cm-content': {
    padding: '10px 0 40vh 0',
  },
  '.cm-gutters': {
    borderRight: '1px solid rgba(148,163,184,0.15)',
  },
});

// ---------- AI 修改内联审核（边写边审） ----------
/**
 * 审核块在当前文档中的定位状态。新文本在文档中必须**唯一命中**才装饰
 * （与后端反向还原同一判据）；零/多命中说明已被后续编辑改动，不做猜测渲染。
 */
interface LocatedHunk {
  rev: WritingRevision;
  /** 新文本起点（0 基偏移） */
  from: number;
  /** 新文本终点 */
  to: number;
  /** 首行行号（1 基） */
  firstLine: number;
}

/** 审核块头部（✓/✕）与被删旧行的合成块控件（不可编辑，不进文档文本） */
class ReviewHunkWidget extends WidgetType {
  constructor(
    private readonly revId: number,
    private readonly oldText: string,
    private readonly busy: boolean,
    private readonly acceptTitle: string,
    private readonly rejectTitle: string,
  ) {
    super();
  }

  eq(other: ReviewHunkWidget): boolean {
    return other.revId === this.revId
      && other.oldText === this.oldText
      && other.busy === this.busy
      && other.acceptTitle === this.acceptTitle
      && other.rejectTitle === this.rejectTitle;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-writing-review';
    wrap.contentEditable = 'false';

    const header = document.createElement('div');
    header.className = 'cm-writing-review-header';
    const tag = document.createElement('span');
    tag.className = 'cm-writing-review-tag';
    tag.textContent = 'AI';
    header.appendChild(tag);

    const makeButton = (action: 'accept' | 'reject', label: string, title: string) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cm-writing-review-btn cm-writing-review-${action}`;
      btn.textContent = this.busy ? '…' : label;
      btn.title = title;
      if (this.busy) btn.disabled = true;
      btn.addEventListener('mousedown', (e) => {
        // 阻止夺走编辑器焦点/光标
        e.preventDefault();
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.busy) return;
        btn.dispatchEvent(new CustomEvent('pm-writing-review', {
          bubbles: true,
          detail: { id: this.revId, action },
        }));
      });
      return btn;
    };
    header.appendChild(makeButton('accept', '✓', this.acceptTitle));
    header.appendChild(makeButton('reject', '✕', this.rejectTitle));
    wrap.appendChild(header);

    // 被替换掉的旧内容：红底只读行（create/append 无旧文本，不渲染）
    if (this.oldText.trim()) {
      const old = this.oldText.replace(/\n$/, '');
      const oldWrap = document.createElement('div');
      oldWrap.className = 'cm-writing-review-old';
      for (const line of old.split('\n')) {
        const row = document.createElement('div');
        row.className = 'cm-writing-review-oldline';
        row.textContent = line ? `- ${line}` : '-';
        oldWrap.appendChild(row);
      }
      wrap.appendChild(oldWrap);
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

interface ReviewLabels {
  acceptTitle: string;
  rejectTitle: string;
}

interface ReviewFieldState {
  hunks: WritingRevision[];
  busyId: number | null;
  labels: ReviewLabels;
  located: LocatedHunk[];
  decorations: DecorationSet;
}

const setReviewHunksEffect = StateEffect.define<WritingRevision[]>();
const setReviewBusyEffect = StateEffect.define<number | null>();
const setReviewLabelsEffect = StateEffect.define<ReviewLabels>();

/** 在文档中唯一定位全部审核块，构造装饰（旧行块控件 + 新行绿底） */
function buildReviewDecorations(
  state: EditorState,
  hunks: WritingRevision[],
  busyId: number | null,
  labels: ReviewLabels,
): ReviewFieldState {
  const doc = state.doc;
  const located: LocatedHunk[] = [];
  const ranges: Array<{ from: number; side: number; deco: Decoration }> = [];
  const fullText = doc.toString();

  for (const rev of hunks) {
    let from = -1;
    let to = -1;
    if (rev.kind === 'create') {
      // 整文件新建：当前文档与写入内容一致时把全文标绿，否则视为已被改动
      if (fullText === rev.newText) {
        from = 0;
        to = doc.length;
      }
    } else {
      const needle = rev.newText;
      if (needle) {
        const first = fullText.indexOf(needle);
        if (first >= 0 && fullText.indexOf(needle, first + 1) === -1) {
          from = first;
          to = first + needle.length;
        }
      }
    }
    if (from < 0) continue;
    const firstLine = doc.lineAt(from).number;
    const lastLine = doc.lineAt(Math.max(from, to - 1)).number;
    located.push({ rev, from, to, firstLine });

    // 头部+旧行块控件：置于首行上方（side:-1，先于同行的行装饰）
    ranges.push({
      from: doc.line(firstLine).from,
      side: -1,
      deco: Decoration.widget({
        widget: new ReviewHunkWidget(
          rev.id, rev.oldText, busyId === rev.id,
          labels.acceptTitle, labels.rejectTitle,
        ),
        side: -1,
        block: true,
      }),
    });
    // 新内容每行绿底
    for (let n = firstLine; n <= lastLine; n += 1) {
      ranges.push({
        from: doc.line(n).from,
        side: 1,
        deco: Decoration.line({ class: 'cm-writing-review-new' }),
      });
    }
  }

  ranges.sort((a, b) => (a.from - b.from) || (a.side - b.side));
  const decorations = Decoration.set(
    ranges.map((r) => r.deco.range(r.from)),
    true,
  );
  return { hunks, busyId, labels, located, decorations };
}

// 初始 label 仅用于挂载后首帧（tooltip 不可见），挂载 effect 立即以 i18n 文案覆盖
const INITIAL_LABELS: ReviewLabels = { acceptTitle: '', rejectTitle: '' };

const reviewField = StateField.define<ReviewFieldState>({
  create: (state) => buildReviewDecorations(state, [], null, INITIAL_LABELS),
  update(value, tr) {
    let next = value;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(setReviewHunksEffect)) {
        next = { ...next, hunks: e.value };
        changed = true;
      } else if (e.is(setReviewBusyEffect)) {
        next = { ...next, busyId: e.value };
        changed = true;
      } else if (e.is(setReviewLabelsEffect)) {
        next = { ...next, labels: e.value };
        changed = true;
      }
    }
    // 文档改动（用户键入/远程替换）后按新坐标重新定位
    if (tr.docChanged) changed = true;
    if (!changed) return value;
    return buildReviewDecorations(tr.state, next.hunks, next.busyId, next.labels);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/** 写作审核扩展集合（field + 装饰即随事务重算） */
function writingReviewExtension(): Extension {
  return [reviewField];
}

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { path, value, mode, active, onChange, requireFocusOnActive = false, placeHolder,
    reviewHunks, reviewBusyId = null, onReviewAction },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 审核控件 tooltip 文案（语言切换时经 effect 同步进 CM field）
  const { t } = useTranslation('writing');
  const reviewLabels = useMemo<ReviewLabels>(() => ({
    acceptTitle: t('review.acceptHunk'),
    rejectTitle: t('review.rejectHunk'),
  }), [t]);
  // 始终持有最新的 onChange/onReviewAction，避免重建 EditorState 来更换监听器
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReviewActionRef = useRef(onReviewAction);
  onReviewActionRef.current = onReviewAction;

  // 1) 仅在挂载时创建编辑器
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          languageExtension(mode, path),
          writingReviewExtension(),
          oneDark,
          baseTheme,
          placeHolder ? placeholder(placeHolder) : [],
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    // 审核块控件内 ✓/✕ 的冒泡事件（contentEditable=false 的 widget 不产生编辑事务）
    const host = hostRef.current;
    const handleReviewEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: number; action?: 'accept' | 'reject' }>).detail;
      if (detail && typeof detail.id === 'number'
        && (detail.action === 'accept' || detail.action === 'reject')) {
        onReviewActionRef.current?.(detail.id, detail.action);
      }
    };
    host.addEventListener('pm-writing-review', handleReviewEvent);
    return () => {
      host.removeEventListener('pm-writing-review', handleReviewEvent);
      view.destroy();
      viewRef.current = null;
    };
    // 编辑器实例与文件路径一一对应（父级以 key=path 保持挂载），只创建一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) 外部值与文档不一致时才同步（加载完成/AI 远程写盘/审核还原；键入回环不触发）。
  // 远程内容不进用户撤销栈（addToHistory=false），避免 Cmd-Z 撤销掉 AI 的整批写入。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [value]);

  // 2b) 审核块集合变化 → 交 StateField 重新定位/装饰
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setReviewHunksEffect.of(reviewHunks ?? []) });
  }, [reviewHunks]);

  // 2c) 审核操作进行中的 hunk（按钮置忙）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setReviewBusyEffect.of(reviewBusyId) });
  }, [reviewBusyId]);

  // 2d) 审核控件文案（挂载/语言切换）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setReviewLabelsEffect.of(reviewLabels) });
  }, [reviewLabels]);

  // 3) 显隐切换：重新测量（display:none 期间尺寸为 0），按需聚焦
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !active) return;
    view.requestMeasure();
    if (requireFocusOnActive) view.focus();
  }, [active, requireFocusOnActive]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    isReady: () => viewRef.current !== null,
    undo: () => {
      if (viewRef.current) undo(viewRef.current);
    },
    redo: () => {
      if (viewRef.current) redo(viewRef.current);
    },
    insertText: (text, cursorDelta) => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      const { from } = view.state.selection.main;
      const cursorPos = cursorDelta === undefined ? from + text.length : from + cursorDelta;
      view.dispatch({
        changes: { from, to: view.state.selection.main.to, insert: text },
        selection: { anchor: cursorPos },
        scrollIntoView: true,
      });
    },
    wrapSelection: (before, after, emptyPlaceholder = '') => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      const inner = selected || emptyPlaceholder;
      const insert = `${before}${inner}${after}`;
      view.dispatch({
        changes: { from, to, insert },
        selection: selected
          ? { anchor: from + before.length, head: to + before.length }
          : { anchor: from + before.length, head: from + before.length + inner.length },
        scrollIntoView: true,
      });
    },
    insertLineCommand: (command) => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      const { head } = view.state.selection.main;
      const line = view.state.doc.lineAt(head);
      const prefix = `${command}{}`;
      view.dispatch({
        changes: { from: line.from, insert: prefix },
        // 光标落入 {} 之间
        selection: { anchor: line.from + command.length + 1 },
        scrollIntoView: true,
      });
    },
    wrapLinesInEnvironment: (env, withItem = true) => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      const sel = view.state.selection.main;
      const startLine = view.state.doc.lineAt(sel.from);
      const endLine = view.state.doc.lineAt(sel.to);
      const changes = [];
      for (let n = startLine.number; n <= endLine.number; n += 1) {
        const ln = view.state.doc.line(n);
        if (withItem && ln.text.trim()) {
          changes.push({ from: ln.from, insert: '\\item ' });
        }
      }
      const begin = `\\begin{${env}}\n`;
      const end = `\n\\end{${env}}`;
      view.dispatch({
        changes: [
          ...changes,
          { from: startLine.from, insert: begin },
          { from: endLine.to + 1, insert: end },
        ],
        selection: { anchor: startLine.from + begin.length },
        scrollIntoView: true,
      });
    },
    scrollToLine: (lineNum) => {
      const view = viewRef.current;
      if (!view) return;
      const line = view.state.doc.line(Math.min(Math.max(1, lineNum), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' as const }),
      });
      view.focus();
    },
  }), []);

  return (
    <div
      className="h-full w-full overflow-hidden bg-[#282c34]"
      style={{ display: active ? 'block' : 'none' }}
    >
      <div ref={hostRef} className="h-full" />
    </div>
  );
});

export default CodeEditor;
