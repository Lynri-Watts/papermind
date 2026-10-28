/**
 * Markdown 嵌套列表 ↔ MindElixirData（NodeObj 嵌套树）转换器。
 *
 * 复用 ``mdParser.ts`` 的缩进栈机（解析 Markdown 列表层级）和 HTML 注释元信息
 * 协议（``<!-- id:n_xxxxxxxx,shape:rect,kind:paper,paper:arxiv:2401.00001 -->``），
 * 但输出直接是 MindElixirData，跳过 MindmapDoc 扁平结构中间层。
 *
 * 后端 ``backend/services/mindmap_elixir.py`` 必须逐逻辑一致。
 */
import type { MindElixirData, MindElixirNodeObj } from './elixirMapper';

/** 论文链接 Markdown：[文本](paper:<paperId>)。 */
const PAPER_LINK_RE = /^\[([^\]]*)\]\(paper:([^\s)]+)\)$/;
/** 稳定 ID 注解。 */
const ID_ANNOTATION_RE = /id:(n_[0-9a-fA-F]{8})\b/;
/** 形状注解（序列化时仍保留，但 elixir 端不消费，透传到 metadata.kind 判断）。 */
const SHAPE_ANNOTATION_RE = /shape:(circle|rect|rounded|hexagon|default)\b/;
/** kind 注解（显式标注 topic/paper，缺省时按 paper 链接推断）。 */
const KIND_ANNOTATION_RE = /kind:(topic|paper)\b/;
/** paperId 注解（兜底：当 topic 文本本身不是 Markdown 链接时用）。 */
const PAPER_ANNOTATION_RE = /paper:([^\s,>]+)/;
/** HTML 注释包裹。 */
const HTML_COMMENT_RE = /<!--\s*(.*?)\s*-->/gs;
const LIST_MARKERS = ['-', '*', '+'] as const;
const VALID_SHAPES = ['circle', 'rect', 'rounded', 'hexagon', 'default'] as const;

function lineError(key: string, line: number, params: Record<string, unknown> = {}): Error {
  const err = new Error(key);
  (err as any).params = { line, ...params };
  return err;
}

function pathId(path: number[]): string {
  let hash = 0;
  for (const seg of path) hash = ((hash << 5) - hash + seg) | 0;
  // 转 8 位 hex，不足补 0（与后端 sha1[:8] 格式一致；为了前端独立，这里用简易哈希）
  const hex = (Math.abs(hash)).toString(16).padStart(8, '0').slice(0, 8);
  return `n_${hex}`;
}

function safeText(value: string): string {
  return (value ?? '').replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/-->/g, ' ');
}

// ---------- Markdown → MindElixirData ----------

