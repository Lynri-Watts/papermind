"""文本匹配辅助：页码/页眉页脚噪声识别、字面段落选取、句子切分。

供两处共用：

- ``llm/tools.py`` 的 ``read_paper`` / ``read_context``：按 ``query`` 在全文里
  选取相关段落；
- ``llm/rag.py`` 的行内引用绑定：逐字核对时忽略页码与页眉页脚。

前端 ``src/utils/pdfLocate.ts`` 以**同一套规则**做镜像实现（TS 无法直接复用
Python 代码），改动本文件时须同步核对那份实现。

核心原则（用户明确要求）：**不清理、不改写**已提取/已缓存的全文，只在
"比较文字"时把噪声当作不存在。噪声共两类：

1. **页码**：整行/整词元就是一个页码（阿拉伯数字或罗马数字，可带括号、
   短横等包裹），以及 ``Page 3 of 12`` / ``第 3 页`` 这类页码标签；
2. **页眉页脚**：在同一篇全文里**整行重复出现 ≥N 次**的短行（期刊页眉、
   学位论文页眉等），以及句子中与之等值的空白分隔词元——PyMuPDF 会把
   页眉页脚文本按块顺序插进正文中间（如 "…引擎\\n50\\n北京航空航天大学
   博士学位论文\\n本文…"），模型逐字引用时要么带上、要么被迫删掉它，
   两种写法都必须能核对通过。
"""
from __future__ import annotations

import re

# ---------- 空白 ----------

def squash_ws(text: str) -> str:
    """删除全部空白（中英混合文本的跨提取器对齐策略与前端 pdfLocate 一致）。"""
    return re.sub(r"\s+", "", text)


# ---------- 页码判定（对"已去空白"的整行键 / 单词元生效） ----------

_PAGE_NOISE_RES = (
    # 纯页码：可选包裹符号 + 数字或罗马数字（"12"、"50"、"- 7 -"、"[iv]"、"· 3 ·"）
    re.compile(r"^[\s\-–—~_·.,:;]*(?:\d{1,4}|[ivxlcdm]{1,7})[\s\-–—~_·.,:;]*$", re.IGNORECASE),
    # 第 12 页 / 12/30 / 共 30 页
    re.compile(r"^第?\s*\d{1,4}\s*页?(?:\s*[/／共]\s*\d{1,4}\s*页?)?$"),
    # Page 12 / p.12 / pp. 12 of 30
    re.compile(r"^(?:pp?|page)\s*\.?\s*\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?$", re.IGNORECASE),
)


def is_page_noise_key(squashed: str) -> bool:
    """判断"已去空白"的整行/单词元是否就是一个页码/页码标签。"""
    return bool(squashed) and any(r.match(squashed) for r in _PAGE_NOISE_RES)


# ---------- 页眉/页脚：整行重复 ----------

# 一行（去空白后）在这一篇全文里重复出现达到此次数即视为页眉/页脚
RUNNING_MIN_REPEATS = 3
# 候选行长度上限（页眉页脚都很短；过长的"重复段落"不算噪声）
RUNNING_MAX_CHARS = 120


def detect_running_lines(text: str) -> set[str]:
    """检测页眉/页脚：整行去空白后重复出现 ≥ :data:`RUNNING_MIN_REPEATS` 次的短行。

    返回的键是**去空白 + 小写**的整行文本；比较时不区分大小写，因此同一份
    规则既能用于原文（逐字核对）也能用于小写化后的匹配空间。
    """
    counts: dict[str, int] = {}
    for line in text.split("\n"):
        key = squash_ws(line).lower()
        if not key or len(key) > RUNNING_MAX_CHARS:
            continue
        counts[key] = counts.get(key, 0) + 1
    return {key for key, n in counts.items() if n >= RUNNING_MIN_REPEATS}


# ---------- 去噪（仅在比较时，不改写原文） ----------

