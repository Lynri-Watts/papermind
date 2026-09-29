import * as pdfjsLib from 'pdfjs-dist';

/** 归一化文本：多条空白折叠为单个空格、去除首尾空白，便于宽松匹配 */
export function normalizeText(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

/** CJK 统一表意文字（含扩展A）、CJK 部首/符号、全角标点——这类字符之间的
 *  排版空白没有语义，PyMuPDF 与 pdf.js 提取时取舍相反（如封面"作 者 姓 名"
 *  vs"作者姓名"），匹配时必须忽略 */
const CJK_CHAR_RE = /[㐀-鿿豈-﫿　-〿＀-￯]/;

function isCJK(ch: string | undefined): boolean {
  return !!ch && CJK_CHAR_RE.test(ch);
}

/**
 * 构造"紧凑匹配索引"，做两件跨提取器对齐的事：
 *
 * 1. **删除至少一侧是 CJK 字符的空白**：后端 PyMuPDF 提取中文时常把 run 直接
 *    相连（"作者姓名"），pdf.js 常保留排版空格（"作 者 姓 名"），两侧规范化后
 *    仍无法字符级对齐。拉丁词之间的空格保留，英文匹配不受影响。
 * 2. **逐码点 NFKC 兼容折叠**：两个提取器取到的码点可能不同——PyMuPDF 常原样
 *    输出连字/全角/兼容字符（"ﬁgure" U+FB01），pdf.js 输出分解后的 ASCII
 *    （"figure"）。不折叠则 indexOf 精确匹配与逐词模糊匹配都会失败。只做单码点
 *    兼容分解（不跨字符合字），两处文本即映到同一形式。
 *
 * 折叠可能变长（ﬁ 一个码点 → "fi" 两个字符），故 toNorm 按**输出字符**逐位记录
 * 来源的 norm 偏移；命中后用该映射换算回 norm 坐标，再走 run 坐标做高亮。
 */
function buildSquashIndex(norm: string): { text: string; toNorm: number[] } {
  let text = '';
  const toNorm: number[] = [];
  // 上一个落入 text 的**原**字符（折叠前）：判断"CJK 周边空白"要用原码点，
  // 不能看 text 末尾（全角标点折叠后已是 ASCII，会误判为非 CJK）
  let lastKept = '';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (/\s/.test(ch) && (isCJK(lastKept) || isCJK(norm[i + 1]))) {
      continue; // 丢弃 CJK 周边空白
    }
    const folded = ch.normalize('NFKC');
    for (let k = 0; k < folded.length; k++) {
      toNorm.push(i);
      text += folded[k];
    }
    lastKept = ch;
  }
  return { text, toNorm };
}

// ---------- 页码 / 页眉页脚噪声（与后端 services/textmatch.py 同规则镜像） ----------
// 原则一致：**不清理、不改写**提取文本，只在"比较文字"时把噪声当不存在。
// PyMuPDF 会把页码/页眉页脚按块顺序插进正文中间，模型逐字引用时可能带上、
// 也可能被迫删掉；pdf.js 不把它们插入正文阅读顺序，因此前端在构造**去噪
// 紧凑视图**的同时，也要能从引用原句里剔除噪声词元，两种转录才能定位到同一处。

/** 删除全部空白（对应后端 textmatch.squash_ws） */
function squashWs(s: string): string {
  return s.replace(/\s+/g, '');
}

/** 页码/页码标签判定（对"已去空白"的整行键 / 单词元生效，规则同后端） */
const PAGE_NOISE_RES: RegExp[] = [
  // 纯页码：可选包裹符号 + 数字或罗马数字（"12"、"- 7 -"、"[iv]"、"· 3 ·"）
  /^[\s\-–—~_·.,:;]*(?:\d{1,4}|[ivxlcdm]{1,7})[\s\-–—~_·.,:;]*$/i,
  // 第 12 页 / 12/30 / 共 30 页
  /^第?\s*\d{1,4}\s*页?(?:\s*[/／共]\s*\d{1,4}\s*页?)?$/,
  // Page 12 / p.12 / pp. 12 of 30
  /^(?:pp?|page)\s*\.?\s*\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i,
];

