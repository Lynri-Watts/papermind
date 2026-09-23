/**
 * 行内引用协议（无编号，与后端 backend/llm/rag.py 对应）。
 *
 * 模型在回答的句子中间（或句末）内联输出不带编号的引用标签，标签内是
 * 从出处逐字复制的一句原文；后端靠逐字匹配/上下文消歧确定出处：
 *
 *   该模型在 ImageNet 上[Q]We report a top-1 accuracy of 85.3%.[/Q]取得最佳。
 *
 * 三态标签：
 *   [Q]摘录[/Q]      流式未决（后端尚未绑定出处，界面显示"核对中"）
 *   [Q+2]摘录[/Q]    终态成功（绑定到第 2 个 RagSource，1-based）
 *   [Q!]摘录[/Q]     终态失败（无法在材料中核对，界面显示失败卡、不可定位）
 *
 * 引用是句子的一部分：终态 markdown 渲染时标签被替换为行内标记组件，
 * 而非把正文切成多段（markdown 的加粗/链接等语法可以跨标记成对存在）。
 */

export type CitationState = 'pending' | 'bound' | 'failed';

export interface InlineCitation {
  state: CitationState;
  /** bound 态：出处序号（对应 RagSource.index，1-based） */
  sourceIndex?: number;
  /** 卡片展示文字：bound=分块真实原句；pending/failed=模型输出的摘录 */
  quote: string;
}

export interface InlineTextSegment {
  type: 'text';
  text: string;
}

export interface InlineCiteSegment {
  type: 'cite';
  citation: InlineCitation;
}

export type InlineSegment = InlineTextSegment | InlineCiteSegment;

/**
 * 引用块完整匹配：组 1 = 终态前缀（'+' / '!' / undefined=未决），
 * 组 2 = bound 时的出处序号，组 3 = 摘录原文。
 */
const INLINE_CITE_RE =
  /\[\s*[qQ]\s*(?:([+!])(\d+)?)?\s*\]([\s\S]*?)\[\s*\/\s*[qQ]\s*\]/g;

/** 旧版协议遗留的 [Source N] 标记：历史消息里可能存在，渲染/复制时剔除 */
export const LEGACY_SOURCE_TAG_RE = /\[\s*source\s*\d+\s*\]/gi;

/** 引用占位符（私有使用区字符，micromark 不会在其上切分任何内联语法） */
const TOKEN_OPEN = '\uE100';
const TOKEN_CLOSE = '\uE101';
const TOKEN_RE = new RegExp(`${TOKEN_OPEN}([0-9a-z]+)${TOKEN_CLOSE}`, 'g');

function citationFromMatch(m: RegExpMatchArray): InlineCitation {
  const mark = m[1];
  const quote = (m[3] ?? '').trim();
  if (mark === '+') {
    return { state: 'bound', sourceIndex: Number(m[2]), quote };
  }
  if (mark === '!') {
    return { state: 'failed', quote };
  }
  return { state: 'pending', quote };
}

/** 把回答正文切分为正文段与引用段（流式纯文本渲染用，保持出现顺序）。 */
export function splitInlineCitations(content: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  INLINE_CITE_RE.lastIndex = 0;
  for (const m of content.matchAll(INLINE_CITE_RE)) {
    const start = m.index ?? 0;
    if (start > lastIndex) {
      segments.push({ type: 'text', text: content.slice(lastIndex, start) });
    }
    segments.push({ type: 'cite', citation: citationFromMatch(m) });
    lastIndex = start + m[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', text: content.slice(lastIndex) });
  }
  return segments;
}

/** 剔除全部引用块与旧版 [Source N]（复制纯文本正文用）。 */
export function stripInlineCitations(content: string): string {
  return content.replace(INLINE_CITE_RE, '').replace(LEGACY_SOURCE_TAG_RE, '');
}

/** 仅剔除旧版 [Source N]（渲染管线在引用标签被占位符替换后使用）。 */
export function stripLegacySourceTags(content: string): string {
  return content.replace(LEGACY_SOURCE_TAG_RE, '');
}

export interface ProtectedMarkdown {
  /** 引用块替换为惰性占位符后的 markdown（可安全交给 remark 解析） */
  markdown: string;
  /** 占位符 id -> 引用数据（remark 插件据此生成自定义节点） */
  registry: Map<string, InlineCitation>;
}

/**
 * 把引用块替换为 markdown 惰性占位符。
 *
 * 摘录原文里可能含有 ``*``/``_``/``` ` ```等 markdown 敏感字符，直接让
 * markdown 解析器穿过标签会把卡片内容错误解析成强调/代码；占位符是
 * PUA 单字符序列，不触发任何内联语法，卡片内容只通过节点属性传递。
 */
export function protectCitations(content: string): ProtectedMarkdown {
  const registry = new Map<string, InlineCitation>();
  let seq = 0;
  const markdown = content.replace(
    INLINE_CITE_RE,
    (_full, mark?: string, idx?: string, rawQuote?: string) => {
      const quote = String(rawQuote ?? '').trim();
      const id = (seq++).toString(36);
      const citation: InlineCitation =
        mark === '+'
          ? { state: 'bound', sourceIndex: Number(idx), quote }
          : mark === '!'
            ? { state: 'failed', quote }
            : { state: 'pending', quote };
      registry.set(id, citation);
      return `${TOKEN_OPEN}${id}${TOKEN_CLOSE}`;
    },
  );
  return { markdown, registry };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- mdast 节点边界：
   项目未直接依赖 mdast 类型，插件按结构最小约定操作 text/children */

/**
 * remark 插件：把占位符文本节点替换为自定义 ``citecard`` mdast 节点。
 * mdast-util-to-hast 会按 data.hName / data.hProperties 输出 hast 元素，
 * react-markdown 再以 components 映射里的同名组件渲染。
 */
export function remarkCitationCards(registry: Map<string, InlineCitation>) {
  return (tree: any) => {
    const splitTextNode = (node: any): any[] => {
      const value: string = node.value;
      const out: any[] = [];
      let lastIndex = 0;
      TOKEN_RE.lastIndex = 0;
      for (const tm of value.matchAll(TOKEN_RE)) {
        const start = tm.index ?? 0;
        if (start > lastIndex) {
          out.push({ type: 'text', value: value.slice(lastIndex, start) });
        }
        const citation = registry.get(tm[1]);
        if (citation) {
          out.push({
            type: 'citeCard',
            data: {
              hName: 'citecard',
              hProperties: {
                state: citation.state,
                ...(citation.sourceIndex != null
                  ? { sourceindex: citation.sourceIndex }
                  : {}),
                quote: citation.quote,
              },
            },
          });
        }
        lastIndex = start + tm[0].length;
      }
      if (lastIndex < value.length) {
        out.push({ type: 'text', value: value.slice(lastIndex) });
      }
      return out;
    };
    const walk = (node: any) => {
      if (!Array.isArray(node.children)) return;
      const next: any[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string'
          && TOKEN_RE.test(child.value)) {
          TOKEN_RE.lastIndex = 0;
          next.push(...splitTextNode(child));
        } else {
          walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
