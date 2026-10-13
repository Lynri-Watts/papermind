/**
 * LLM 回答中的 LaTeX 数学公式渲染公共模块（终态 Markdown 管线与流式纯文本
 * 渲染共用，高内聚）：
 *
 * 1. {@link normalizeMathDelimiters}：把 LLM 常用的 \(...\) / \[...\]
 *    定界符归一化为 remark-math 识别的 $...$ / $$...$$；代码块/行内代码/
 *    引用占位符（PUA）内的内容原样保留；
 * 2. {@link splitMathSegments}：把流式纯文本切成普通文本段/公式段
 *    （只有定界符闭合的公式才成段，未闭合的保持原文，随流式增量自动升级）；
 * 3. {@link renderKatexHtml}：KaTeX 安全渲染（不抛错；非法 TeX 返回 null，
 *    调用方回退显示原文）。
 *
 * 行内 $ 的判定参照 pandoc 规则，避免货币/价格文本被误判为公式：
 * - 开 $ 后不能紧跟空白；闭 $ 前不能是空白；
 * - 闭 $ 后不能紧跟数字（"$5 and $10" 不构成公式）；
 * - 开 $ 前若是字母/数字，则闭 $ 后也不能是字母/数字。
 */
import katex from 'katex';

// 用字符码构造，避免源码里直接出现私有区字面字符
const PUA_PATTERN = `[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]+`;

/**
 * 一次性匹配需要原样跳过的片段（代码围栏/行内代码/PUA 占位符）或需要
 * 归一化的 \(...\) / \[...\] 数学定界符。
 * 未闭合的围栏/定界符（流式中常见）不匹配，之后的内容自然保持原样。
 */
const NORMALIZE_RE = new RegExp(
  [
    '```[\\s\\S]*?```', // ``` 围栏代码块
    '~~~[\\s\\S]*?~~~', // ~~~ 围栏代码块
    '`[^`\\n]+`', // 行内代码
    PUA_PATTERN, // 引用占位等私有使用区字符
    '\\\\\\[([\\s\\S]*?)\\\\\\]', // \[ ... \] → 块级公式
    '\\\\\\(([\\s\\S]*?)\\\\\\)', // \( ... \) → 行内公式
  ].join('|'),
  'g',
);

/** 把 \(...\) / \[...\] 归一化为 $...$ / $$...$$（跳过代码与 PUA 占位符） */
export function normalizeMathDelimiters(src: string): string {
  return src.replace(NORMALIZE_RE, (match, blockContent?: string, inlineContent?: string) => {
    if (blockContent !== undefined) return `$$${blockContent}$$`;
    if (inlineContent !== undefined) return `$${inlineContent}$`;
    return match; // 代码块 / 行内代码 / PUA 占位符原样保留
  });
}

export type MathSegment =
  | { type: 'text'; text: string }
  | { type: 'math'; tex: string; display: boolean; raw: string };

function isAlnum(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

function isEscapedDollar(src: string, dollarIndex: number): boolean {
  // 前面有奇数个反斜杠 → 该 $ 被转义
  let slash = 0;
  let i = dollarIndex - 1;
  while (i >= 0 && src[i] === '\\') {
    slash += 1;
    i -= 1;
  }
  return slash % 2 === 1;
}

/**
 * 从归一化后的纯文本中切出公式段（流式渲染用）。
 * $$...$$ 为块级；$...$ 为行内（pandoc 边界规则）；未闭合的 $ 一律按文本。
 */
export function splitMathSegments(src: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let cursor = 0;
  let i = 0;
  const pushText = (end: number) => {
    if (end > cursor) segments.push({ type: 'text', text: src.slice(cursor, end) });
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch !== '$' || isEscapedDollar(src, i)) {
      i += 1;
      continue;
    }

    // 1) 块级 $$...$$
    if (src[i + 1] === '$') {
      const close = src.indexOf('$$', i + 2);
      if (close !== -1 && close > i + 2) {
        const tex = src.slice(i + 2, close);
        pushText(i);
        segments.push({ type: 'math', tex, display: true, raw: src.slice(i, close + 2) });
        cursor = close + 2;
        i = cursor;
        continue;
      }
      i += 2;
      continue;
    }

    // 2) 行内 $...$：找下一个未转义 $，逐项套 pandoc 边界规则
    if (/\s/.test(src[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < src.length; j += 1) {
      if (src[j] === '$' && !isEscapedDollar(src, j)) {
        close = j;
        break;
      }
      if (src[j] === '\n') break; // 行内公式不跨行（跨行交给 $$ 块级）
    }
    if (close === -1) {
      i += 1;
      continue;
    }
    const inner = src.slice(i + 1, close);
    if (!inner || /\s/.test(inner[inner.length - 1])) {
      i += 1;
      continue;
    }
    // 闭 $ 后紧跟数字 → 视为价格（$5 … $10 这类）
    if (/\d/.test(src[close + 1] ?? '')) {
      i += 1;
      continue;
    }
    // 开 $ 前是字母数字时，闭 $ 后也不能是字母数字
    if (isAlnum(src[i - 1]) && isAlnum(src[close + 1])) {
      i += 1;
      continue;
    }
    pushText(i);
    segments.push({ type: 'math', tex: inner, display: false, raw: src.slice(i, close + 1) });
    cursor = close + 1;
    i = cursor;
  }

  pushText(src.length);
  return segments;
}

/**
 * 用 KaTeX 渲染公式为 HTML；非法/未完成的 TeX 返回 null（不抛错），
 * 由调用方回退显示原始文本，流式过程中公式尚未输入完整时尤为重要。
 */
export function renderKatexHtml(tex: string, display: boolean): string | null {
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      // 未知宏/命令只按错误样式呈现单个公式，不向控制台刷警告
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
    });
    return html.includes('katex-error') ? null : html;
  } catch {
    return null;
  }
}