function isPageNoiseKey(squashed: string): boolean {
  return !!squashed && PAGE_NOISE_RES.some((r) => r.test(squashed));
}

/** 去空白后的整行/词元是否属于噪声（页码 或 全文重复 ≥3 次的页眉页脚短行） */
function isNoiseKey(squashed: string, running: Set<string>): boolean {
  return !!squashed && (isPageNoiseKey(squashed) || running.has(squashed.toLowerCase()));
}

/** 一行（去空白后）在全文里重复此次数即视为页眉/页脚（对应后端 RUNNING_MIN_REPEATS） */
const RUNNING_MIN_REPEATS = 3;
/** 候选行长度上限（对应后端 RUNNING_MAX_CHARS） */
const RUNNING_MAX_CHARS = 120;

interface LineRec {
  /** 所属页（0 基） */
  page: number;
  /** 该行所属页在拼接全文中的 norm 起始偏移 */
  normBase: number;
  /** 该行在本页 raw 中的起止偏移（不含行尾 \n） */
  rawStart: number;
  rawEnd: number;
  /** 去空白 + 小写的整行键 */
  key: string;
}

/**
 * normalizeText 的带映射版本：把 ``raw`` 折叠空白（``\s+`` → 单空格、去首尾），
 * 同时返回每个 norm 字符在 raw 中的下标（被折叠/丢弃的空白不产生映射项）。
 */
function normalizeWithMap(raw: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n && /\s/.test(raw[i])) i++; // trim 起始空白
  while (i < n) {
    if (/\s/.test(raw[i])) {
      const wsAt = i;
      while (i < n && /\s/.test(raw[i])) i++;
      if (i < n) {
        out += ' ';
        map.push(wsAt); // 折叠空格挂在首个空白字符上
      }
    } else {
      out += raw[i];
      map.push(i);
      i++;
    }
  }
  return { text: out, map };
}

/**
 * 把"逐字符保留/删除"后的字符流折叠空白（``\s+`` → 单空格、去首尾），
 * 同步折叠位置数组（``pos`` 中 -1 表示该字符无 norm 归属，如行分隔补位空格）。
 */
function collapseKept(chars: string[], pos: number[]): { text: string; pos: number[] } {
  let i = 0;
  while (i < chars.length && /\s/.test(chars[i])) i++;
  const outChars: string[] = [];
  const outPos: number[] = [];
  while (i < chars.length) {
    if (/\s/.test(chars[i])) {
      const wsPos = pos[i];
      while (i < chars.length && /\s/.test(chars[i])) i++;
      if (i < chars.length) {
        outChars.push(' ');
        outPos.push(wsPos);
      }
    } else {
      outChars.push(chars[i]);
      outPos.push(pos[i]);
      i++;
    }
  }
  return { text: outChars.join(''), pos: outPos };
}

/**
 * 构造**去噪紧凑视图**：在按行重建的全文上删除页码行、页眉页脚重复行与行内
 * 噪声词元，再折叠空白、CJK 周边空格并做 NFKC 折叠（与原文紧凑视图同一套后处理）。
 *
 * @returns ``text`` 去噪紧凑文本；``toNorm`` 逐字符对应到拼接全文 norm 偏移
 *          （空白挂点可能为 -1，换算命中范围时跳过）
 */
function buildDenoiseIndex(
  lines: LineRec[],
  pageRaws: string[],
  pageMaps: number[][],
  running: Set<string>,
): { text: string; toNorm: number[] } {
  const keptChars: string[] = [];
  const keptPos: number[] = [];
  for (const rec of lines) {
    if (isNoiseKey(rec.key, running)) continue; // 整行是噪声（页码/页眉页脚）
    const raw = pageRaws[rec.page];
    const map = pageMaps[rec.page];
    const line = raw.slice(rec.rawStart, rec.rawEnd);
    for (const m of line.matchAll(/\S+|\s+/g)) {
      const seg = m[0];
      const segStart = m.index ?? 0;
      if (/^\s+$/.test(seg)) {
        for (let k = 0; k < seg.length; k++) {
          keptChars.push(seg[k]);
          keptPos.push(-1);
        }
        continue;
      }
      if (isNoiseKey(squashWs(seg), running)) continue; // 行内噪声词元（如夹在正文间的页码）
      for (let k = 0; k < seg.length; k++) {
        const rawIdx = rec.rawStart + segStart + k;
        const normIdx = map[rawIdx];
        keptChars.push(seg[k]);
        keptPos.push(normIdx >= 0 ? rec.normBase + normIdx : -1);
      }
    }
    keptChars.push(' '); // 行分隔按一个空格处理（再经 collapseKept 折叠）
    keptPos.push(-1);
  }
  const { text: denoiseNorm, pos: denoisePos } = collapseKept(keptChars, keptPos);
  const compact = buildSquashIndex(denoiseNorm);
  return {
    text: compact.text,
    toNorm: compact.toNorm.map((dn) => (dn >= 0 && dn < denoisePos.length ? denoisePos[dn] : -1)),
  };
}