export function parseMarkdownToElixir(text: string): MindElixirData {
  if (typeof text !== 'string' || text.trim() === '') {
    throw lineError('mindmap.md_empty', 0);
  }
  const lines = text.split(/\r\n|\r|\n/);

  interface StackItem {
    column: number;
    node: MindElixirNodeObj;
    siblingIndex: number;
  }

  const stack: StackItem[] = [];
  const levelColumns = new Map<number, number>();
  let step: number | null = null;

  for (let lineNo = 1; lineNo <= lines.length; lineNo++) {
    const raw = lines[lineNo - 1];
    if (raw.trim() === '') continue;

    const trimmedStart = raw.trimStart();
    const leadingWs = raw.slice(0, raw.length - trimmedStart.length);
    if (leadingWs.includes('\t')) throw lineError('mindmap.md_indent_char', lineNo);
    const column = leadingWs.length;

    let markerPos = -1;
    for (const mk of LIST_MARKERS) {
      if (trimmedStart.startsWith(mk + ' ') || trimmedStart === mk) {
        markerPos = mk.length;
        break;
      }
    }
    if (markerPos < 0) continue;

    const body = markerPos < trimmedStart.length
      ? trimmedStart.slice(markerPos).trimStart()
      : '';

    // 提取注释元信息
    const commentRe = /<!--\s*(.*?)\s*-->/g;
    const commentTexts: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = commentRe.exec(body)) !== null) commentTexts.push(cm[1]);
    const content = body.replace(/<!--\s*.*?\s*-->/g, '').trim();

    let annotationId: string | null = null;
    let annotationKind: 'topic' | 'paper' | null = null;
    let annotationPaperId: string | null = null;
    for (const ctext of [...commentTexts].reverse()) {
      if (annotationId === null) {
        const m = ID_ANNOTATION_RE.exec(ctext);
        if (m) annotationId = m[1];
      }
      if (annotationKind === null) {
        const m = KIND_ANNOTATION_RE.exec(ctext);
        if (m) annotationKind = m[1] as any;
      }
      if (annotationPaperId === null) {
        const m = PAPER_ANNOTATION_RE.exec(ctext);
        if (m) annotationPaperId = m[1];
      }
      if (annotationId && annotationKind && annotationPaperId) break;
    }

    // 列号 → 父节点/深度
    if (stack.length === 0) {
      levelColumns.set(0, column);
    } else {
      const rootColumn = levelColumns.get(0) as number;
      if (column <= rootColumn) throw lineError('mindmap.md_multiple_roots', lineNo);

      if (step === null && column > stack[stack.length - 1].column) {
        const parentCol = stack[stack.length - 1].column;
        step = column - parentCol;
        if (step <= 0) throw lineError('mindmap.md_indent_jump', lineNo);
      }

      // 回退到正确的祖先层
      while (stack.length && stack[stack.length - 1].column > column) stack.pop();
      if (!stack.length || stack[stack.length - 1].column !== column) {
        // 可能是新子层（栈顶 column < column）
        if (stack.length === 0 || stack[stack.length - 1].column > column) {
          throw lineError('mindmap.md_indent_jump', lineNo);
        }
        // 栈顶 column < column → 是子层，不入栈替换，直接 push 新项
      }
    }

    const parent = stack.length > 0 && stack[stack.length - 1].column >= column
      ? (stack.length >= 2 ? stack[stack.length - 2] : null)
      : stack.length > 0 ? stack[stack.length - 1] : null;

    const siblingIndex = parent
      ? (parent.node.children?.length ?? 0)
      : 0;

    const path = [...stack.map((s) => s.siblingIndex), siblingIndex];
    const nodeId = annotationId ?? pathId(path);

    // 解析 topic/kind/paperId
    let kind: 'topic' | 'paper' = annotationKind ?? 'topic';
    let topic = content;
    let paperId = annotationPaperId ?? undefined;

    const linkMatch = PAPER_LINK_RE.exec(content);
    if (linkMatch) {
      kind = 'paper';
      topic = linkMatch[1].trim();
      paperId = linkMatch[2].trim();
    }

    const elixirNode: MindElixirNodeObj = {
      id: nodeId,
      topic: topic ?? '',
      metadata: kind === 'paper'
        ? { kind, paperId }
        : { kind },
    };

    // 挂到父节点
    if (parent) {
      parent.node.children = parent.node.children ?? [];
      parent.node.children.push(elixirNode);
    }

    // 入栈
    const item: StackItem = { column, node: elixirNode, siblingIndex };
    if (stack.length === 0) {
      stack.push(item);
    } else if (column > stack[stack.length - 1].column) {
      stack.push(item);
    } else {
      while (stack.length && stack[stack.length - 1].column > column) stack.pop();
      if (stack.length && stack[stack.length - 1].column === column) {
        stack[stack.length - 1] = item;
      } else {
        stack.push(item);
      }
    }
  }

  if (stack.length === 0) throw lineError('mindmap.md_no_nodes', 0);
  if (stack.length > 1) {
    // 多根：取第一个
  }

  return {
    nodeData: stack[0].node,
    direction: 2,
    compact: false,
    meta: { converter: 'papermind' },
  };
}

// ---------- MindElixirData → Markdown ----------

/** MindElixirData 的序列化方向。 */
export type ElixirDirection = 0 | 1 | 2 | 3;
export const ELIXIR_DIRECTION_LABELS: Record<ElixirDirection, string> = {
  0: 'LEFT',
  1: 'RIGHT',
  2: 'SIDE',
  3: 'DOWN',
};

export function elixirToMarkdown(data: MindElixirData): string {
  const lines: string[] = [];

  const emit = (node: MindElixirNodeObj, depth: number) => {
    const indent = '  '.repeat(depth);
    const { id, metadata, topic } = node;
    const kind = metadata?.kind ?? 'topic';
    const text = safeText(topic ?? '');

    // 构造 topic 正文
    let body: string;
    if (kind === 'paper' && metadata?.paperId) {
      body = `[${text}](paper:${metadata.paperId})`;
    } else {
      body = text;
    }

    // 注释元信息（根节点 shape 省略，kind=topic 且无 paperId 时也省略 kind 注解）
    const annotations = [`id:${id}`];
    if (kind !== 'topic' || metadata?.paperId) {
      annotations.push(`kind:${kind}`);
      if (metadata?.paperId) annotations.push(`paper:${metadata.paperId}`);
    }
    const comment = annotations.join(' ');

    if (body) {
      lines.push(`${indent}- ${body} <!-- ${comment} -->`);
    } else {
      lines.push(`${indent}- <!-- ${comment} -->`);
    }

    for (const child of node.children ?? []) emit(child, depth + 1);
  };

  emit(data.nodeData, 0);
  return `${lines.join('\n')}\n`;
}