_TOKEN_WS_RE = re.compile(r"\S+|\s+")


def _is_noise_key(squashed: str, running: set[str]) -> bool:
    """去空白后的整行/词元是否属于噪声（页码 或 页眉页脚）。"""
    if not squashed:
        return False
    return is_page_noise_key(squashed) or squashed.lower() in running


def _iter_kept(text: str, running: set[str]):
    """逐字符产出保留的 ``(字符, 在原文中的下标)``：删除噪声整行与噪声词元。

    行结构按 ``\\n`` 切分（论文 PDF 解析文本的换行符）；整行是噪声时整行
    连同换行一起丢弃，行内则按"空白分隔词元"粒度丢弃命中的词元。
    """
    pos = 0
    for line in text.split("\n"):
        line_start = pos
        pos += len(line) + 1
        if _is_noise_key(squash_ws(line), running):
            continue
        for m in _TOKEN_WS_RE.finditer(line):
            seg = m.group(0)
            if not seg.isspace() and _is_noise_key(squash_ws(seg), running):
                continue
            base = line_start + m.start()
            for i, ch in enumerate(seg):
                yield ch, base + i


def denoise_text(text: str, running: set[str] | None = None) -> str:
    """返回"删掉噪声后"的文本（保留原空白与换行，供继续分词/切句）。"""
    return "".join(ch for ch, _ in _iter_kept(text, running or set()))


def denoise_squash(text: str, running: set[str] | None = None) -> str:
    """去噪 + 去全部空白（逐字核对用；大小写由调用方决定，保持逐字语义）。"""
    return squash_ws(denoise_text(text, running))


def normalize_for_match(
    text: str, running: set[str] | None = None
) -> tuple[str, list[int]]:
    """去噪 + 逐字符小写 + 去全部空白，返回 ``(归一化文本, 下标映射)``。

    下标映射给出每个归一化字符在**原文**中的位置，用于把相似度打分的命中窗口
    换算回原文真实子串（引用卡展示的"分块真实原句"仍取原文，不取归一化文本）。
    逐字符小写（而非整串 ``.lower()``）保证映射与输出严格一一对应——少数码点
    （如 U+0130）小写后会展开成多个字符，整串小写会让映射与文本长度错位。
    """
    chars: list[str] = []
    offsets: list[int] = []
    for ch, idx in _iter_kept(text, running or set()):
        for lowered in ch.lower():
            if lowered.isspace():
                continue
            chars.append(lowered)
            offsets.append(idx)
    return "".join(chars), offsets


# ---------- 句子切分（段落选取与分块共用） ----------

# 常见缩写：其句号不表示句子边界，切句前先保护，避免把 "Fig. 1" 误切成两段
_ABBR_WORDS = [
    "e.g", "i.e", "et al", "etc", "Fig", "Figs", "Eq", "Eqs", "Ref", "Refs",
    "Sec", "Secs", "Sect", "Sects", "Tab", "Tabs", "Vol", "Vols", "pp", "No",
    "nos", "vs", "cf", "ca", "approx", "Dr", "Mr", "Mrs", "Ms", "Prof", "St",
    "Mt", "Inc", "Ltd", "Co", "Jr", "Sr", "resp", "al", "Ch", "Chs", "App",
    "Apps", "Ph.D", "M.S", "B.S", "U.S", "U.K",
]

_SENT_BOUNDARY_RE = re.compile(
    r".+?(?:[.!?][\"')\]”’」』】》]*(?=\s|$)"      # 西文句末 + 可选闭引号 + 空白/文末
    r"|[。！？…？！]+[\"')\]”’」』）)】》]*"         # 中文句末（连续标点整体，如……？！）+ 可选闭引号
    r"|$)",
    re.S,
)


