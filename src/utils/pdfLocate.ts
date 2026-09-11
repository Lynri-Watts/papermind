import * as pdfjsLib from 'pdfjs-dist';

/** 归一化文本：多条空白折叠为单个空格、去除首尾空白，便于宽松匹配 */
export function normalizeText(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

/** 去除引用文本常见的前后引号/撇号（AI 引用时可能带原文引号） */
export function stripQuotes(target: string): string {
  return target.replace(/^[\s"'“”‘’「」《》]+|[\s"'“”‘’「」《》]+$/g, '').trim();
}

export interface LocateResult {
  /** 命中文本在拼接全文中的起始偏移（0 基） */
  start: number;
  /** 命中文本长度 */
  length: number;
  /** 命中所处页码（1 基） */
  page: number;
  /** 命中页在拼接全文中的起始偏移（用于换算页内偏移） */
  pageStart: number;
  /** 每页在拼接全文中的起始偏移（用于跨页切分命中范围） */
  pageOffsets: number[];
}

/**
 * 提取整篇 PDF 的拼接纯文本及每页起始偏移（与 PdfViewer 高亮的全文拼接方式一致）。
 *
 * 拼接规则：pdf.js 的 textContent 中每个 item 是一个文本 run，item.str 内部
 * 已保留行内词间空格；但跨行（item.hasEOL）时行间空格会丢失，导致
 * "…with" + "Interactive…"（换行）拼成 "withInteractive"，与后端
 * PyMuPDF 提取（行间为换行符）不一致，使 indexOf 定位永远失败。
 * 因此这里在 hasEOL 的行尾补一个空格，保证与后端提取的文本字符级对齐。
 */
/** 整篇文档的拼接全文缓存：同一次 PDF 加载内多次定位（点击多个引用）不必反复提取 */
const fullTextCache = new WeakMap<pdfjsLib.PDFDocumentProxy, { fullText: string; pageOffsets: number[] }>();

export async function extractFullText(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<{ fullText: string; pageOffsets: number[] }> {
  const cached = fullTextCache.get(doc);
  if (cached) return cached;

  let fullText = '';
  const pageOffsets: number[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      // 与 pdf.js 文本层一致：空字符串 run 不产生 DOM span，这里一并跳过，
      // 保证 extractFullText 的拼接与 normOffsetToRunRange 的 run 坐标完全对齐。
      if (!('str' in item) || item.str === '') continue;
      pageText += item.str;
      // 行尾补一个空格，跨行（换行处）与 PyMuPDF 的换行对齐
      if (item.hasEOL) pageText += ' ';
    }
    pageOffsets.push(fullText.length);
    fullText += normalizeText(pageText);
  }
  const result = { fullText, pageOffsets };
  fullTextCache.set(doc, result);
  return result;
}

/**
 * 在全文（逐页拼接）中定位某段文本，返回命中信息；找不到返回 null。
 * 优先精确匹配，其次去掉引号后匹配，再退化为逐词连续匹配的模糊定位。
 */
export async function locateInDocument(
  doc: pdfjsLib.PDFDocumentProxy,
  rawText: string,
): Promise<LocateResult | null> {
  const target = normalizeText(rawText);
  if (!target) return null;
  const { fullText, pageOffsets } = await extractFullText(doc);

  // 1) 精确匹配（原文逐字；AI 引用可能是去引号后的文本）
  const unquoted = stripQuotes(target);
  let hitIdx = fullText.indexOf(target);
  let hitLen = target.length;
  if (hitIdx === -1 && unquoted && unquoted !== target) {
    hitIdx = fullText.indexOf(unquoted);
    hitLen = unquoted.length;
  }

  // 2) 精确匹配失败 → 模糊匹配：按词序列找"最连续的片段"
  if (hitIdx === -1) {
    const fuzzy = findFuzzyMatch(fullText, unquoted || target);
    if (fuzzy) {
      hitIdx = fuzzy.start;
      hitLen = fuzzy.length;
    }
  }
  if (hitIdx === -1) return null;

  // 反查页码
  let page = doc.numPages;
  let pageStart = pageOffsets[doc.numPages - 1];
  for (let i = 0; i < doc.numPages; i++) {
    const pageStartIdx = pageOffsets[i];
    const pageEnd = i + 1 < doc.numPages ? pageOffsets[i + 1] : fullText.length;
    if (hitIdx >= pageStartIdx && hitIdx < pageEnd) {
      page = i + 1;
      pageStart = pageStartIdx;
      break;
    }
  }
  return { start: hitIdx, length: hitLen, page, pageStart, pageOffsets };
}

/** 常见停用词：模糊定位时跳过，避免用 "the/In/We" 这类词做种子导致定位到错误的页 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'we', 'they', 'this', 'that', 'these', 'those', 'it', 'its', 'their', 'our',
  'his', 'her', 'between', 'within', 'into', 'across', 'over', 'during', 'via',
]);

/**
 * 模糊定位：目标按词切分后，用第一个"非停用词"作为种子（精确词，命中率高），
 * 在全文每个出现位置贪心匹配后续词（忽略大小写、允许中间有少量空白/标点/换行），
 * 取"连续匹配词数最多"的位置作为命中；返回覆盖 [seed, 最后一个匹配词] 的范围。
 * 找不到足够连续的词序列时返回 null。
 */
function findFuzzyMatch(fullText: string, target: string): { start: number; length: number } | null {
  const words = target.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let seedIdx = words.findIndex((w) => !STOPWORDS.has(w.toLowerCase()));
  if (seedIdx === -1) seedIdx = 0;
  const seed = words[seedIdx].toLowerCase();
  if (!seed) return null;

  const hay = fullText.toLowerCase();
  let best: { start: number; length: number; matched: number } | null = null;
  let from = 0;
  let scans = 0;
  // 限制扫描次数，避免超大 PDF 全量扫描耗时
  while (scans < 2000) {
    const pos = hay.indexOf(seed, from);
    if (pos === -1) break;
    let matched = 1;
    let cursor = pos + seed.length;
    for (let i = seedIdx + 1; i < words.length; i++) {
      const w = words[i].toLowerCase();
      const nxt = hay.indexOf(w, cursor);
      if (nxt === -1) break;
      // 相邻词距离过大视为无关片段（不是同一句/同一段）
      if (nxt - cursor > 80) break;
      matched += 1;
      cursor = nxt + w.length;
    }
    if (!best || matched > best.matched) {
      best = { start: pos, length: cursor - pos, matched };
    }
    from = pos + 1;
    scans += 1;
  }
  if (!best) return null;
  // 至少要能连续匹配 2~3 个词，否则单 seed 无法可靠定位
  const need = Math.max(2, Math.min(words.length, 3));
  if (best.matched < need) return null;
  return { start: best.start, length: best.length };
}

/** 单个文本 run：与 extractFullText 的拼接规则一致 */
export interface PageRun {
  str: string;
  hasEOL: boolean;
}

/**
 * 把 extractFullText 的"页内偏移"（normalize + hasEOL 补空格后的全文偏移）
 * 映射回页内按 run 顺序排列的 DOM 文本偏移，用于精确连续范围高亮。
 *
 * 原理：extractFullText 每页文本 = normalize(concat(run.str + (hasEOL?' ':'')))；
 * 而 DOM 中每个 run 对应一个 span[data-pdf-text]，span.textContent === run.str。
 * 本函数重建"含 hasEOL 空格"的原始页文本，逐字符建立 norm 偏移 → run 位置映射，
 * 再把目标的 norm 区间换算为 run 起点/终点坐标。
 *
 * @param runs 按渲染顺序排列的每页 runs（与 DOM spans 一一对应）
 * @param normStart 命中文本在页内 normalize 全文中的起始偏移（hit.start - hit.pageStart）
 * @param normLen 命中文本长度（已在页内截断）
 * @returns DOM 坐标范围：runStart/charStart 为起点的 run 下标与字符偏移（0 基，不含补空格），
 *          runEnd/charEnd 为终点的 run 下标与字符偏移（含）；找不到返回 null
 */
export function normOffsetToRunRange(
  runs: PageRun[],
  normStart: number,
  normLen: number,
): { runStart: number; charStart: number; runEnd: number; charEnd: number } | null {
  if (!runs.length) return null;

  // 1) 重建含 hasEOL 空格的原始页文本 raw，同时记录每个字符对应的 run 下标与 run 内字符偏移
  let raw = '';
  const rawToRun: number[] = [];
  const rawToChar: number[] = [];
  for (let ri = 0; ri < runs.length; ri++) {
    const { str, hasEOL } = runs[ri];
    for (let c = 0; c < str.length; c++) {
      rawToRun.push(ri);
      rawToChar.push(c);
    }
    raw += str;
    if (hasEOL) {
      // 补的空格归属于当前 run 的末尾
      rawToRun.push(ri);
      rawToChar.push(str.length);
      raw += ' ';
    }
  }
  const norm = normalizeText(raw);
  if (normStart >= norm.length) return null;

  // 2) 逐字符建立 norm 偏移 → raw 偏移映射（normalize 折叠空白，需跳过）
  //    采用双指针：norm 的每个字符对应 raw 中的一段（空白段折叠为单空格）
  const normToRaw: number[] = new Array(norm.length);
  let ri = 0;
  for (let ni = 0; ni < norm.length; ni++) {
    // 跳过 raw 中已被折叠的连续空白（norm 里仅表现为单个空格或首尾被去掉）
    if (norm[ni] === ' ') {
      while (ri < raw.length && /\s/.test(raw[ri])) ri++;
      normToRaw[ni] = ri;
    } else {
      while (ri < raw.length && raw[ri] !== norm[ni]) ri++;
      normToRaw[ni] = ri;
      ri = Math.min(ri + 1, raw.length);
    }
  }

  const rawStart = normToRaw[normStart];
  const rawEndNorm = Math.min(normStart + normLen - 1, norm.length - 1);
  const rawEnd = normToRaw[rawEndNorm];
  // 终点字符的 raw 偏移 + 该字符占位（非空白 1 位；空白被折叠，保守取 1）
  const rawEndPos = rawEnd + 1;

  // 3) raw 偏移 → run 坐标（rawStart 是起点，rawEndPos-1 是终点）
  const clamp = (n: number) => Math.max(0, Math.min(raw.length - 1, n));
  const sIdx = clamp(rawStart);
  const eIdx = clamp(rawEndPos - 1);
  return {
    runStart: rawToRun[sIdx],
    charStart: rawToChar[sIdx],
    runEnd: rawToRun[eIdx],
    charEnd: rawToChar[eIdx] + 1,
  };
}