/**
 * 从引用原句（norm 形式）剔除页码/页眉页脚词元后做紧凑折叠，得到可在去噪
 * 紧凑视图中 indexOf 的目标。模型若把噪声一并照抄（PyMuPDF 把它们插在正文
 * 中间），只有把目标侧噪声也剔除，跨提取器（PyMuPDF→pdf.js）才能对齐。
 */
function denoiseCompactTarget(target: string, running: Set<string>): string {
  const kept: string[] = [];
  for (const m of target.matchAll(/\S+|\s+/g)) {
    const seg = m[0];
    if (/^\s+$/.test(seg) || !isNoiseKey(squashWs(seg), running)) {
      kept.push(seg);
    }
  }
  return buildSquashIndex(kept.join('')).text;
}

/**
 * 从紧凑目标中取一个"定位签名"：足够长的连续 CJK 片段，优先取片段中部
 * （开头常是章节号/页眉，中部最具区分度）。优先选择在全文中**唯一命中**
 * 的候选（避免跳到重复出现的页眉/措辞处）；所有候选都不唯一时（典型为
 * 目录条目——标题在目录与正文各出现一次），取**首次命中**，即目录页位置。
 */
function findCjkSignature(sqTarget: string, sqFull: string): { start: number; length: number } | null {
  const runs = (sqTarget.match(/[㐀-鿿豈-﫿]{6,}/g) ?? [])
    .sort((a, b) => b.length - a.length);
  let firstNonUnique: { start: number; length: number } | null = null;
  for (const run of runs) {
    for (const size of [14, 12, 10, 8]) {
      if (run.length < size) continue;
      const begin = Math.max(0, Math.floor((run.length - size) / 2));
      const gram = run.slice(begin, begin + size);
      const first = sqFull.indexOf(gram);
      if (first === -1) continue;
      const hit = { start: first, length: gram.length };
      if (sqFull.indexOf(gram, first + 1) === -1) return hit; // 唯一命中，最可靠
      firstNonUnique ??= hit;
    }
  }
  return firstNonUnique;
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
 * 因此这里在 hasEOL 的行尾补 '\n'（normalize 折叠空白后与补空格逐字符等价，
 * 同时保留了行结构——页码/页眉页脚噪声检测需要按行进行，见
 * buildDenoiseIndex），保证与后端提取的文本字符级对齐。
 *
 * 额外产物：去噪紧凑视图（denoiseSquash）与全文重复页眉行集合（running），
 * 规则与后端 services/textmatch.py 镜像，改动任一侧须同步另一侧。
 */
/** 整篇文档的拼接全文缓存：同一次 PDF 加载内多次定位（点击多个引用）不必反复提取 */
const fullTextCache = new WeakMap<
  pdfjsLib.PDFDocumentProxy,
  {
    fullText: string;
    pageOffsets: number[];
    squashText: string;
    sqToNorm: number[];
    denoiseSquash: string;
    denoiseToNorm: number[];
    running: Set<string>;
  }
>();

export async function extractFullText(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<{
  fullText: string;
  pageOffsets: number[];
  squashText: string;
  sqToNorm: number[];
  denoiseSquash: string;
  denoiseToNorm: number[];
  running: Set<string>;
}> {
  const cached = fullTextCache.get(doc);
  if (cached) return cached;

  let fullText = '';
  const pageOffsets: number[] = [];
  // 行重建所需的按页原始数据（构造完去噪索引后即释放，不进缓存）
  const pageRaws: string[] = [];
  const pageMaps: number[][] = [];
  const lines: LineRec[] = [];
  const lineCounts = new Map<string, number>();
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // 按 hasEOL 重建行结构：行尾用 \n（与后端 PyMuPDF 的 get_text 行一致），
    // normalize 时 \n 与旧实现补的空格同为空白，折叠结果逐字符不变
    let pageRaw = '';
    for (const item of content.items) {
      // 与 pdf.js 文本层一致：空字符串 run 不产生 DOM span，这里一并跳过，
      // 保证 extractFullText 的拼接与 normOffsetToRunRange 的 run 坐标完全对齐。
      if (!('str' in item) || item.str === '') continue;
      pageRaw += item.str;
      if (item.hasEOL) pageRaw += '\n';
    }
    const { text: normPage, map: rawMap } = normalizeWithMap(pageRaw);
    const normBase = fullText.length;
    pageOffsets.push(normBase);
    fullText += normPage;

    // 登记本页各行（键 = 去空白 + 小写整行），供页眉页脚重复检测与去噪遍历
    const pageIndex = pageRaws.length;
    pageRaws.push(pageRaw);
    pageMaps.push(rawMap);
    let cursor = 0;
    for (const line of pageRaw.split('\n')) {
      const rawStart = cursor;
      const rawEnd = cursor + line.length;
      cursor = rawEnd + 1; // 跳过分隔符 '\n'
      const key = squashWs(line).toLowerCase();
      // 所有行都要进 lines（去噪遍历需要正文长行）；仅短行参与页眉页脚计数
      lines.push({ page: pageIndex, normBase, rawStart, rawEnd, key });
      if (key && key.length <= RUNNING_MAX_CHARS) {
        lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const running = new Set(
    [...lineCounts.entries()].filter(([, n]) => n >= RUNNING_MIN_REPEATS).map(([k]) => k),
  );
  const { text: squashText, toNorm: sqToNorm } = buildSquashIndex(fullText);
  const { text: denoiseSquash, toNorm: denoiseToNorm } =
    buildDenoiseIndex(lines, pageRaws, pageMaps, running);
  const result = {
    fullText, pageOffsets, squashText, sqToNorm,
    denoiseSquash, denoiseToNorm, running,
  };
  fullTextCache.set(doc, result);
  return result;
}

/**
 * 在全文（逐页拼接）中定位某段文本，返回命中信息；找不到返回 null。
 *
 * 匹配层级（逐级放宽，命中即止）：
 * 1. norm 全文精确子串（含去首尾引号的变体）；
 * 2. **紧凑整段**：两侧都抹掉 CJK 周边排版空格 + 逐码点 NFKC 折叠后子串
 *    （修复中文文档 PyMuPDF「作者姓名」与 pdf.js「作 者 姓 名」的提取差异，
 *    以及连字「ﬁgure」与「figure」的码点差异）；先试原文紧凑视图（接受模型
 *    把页码/页眉照抄进引用），再试**去噪紧凑视图**（接受模型删掉噪声，且
 *    跨提取器对齐 pdf.js 的阅读顺序）；
 * 3. **CJK 唯一短签名**：整段仍对不齐时（页眉页脚插入、多栏排序差异），
 *    取目标中部一段 8~14 字的唯一汉字片段定位（原文、去噪两视图依次尝试）；
 * 4. 英文逐词连续模糊匹配（findFuzzyMatch）。
 *
 * 层级 2/3 命中的是"紧凑索引"偏移，经各自的 toNorm 映射回 norm 偏移后再返回
 * （去噪视图的命中范围跨越被剔除噪声时，norm 区间会包含那段噪声），
 * 页码反查与 run 高亮坐标换算与层级 1 完全一致。
 */
export async function locateInDocument(
  doc: pdfjsLib.PDFDocumentProxy,
  rawText: string,
): Promise<LocateResult | null> {
  const target = normalizeText(rawText);
  if (!target) return null;
  const {
    fullText, pageOffsets, squashText, sqToNorm,
    denoiseSquash, denoiseToNorm, running,
  } = await extractFullText(doc);

  // 1) 精确匹配（原文逐字；AI 引用可能是去引号后的文本）
  const unquoted = stripQuotes(target);
  let hitIdx = fullText.indexOf(target);
  let hitLen = target.length;
  if (hitIdx === -1 && unquoted && unquoted !== target) {
    hitIdx = fullText.indexOf(unquoted);
    hitLen = unquoted.length;
  }

  // 2)/3) 紧凑匹配 + CJK 唯一短签名；原文视图与去噪视图依次尝试
  if (hitIdx === -1) {
    const wanted = unquoted || target;
    let hit: { start: number; length: number } | null = null;
    // 2) 原文紧凑整段（接受模型照抄页码/页眉）
    const sqTarget = buildSquashIndex(wanted);
    hit = compactRange(squashText, sqTarget.text, sqToNorm);
    // 3a) 原文紧凑视图上的 CJK 唯一短签名
    if (!hit) hit = signatureRange(sqTarget.text, squashText, sqToNorm);
    // 去噪视图：目标侧同样剔除页码/页眉词元（PyMuPDF 插进正文的噪声在
    // pdf.js 阅读顺序里位于他处，不剔除目标噪声则跨提取器无法连续匹配）
    if (!hit) {
      const dTarget = denoiseCompactTarget(wanted, running);
      if (dTarget) {
        // 2b) 去噪紧凑整段（接受模型删掉噪声）
        hit = compactRange(denoiseSquash, dTarget, denoiseToNorm);
        // 3b) 去噪紧凑视图上的 CJK 唯一短签名
        if (!hit) hit = signatureRange(dTarget, denoiseSquash, denoiseToNorm);
      }
    }
    if (hit) {
      hitIdx = hit.start;
      hitLen = hit.length;
    }
  }

  // 4) 仍失败 → 英文词序列模糊匹配
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

/** 把紧凑视图中的命中区间 [pos, pos+len) 换算回拼接全文 norm 偏移区间 */
function compactRange(
  haystack: string,
  needle: string,
  toNorm: number[],
): { start: number; length: number } | null {
  const pos = haystack.indexOf(needle);
  if (pos === -1) return null;
  return mapCompactSpan(pos, needle.length, toNorm);
}

/** 把 CJK 签名命中区间换算回拼接全文 norm 偏移区间 */
function signatureRange(
  compactTarget: string,
  haystack: string,
  toNorm: number[],
): { start: number; length: number } | null {
  const sig = findCjkSignature(compactTarget, haystack);
  return sig ? mapCompactSpan(sig.start, sig.length, toNorm) : null;
}

/**
 * 紧凑偏移 → norm 偏移：区间两端向内跳过无 norm 挂点的字符（去噪视图中被
 * 剔除噪声两侧的折叠空格挂点为 -1），返回覆盖首尾挂点的 norm 区间。
 */
function mapCompactSpan(pos: number, len: number, toNorm: number[]):
{ start: number; length: number } | null {
  let a = pos;
  let b = Math.min(pos + len, toNorm.length) - 1;
  while (a <= b && toNorm[a] < 0) a++;
  while (b >= a && toNorm[b] < 0) b--;
  if (a > b) return null;
  const start = toNorm[a];
  const end = toNorm[b] + 1;
  return { start, length: Math.max(1, end - start) };
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
 * 把 extractFullText 的"页内偏移"（hasEOL 换行符经空白折叠后的全文偏移）
 * 映射回页内按 run 顺序排列的 DOM 文本偏移，用于精确连续范围高亮。
 *
 * 原理：extractFullText 每页文本 = normalize(concat(run.str + (hasEOL?'\n':'')))；
 * 而 DOM 中每个 run 对应一个 span[data-pdf-text]，span.textContent === run.str。
 * 本函数重建"含 hasEOL 空格"的原始页文本（'\n' 折叠后与空格逐字符等价，norm
 * 不变），逐字符建立 norm 偏移 → run 位置映射，再把目标的 norm 区间换算为
 * run 起点/终点坐标。
 *
 * @param runs 按渲染顺序排列的每页 runs（与 DOM spans 一一对应）
 * @param normStart 命中文本在页内 normalize 全文中的起始偏移（hit.start - hit.pageStart）
 * @param normLen 命中文本长度（已在页内截断；跨被剔除噪声时区间可能含噪声 run）
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