def _protect_abbreviations(text: str) -> str:
    """把缩写/小数里的句号替换为占位符，避免句子切分时被误切。"""
    for w in _ABBR_WORDS:
        text = re.sub(rf"\b{re.escape(w)}\.(?=[\s,])", w + "\x00", text, flags=re.I)
    # 小数 / 版本号，如 1.2
    text = re.sub(r"(?<=\d)\.(?=\d)", "\x00", text)
    return text


def split_sentences(text: str) -> list[str]:
    """按句末标点把文本切成完整句子（保护缩写与小数）。

    同时支持两类边界：

    - 西文 ``.!?``：缩写/小数已被占位符保护，且其后必须跟空白或文末
      （与论文正文的英文书写习惯一致，避免误切 "v1.2"、词中句点）；
    - 中文/全角 ``。！？…？！``：中日韩文本句读后通常**直接**写下一句
      （无空格），其后允许跟随闭引号/括号，不能要求空白——旧实现只认
      西文边界，导致中文整篇被当成一个超长句。
    """
    protected = _protect_abbreviations(text)
    parts = [m.group(0) for m in _SENT_BOUNDARY_RE.finditer(protected)]
    return [p.replace("\x00", ".").strip() for p in parts if p.strip()]


# ---------- 字面段落选取（read_paper / read_context 的 query） ----------

# 单次查询最多返回的段落数，以及单个段落的字符上限（控制注入 prompt 的体量）
PASSAGE_MAX_ITEMS = 6
PASSAGE_MAX_CHARS = 1800

_LATIN_TERM_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-]*")
_CJK_TERM_RE = re.compile(r"[㐀-䶿一-鿿぀-ヿ가-힯]{2,}")


def query_terms(query: str) -> list[str]:
    """把查询串切成**字面**检索词：拉丁/数字词（≥2 字符）+ 连续 CJK 段（≥2 字）。

    刻意不做词干化/同义扩展/分词降级：命中与否完全由"原文是否逐字出现该词"
    决定，与用户"取消 BM25、字面检索"的要求一致。
    """
    terms = [t.lower() for t in _LATIN_TERM_RE.findall(query) if len(t) >= 2]
    terms += _CJK_TERM_RE.findall(query)
    return list(dict.fromkeys(terms))


def _blocks(text: str, max_chars: int) -> list[str]:
    """把全文切成检索段落：先按空行分段，超长段落再按句子装成 ≤max_chars 的窗。"""
    out: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= max_chars:
            out.append(para)
            continue
        buf = ""
        for sent in split_sentences(re.sub(r"\s+", " ", para)):
            if buf and len(buf) + 1 + len(sent) > max_chars:
                out.append(buf)
                buf = ""
            buf = sent if not buf else f"{buf} {sent}"
        if buf:
            out.append(buf)
    return out


def select_passages(
    text: str,
    query: str,
    max_items: int = PASSAGE_MAX_ITEMS,
    max_chars: int = PASSAGE_MAX_CHARS,
) -> list[str]:
    """在全文里做**字面**段落检索，返回命中段落（按文档顺序，保留原文）。

    命中数 = 段落里出现的不同查询词个数；按命中数降序取前 ``max_items`` 段，
    最终再按文档顺序输出（模型读到的段落顺序与原文一致，便于横向引用）。
    纯页码/页眉行不计为命中段。查询词为空或无任何命中时返回空列表——由调用
    方如实告知"未命中"，不做任何模糊兜底（避免把不相关段落塞进 prompt）。
    """
    terms = query_terms(query)
    if not terms:
        return []
    running = detect_running_lines(text)
    scored: list[tuple[int, int]] = []
    blocks = _blocks(text, max_chars)
    for i, block in enumerate(blocks):
        hay = squash_ws(block).lower()
        if _is_noise_key(hay, running):
            continue
        hits = sum(1 for t in terms if t in hay)
        if hits:
            scored.append((hits, i))
    scored.sort(key=lambda x: (-x[0], x[1]))
    picked = sorted(i for _hits, i in scored[:max_items])
    return [blocks[i] for i in picked]
