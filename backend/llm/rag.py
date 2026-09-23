"""RAG：全文分块 + BM25 检索 + LLM 问答（支持多源 Context）。

流程：
1. 对每个数据源（当前论文 / context 项）的全文按句子边界分块
2. 用户问题用 BM25（非负 IDF）检索最相关分块
3. 汇总相关分块作为"上下文"拼接进 prompt，调用 LLM
4. 返回答案 + 出处分块（含来源 label，前端可标注 context）
"""
from __future__ import annotations

import math
import re
from difflib import SequenceMatcher
from typing import Optional

from llm.client import LLMClient, LLMNotConfiguredError
from i18n import tr

CHUNK_SIZE = 900
CHUNK_OVERLAP = 150
TOP_K = 4
MAX_CONTEXT_SELECT = 4
MAX_SUMMARY_LIST = 30
# 精简历史：最多保留最近 N 轮、每轮最多 M 字符，控制 token 用量
MAX_HISTORY_MESSAGES = 6
MAX_HISTORY_CHARS = 1500

# 常见缩写：其句号不表示句子边界，分块前先保护，避免把 "Fig. 1" 误切成两段
_ABBR_WORDS = [
    "e.g", "i.e", "et al", "etc", "Fig", "Figs", "Eq", "Eqs", "Ref", "Refs",
    "Sec", "Secs", "Sect", "Sects", "Tab", "Tabs", "Vol", "Vols", "pp", "No",
    "nos", "vs", "cf", "ca", "approx", "Dr", "Mr", "Mrs", "Ms", "Prof", "St",
    "Mt", "Inc", "Ltd", "Co", "Jr", "Sr", "resp", "al", "Ch", "Chs", "App",
    "Apps", "Ph.D", "M.S", "B.S", "U.S", "U.K",
]


def _protect_abbreviations(text: str) -> str:
    """把缩写/小数里的句号替换为占位符，避免句子切分时被误切。"""
    for w in _ABBR_WORDS:
        text = re.sub(rf"\b{re.escape(w)}\.(?=[\s,])", w + "\x00", text, flags=re.I)
    # 小数 / 版本号，如 1.2
    text = re.sub(r"(?<=\d)\.(?=\d)", "\x00", text)
    return text


# 句末边界正则配合 _split_sentences 使用（模块级编译）
_SENT_BOUNDARY_RE = re.compile(
    r".+?(?:[.!?][\"')\]”’」』】》]*(?=\s|$)"      # 西文句末 + 可选闭引号 + 空白/文末
    r"|[。！？…？！]+[\"')\]”’」』）)】》]*"         # 中文句末（连续标点整体，如……？！）+ 可选闭引号
    r"|$)",
    re.S,
)


def _split_sentences(text: str) -> list[str]:
    """按句末标点把文本切成完整句子（保护缩写与小数）。

    同时支持两类边界：
    - 西文 ``.!?``：缩写/小数已被占位符保护，且其后必须跟空白或文末
      （与论文正文的英文书写习惯一致，避免误切 "v1.2"、词中句点）；
    - 中文/全角 ``。！？…？！``：中日韩文本句读后通常**直接**写下一句
      （无空格），其后允许跟随闭引号/括号，不能要求空白——旧实现只认
      西文边界，导致中文整篇被当成一个超长句、分块全部退化为定长窗口。
    """
    protected = _protect_abbreviations(text)
    parts = [
        m.group(0) for m in _SENT_BOUNDARY_RE.finditer(protected)
    ]
    return [p.replace("\x00", ".").strip() for p in parts if p.strip()]


# CJK 统一表意文字 / 扩展A / 平假名-片假名 / 韩文音节（覆盖中、日、韩文本）
_CJK_CHAR_RE = re.compile(r"[㐀-䶿一-鿿぀-ヿ가-힯]")
_TOKEN_RE = re.compile(
    r"[a-z0-9]+(?:[._\-][a-z0-9]+)*"   # 拉丁/数字词（含 1.2、AI-Dij 类连写）
    r"|[㐀-䶿一-鿿぀-ヿ가-힯]",          # 单个 CJK 字符
    re.IGNORECASE,
)


def _bm25_tokens(text: str) -> list[str]:
    """BM25 统一分词（英文与 CJK 共用）。

    - 拉丁/数字按空白与标点成词（与旧 ``str.split`` 对英文的效果一致）；
    - CJK 文本词间无空格，取**单字 unigram + 相邻二字 bigram**：单字保证
      召回，二字组提供词级区分度，高频虚字（的/了/在）由 BM25 IDF 自然
      降权；标点/空白会隔断相邻字，不跨标点组 bigram。

    旧实现对查询和文档一律 ``str.split``：中文被切成整段巨型 token，
    与任何分块都不重合，BM25 恒 0，检索退化为"返回前 N 块"（即论文封面/
    目录/摘要），真正相关的正文段落永远无法进入上下文。
    """
    tokens: list[str] = []
    run: list[str] = []
    last_end = 0

    def flush_run() -> None:
        if not run:
            return
        tokens.extend(run)
        if len(run) >= 2:
            tokens.extend(run[i] + run[i + 1] for i in range(len(run) - 1))
        run.clear()

    for m in _TOKEN_RE.finditer(text.lower()):
        # 与上一 token 之间存在标点/空白：断开 CJK 连续段
        if m.start() != last_end:
            flush_run()
        last_end = m.end()
        tok = m.group(0)
        if len(tok) == 1 and _CJK_CHAR_RE.match(tok):
            run.append(tok)
        else:
            flush_run()
            tokens.append(tok)
    flush_run()
    return tokens


# 短语在单个入选块内的最低结构匹配度：连续 bigram 命中（允许 1 个译名/
# 异写缺口）占短语 bigram 总数的比例低于此值，视为该短语未被材料覆盖。
# 0.5 的含义：2 字词必须命中；3 字词至少命中相邻 2 个 bigram；4 字词
# 锚定链至少覆盖 3 个位置（如"蒙特/特卡"命中、"卡洛"为译名缺口）。
WEAK_PHRASE_SCORE = 0.5

# 功能字集合：CJK bigram 任一端命中即视为短语边界（结构助词、语气词、
# 疑问指代语素、连词、部分介词与副词）。真正的术语 bigram 几乎不含这些字；
# 刻意排除"不/没/无/非/未/有/向/对/为/在/到/据/使/被/正/中/能/可/应/要/会/法"
# 等字——它们参与构成"不足/未来/有效/方向/相对/数据/使用/被动/正常/
# 中心/效应/性能/算法"等真实术语，不能误杀
_STOP_CHARS = set(
    "的地得了着是么吗呢吧啊呀嘛哦哈"
    "怎哪谁何孰"
    "这那此该其某每各"
    "们你我他她它"
    "与和及或且并"
    "把让令"
    "也都就还又再已将曾很最更只才便却"
    "些做问"
)
# 不含功能字、但对话题无判别力的通用 bigram；在短语切分中同样作为断点
# （"蒙特卡洛方法"→"蒙特卡洛"，"计算速度问题"→"计算速度"）
_STOP_BIGRAMS = {
    "完成", "工作", "论文", "本文", "作者", "研究", "方法", "方式", "问题",
    "内容", "方面", "情况", "进行", "通过", "相关", "需要", "可能", "能够",
    "应该", "可以", "必须", "已经", "主要", "重要", "具体", "基本", "一般",
    "目前", "时候", "地方", "东西", "事情", "自己", "大家", "别人", "其他",
    "其它", "其余", "另外", "知道", "觉得", "一下", "一些", "没有", "还有",
}
# 拉丁停用词（疑问/指代/系动词/介词 + 学术套话名词）
_STOP_LATIN = {
    "what", "which", "how", "why", "when", "where", "who", "whom", "whose",
    "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
    "can", "could", "should", "would", "will", "shall", "may", "might", "must",
    "the", "a", "an", "of", "in", "on", "at", "to", "for", "with", "and",
    "or", "not", "no", "this", "that", "these", "those", "it", "its", "as",
    "by", "from", "about", "there", "here", "their", "his", "her", "our",
    "your", "we", "you", "they", "them", "us", "i", "he", "she",
    "paper", "study", "method", "methods", "work", "research", "question",
    "problem", "answer",
}

# 连续 CJK 字符段（与 _bm25_tokens 覆盖范围一致）
_CJK_RUN_RE = re.compile(r"[㐀-䶿一-鿿぀-ヿ가-힯]+")


def _split_cjk_phrase(run: str) -> list[str]:
    """把连续 CJK 字符段按功能字与通用 bigram 切成候选话题短语。

    例如 "蒙特卡洛方法的计算速度问题" → ["蒙特卡洛", "计算速度"]；
    "不足与未来研究方向" → ["不足", "未来", "方向"]（"与"是功能字、
    "研究"是停用 bigram，分别成断；碎片是否在同块连续命中仍由
    _cjk_phrase_score 逐一检验）。
    """
    phrases: list[str] = []
    start = 0
    i = 0
    while i < len(run):
        if run[i] in _STOP_CHARS:
            if i > start:
                phrases.append(run[start:i])
            start = i + 1
            i += 1
            continue
        if i + 2 <= len(run) and run[i:i + 2] in _STOP_BIGRAMS:
            if i > start:
                phrases.append(run[start:i])
            start = i + 2
            i += 2
            continue
        i += 1
    if start < len(run):
        phrases.append(run[start:])
    return [p for p in phrases if len(p) >= 2]


def _question_phrases(question: str) -> tuple[list[str], list[str]]:
    """提取问题中的候选话题短语：(CJK 短语, 拉丁内容词)。"""
    cjk: list[str] = []
    for m in _CJK_RUN_RE.finditer(question):
        for p in _split_cjk_phrase(m.group(0)):
            if p not in cjk:
                cjk.append(p)
    latin = [
        t for t in dict.fromkeys(_bm25_tokens(question))
        if t[:1].isascii() and t[:1].isalpha() and t not in _STOP_LATIN
    ]
    return cjk, latin


def _cjk_phrase_score(phrase: str, chunk_terms: set[str]) -> float:
    """单个 CJK 短语在一个上下文块内的结构匹配度。

    bigram 命中序列上取两种覆盖的较大值：
    - 裸命中率（容忍分散命中，如译名块只命中部分字组）；
    - 锚定延伸链：从短语首/尾出现 ≥2 个连续命中时，向另一方向延伸并
      容忍恰好 1 个内部缺口（"蒙特[✓]特卡[✓]卡洛[✗缺口]"仍算覆盖到
      译名核心），防止"研究方向"式的 3/5 尾部碎片冒充"未来研究方向"
      ——碎片左侧连续两个位置都缺失，锚定链无法延伸过去。
    """
    k = len(phrase) - 1
    if k <= 0:
        return 1.0 if phrase in chunk_terms else 0.0
    marks = [phrase[i:i + 2] in chunk_terms for i in range(k)]
    raw = sum(marks) / k

    def anchored_chain(begin: int, step: int) -> int:
        # 起点必须有 ≥2 连续命中锚定，随后容忍 1 个缺口，再遇缺口即止
        end = begin + step
        if not (0 <= begin < k and 0 <= end < k and marks[begin] and marks[end]):
            return 0
        covered = 2
        gap_used = False
        i = end + step
        while 0 <= i < k:
            if marks[i]:
                covered += 1
            elif not gap_used:
                gap_used = True  # 容忍译名/异写造成的单个缺口
            else:
                break
            i += step
        return covered

    chain = max(anchored_chain(0, 1), anchored_chain(k - 1, -1)) / k
    return max(raw, chain)


def is_weak_lexical_match(question: str, hit_chunks: list[str]) -> bool:
    """判断入选上下文是否真正覆盖了问题的话题短语（弱词面匹配判定）。

    判定只需要**实际入选上下文**的分块（不依赖全量候选池的文档频率——
    词频/单字频率启发式已被证明不可靠："发展"高频会掩盖"展望"缺失，
    译名变体"卡洛"反被误判为缺失）。流程：

    1. 用功能字与通用停用词把问题切成话题短语（"未来展望""局限性"
       "蒙特卡洛""剂量影响矩阵"）与拉丁内容词；
    2. 每个 CJK 短语在每个入选块上取结构匹配度（连续 bigram 链，允许
       1 个译名缺口）；拉丁词取同块命中率；
    3. 所有短语的最佳得分都低于 WEAK_PHRASE_SCORE → 弱匹配——材料很
       可能不涉及所问话题（如节选无论文结论/展望章），调用方据此提示
       LLM 谨慎、如实说明缺口，而不是建议用户去翻一个并不存在的章节。

    问题切不出任何 ≥2 字短语或没有候选块时保守返回 False，由调用方的
    BM25 全 0 信号兜底。
    """
    cjk_phrases, latin_terms = _question_phrases(question)
    if (not cjk_phrases and not latin_terms) or not hit_chunks:
        return False
    chunk_term_sets = [set(_bm25_tokens(c)) for c in hit_chunks]
    for phrase in cjk_phrases:
        best = max(_cjk_phrase_score(phrase, s) for s in chunk_term_sets)
        if best >= WEAK_PHRASE_SCORE:
            return False
    if latin_terms:
        for s in chunk_term_sets:
            hit_ratio = sum(t in s for t in latin_terms) / len(latin_terms)
            if hit_ratio >= WEAK_PHRASE_SCORE:
                return False
    return True


def _parse_int_list(text: str) -> list[int]:
    """从 LLM 输出中解析整数列表（容忍 JSON/自然语言混排）。"""
    nums = re.findall(r"\d+", text)
    return [int(n) for n in nums]


def _normalize_history(history: Optional[list]) -> list[dict]:
    """把前端传来的精简历史规整为 LLM 对话轮次：

    - 只保留 user / assistant 且有内容的轮次（不含全文、出处详情）；
    - 截断每轮文本长度、限制轮次数量（保留最近几轮），控制 token 用量。
    """
    if not history or not isinstance(history, list):
        return []
    cleaned: list[dict] = []
    for h in history:
        if not isinstance(h, dict):
            continue
        role = h.get("role")
        content = h.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        cleaned.append({"role": role, "content": content.strip()[:MAX_HISTORY_CHARS]})
    return cleaned[-MAX_HISTORY_MESSAGES:]


# ---------- 行内引用（无编号引用卡） ----------
# 2026-09-22 第二次重构：放弃引用编号。模型在回答的任意位置（允许一句话
# 中间）插入**不带编号**的行内引用标签，标签内是从某个出处分块逐字复制
# 的一句原文：
#
#   该方法在 ImageNet 上[Q]We report a top-1 accuracy of 85.3%.[/Q]取得最佳。
#
# - 出处不由模型编号指定：后端把摘录与**全部检索分块**做逐字匹配来确定
#   出处；每张卡独立，同一出处可被多张卡引用。界面上也不出现任何编号。
# - 摘录很短时可能逐字命中多个分块（相邻分块有重叠、或跨材料重复句）：
#   先按出处身份归并（同一 paper/context 的重叠分块等价），仍歧义则用
#   标签在答案中的**上下文句**对候选分块做相似度消歧（用户明确要求：
#   短句多命中必须匹配上下文，不能随便取一个）。
# - 逐字零命中（模型改写/编造）：用上下文句对全部分块做扩展模糊匹配，
#   命中则把卡片文字替换为分块中的真实原句（保留历史锚句匹配机制）；
#   仍失败 → 引用失败卡（保留模型文字、注明无法核对、不可定位）。
#
# 标签语法（前端按同一语法解析；数字只是后端绑定的内部键，界面不显示）：
#   流式未决（闭合即转发，尚未绑定出处）：[Q]摘录[/Q]
#   终态成功（绑定到第 n 个 source，1-based）：[Q+n]摘录[/Q]
#   终态失败（无法核对原文）：              [Q!]摘录[/Q]
INLINE_QUOTE_PENDING_RE = re.compile(
    r"\[\s*q\s*\]([\s\S]*?)\[\s*/\s*q\s*\]", re.IGNORECASE
)
INLINE_QUOTE_OPEN_RE = re.compile(r"\[\s*q\s*\]", re.IGNORECASE)
INLINE_QUOTE_CLOSE_RE = re.compile(r"\[\s*/\s*q\s*\]", re.IGNORECASE)
# 未决/终态统一的完整块正则（终态前缀 +n / ! 为可选）
INLINE_QUOTE_FULL_RE = re.compile(
    r"\[\s*q\s*(?:([+!])(\d+)?)?\s*\]([\s\S]*?)\[\s*/\s*q\s*\]",
    re.IGNORECASE,
)
QUOTE_MAX_CHARS = 80          # 回退核心句展示/定位用的长度上限
QUOTE_ACCEPT_MAX_CHARS = 120  # 失败卡展示模型原文的长度上限
_ANSWER_SENT_BOUNDARY = "。！？；!?;\n"
_ANCHOR_RADIUS = 300          # 消歧/回退时取标签前后文的半径（字符）
_ANCHOR_MIN_RUN = 10          # 上下文锚句与分块最长连续重合下限
_ANCHOR_MIN_RATIO = 0.45      # 命中点局部窗口相似度阈值
# 跨材料多命中消歧时，最佳候选必须领先次优至少这么多，否则视为无法判定
_ANCHOR_DISAMBIG_MARGIN = 0.05
# normal 状态下尾部"可能是开标签前缀"的最大扣留长度（[ + 空白 + q + 空白）
_OPEN_TAG_MAX_HOLD = 8
# 计算标签上下文时需剔除的机器标记：未决引用块整体、旧版 [Source N]
_MACHINE_MARK_RE = re.compile(
    r"\[\s*q\s*\][\s\S]*?\[\s*/\s*q\s*\]|\[\s*source\s*\d+\s*\]",
    re.IGNORECASE,
)


def _squash_ws(text: str) -> str:
    """删除全部空白（中英混合文本的跨提取器对齐策略与前端 pdfLocate 一致）。"""
    return re.sub(r"\s+", "", text)


def _open_tag_border(text: str) -> int:
    """normal 状态下返回应继续扣留的后缀起点。

    尾部若是开标签的某个前缀（``"["`` / ``"[q"`` / ``"[ Q "`` 等，允许
    标签内空白），整段扣留等下一帧确认——否则标签被 chunk 切碎时会把
    ``"[Q"`` 当成正文泄漏；确认不是标签后该片段随下一帧原样补发。
    """
    tail = text[-_OPEN_TAG_MAX_HOLD:]
    for i, ch in enumerate(tail):
        if ch != "[":
            continue
        cand = tail[i:]
        if re.fullmatch(r"\[\s*(?:[qQ]\s*)?", cand):
            return len(text) - len(tail) + i
    return len(text)


class InlineQuoteExtractor:
    """从回答 delta 流中解析无编号行内引用 ``[Q]摘录[/Q]`` 的状态机。

    - :meth:`feed` 接收模型原始增量，返回可转发给前端的可见文本：普通
      正文原样转发；引用块闭合后以**未决态** ``[Q]摘录[/Q]`` 内联转发。
      出处绑定在流末 :func:`finalize_inline_answer` 统一完成——多命中消歧
      与模糊匹配都需要标签之后的上下文句，流式中途无法可靠判定。
    - :meth:`finish` 在流结束时补发最后扣留的普通文本；空摘录块与未
      闭合块一律丢弃（半截标签/摘录绝不泄漏到正文）。
    """

    def __init__(self) -> None:
        self._pending = ""               # normal 状态未确认的后缀
        self._qbuf: Optional[str] = None  # quote 状态：开标签后已扣留文本

    def feed(self, chunk: str) -> str:
        out: list[str] = []
        self._pending += chunk
        while self._pending:
            if self._qbuf is not None:
                # quote 状态：等待闭标签（可能跨 chunk，全部扣留）。
                # 闭标签必须在 qbuf + pending 拼接缓冲里搜：闭标签首字符
                # 在更早 chunk 时只搜 pending 会永远漏配、整段摘录被吞。
                haystack = self._qbuf + self._pending
                m = INLINE_QUOTE_CLOSE_RE.search(haystack)
                if m is None:
                    self._qbuf, self._pending = haystack, ""
                    break
                excerpt = haystack[:m.start()].strip()
                self._pending = haystack[m.end():]
                self._qbuf = None
                if excerpt:
                    out.append(f"[Q]{excerpt}[/Q]")
                continue
            m = INLINE_QUOTE_OPEN_RE.search(self._pending)
            if m is None:
                cut = _open_tag_border(self._pending)
                out.append(self._pending[:cut])
                self._pending = self._pending[cut:]
                break
            out.append(self._pending[:m.start()])
            self._qbuf = ""
            self._pending = self._pending[m.end():]
        return "".join(out)

    def finish(self) -> str:
        """流结束：补发扣留的普通正文；未闭合引用块丢弃。"""
        tail = "" if self._qbuf is not None else self._pending
        self._pending = ""
        self._qbuf = None
        return tail


def strip_inline_quote_markers(text: str) -> str:
    """剔除全部行内引用块（标签 + 摘录，未决/终态通吃），得到纯正文。"""
    return INLINE_QUOTE_FULL_RE.sub("", text)


def _source_identity(src: dict, fallback: int) -> tuple:
    """出处身份键：同一论文/同一上下文条目的重叠分块对定位而言等价。
    两个标识都缺失（不应该出现）时退化为按序号区分，绝不错误合并。"""
    pid, cid = src.get("paper_id"), src.get("context_id")
    if pid is None and cid is None:
        return ("__index__", fallback)
    return (pid, cid)


def _anchor_around(answer: str, start: int, end: int) -> str:
    """取引用标签位置前后相邻的句子片段（前句尾 + 后句头），作为多命中
    消歧与扩展模糊匹配的上下文锚点。

    刻意**不**把标签内摘录拼入锚句：多命中消歧时摘录对各候选完全相同、
    无信息量；零命中模糊匹配时非逐字摘录只会稀释旧机制在局部窗口上调优
    过的相似度比率。锚句定义与历史 ``extract_core_quote`` 的
    ``_answer_anchor_text`` 保持一致（机器标记剔除、句界切分、去空白）。
    """
    before = _MACHINE_MARK_RE.sub(" ", answer[max(0, start - _ANCHOR_RADIUS):start])
    after = _MACHINE_MARK_RE.sub(" ", answer[end:end + _ANCHOR_RADIUS])
    pre = re.split(rf"[{_ANSWER_SENT_BOUNDARY}]", before)[-1]
    post = re.split(rf"[{_ANSWER_SENT_BOUNDARY}]", after, maxsplit=1)[0]
    return _squash_ws((pre + post).lower())


def finalize_inline_answer(answer: str, sources: list[dict]) -> str:
    """流式/非流式共用的收口：为每个未决 ``[Q]摘录[/Q]`` 绑定出处并输出终态。

    绑定策略见模块头注释：逐字唯一命中即绑定；多命中先按出处身份归并、
    再用标签上下文句消歧；零命中走全分块扩展模糊匹配（卡片改用分块真实
    原句）；都失败输出 ``[Q!]`` 失败卡。返回终态答案文本。
    """
    chunks = [s.get("text") or "" for s in sources]
    norm_chunks = [_norm_with_offsets(c.lower()) for c in chunks]

    out: list[str] = []
    cursor = 0
    for m in INLINE_QUOTE_PENDING_RE.finditer(answer):
        out.append(answer[cursor:m.start()])
        excerpt = m.group(1).strip()
        anchor = _anchor_around(answer, m.start(), m.end())
        state, index, display = _bind_citation(
            excerpt, sources, chunks, norm_chunks, anchor
        )
        if state == "bound":
            out.append(f"[Q+{index}]{display}[/Q]")
        else:
            out.append(f"[Q!]{display}[/Q]")
        cursor = m.end()
    out.append(answer[cursor:])
    return "".join(out)


def _is_verbatim_excerpt(quote: str, chunk: str) -> bool:
    """校验模型摘录确为 chunk 中**逐字连续**出现的片段（防编造/改写）。

    先在"去全部空白"层面比对（兼容 PDF/排版空格差异）；不通过再去掉
    标点比对一层（容忍模型把中文标点写成西文等微小出入）。
    """
    q = _squash_ws(quote)
    if len(q) < 6:
        return False
    if q in _squash_ws(chunk):
        return True
    strip_punct = lambda s: re.sub(r"[\s\W_]+", "", s, flags=re.UNICODE)
    q2, c2 = strip_punct(q), strip_punct(_squash_ws(chunk))
    return len(q2) >= 6 and q2 in c2


def _norm_with_offsets(text: str) -> tuple[str, list[int]]:
    """去全部空白，返回 (归一化文本, 映射)：映射[i]为第 i 个归一化字符
    在原文中的索引（用于把命中窗口映射回 chunk 真实子串）。"""
    chars: list[str] = []
    offsets: list[int] = []
    for i, ch in enumerate(text):
        if ch.isspace():
            continue
        chars.append(ch)
        offsets.append(i)
    return "".join(chars), offsets


def _score_anchor_against_chunk(
    anchor_norm: str, chunk_norm: str
) -> Optional[tuple[float, int, int]]:
    """上下文锚句对单个归一化分块打分。

    先在整个 chunk 上找最长连续重合（强证据：转述也会保留成片原词，
    要求 ≥10 字符），再在命中点周围的局部窗口上算相似度（直接对约
    900 字整 chunk 算 ratio 会被无关文本稀释），阈值 0.45。
    返回 ``(ratio, 窗口起, 窗口止)``（norm 坐标），不可靠返回 None。
    """
    if len(anchor_norm) < _ANCHOR_MIN_RUN:
        return None
    sm = SequenceMatcher(None, anchor_norm, chunk_norm, autojunk=False)
    m = sm.find_longest_match(0, len(anchor_norm), 0, len(chunk_norm))
    if m.size < _ANCHOR_MIN_RUN:
        return None
    w0 = max(0, m.b - len(anchor_norm))
    w1 = min(len(chunk_norm), m.b + m.size + len(anchor_norm))
    ratio = SequenceMatcher(
        None, anchor_norm, chunk_norm[w0:w1], autojunk=False
    ).ratio()
    if ratio < _ANCHOR_MIN_RATIO:
        return None
    # 以连续命中段为中心取 QUOTE_MAX_CHARS 窗口（norm 坐标）
    half = QUOTE_MAX_CHARS // 2
    center = (m.b + m.b + m.size) // 2
    start = max(0, min(m.b, center - half))
    end = min(len(chunk_norm), max(m.b + m.size, center + half))
    return ratio, start, end


def _raw_window(chunk: str, offsets: list[int], start: int, end: int) -> str:
    """把 norm 坐标窗口映射回 chunk 真实连续子串；英文边界切在单词中间时
    向两侧扩到词边界（仅 ASCII 字母数字；CJK 不扩，否则越过句界吞邻句）。"""
    raw_start, raw_end = offsets[start], offsets[end - 1] + 1
    while raw_start > 0 and chunk[raw_start - 1].isascii() and chunk[raw_start - 1].isalnum():
        raw_start -= 1
    while raw_end < len(chunk) and chunk[raw_end].isascii() and chunk[raw_end].isalnum():
        raw_end += 1
    return chunk[raw_start:raw_end].strip()


def _bind_citation(
    excerpt: str,
    sources: list[dict],
    chunks: list[str],
    norm_chunks: list[tuple[str, list[int]]],
    anchor_norm: str,
) -> tuple[str, Optional[int], str]:
    """把一张未决引用卡绑定到出处分块。

    :returns: ``("bound", 1-based 序号, 卡片展示文字)`` 或
              ``("failed", None, 模型原文（截断）)``。

    顺序：逐字唯一命中 → 绑定；多命中先按出处身份归并（重叠分块等价），
    仍跨材料则用锚句对候选打分消歧；零命中用锚句对全部分块扩展模糊
    匹配，命中则把展示文字换成分块中的真实原句；全部失败返回失败卡。
    """
    ai_text = excerpt.strip()
    if not ai_text:
        return "failed", None, ""
    short = ai_text[:QUOTE_ACCEPT_MAX_CHARS]

    candidates = [
        i for i, chunk in enumerate(chunks)
        if chunk and _is_verbatim_excerpt(ai_text, chunk)
    ]
    if len(candidates) == 1:
        return "bound", candidates[0] + 1, ai_text
    if len(candidates) > 1:
        identities = {_source_identity(sources[i], i) for i in candidates}
        if len(identities) == 1:
            # 同一材料的重叠/重复分块：定位目标等价，取检索序最前者
            return "bound", candidates[0] + 1, ai_text
        scored = [
            (i, _score_anchor_against_chunk(anchor_norm, norm_chunks[i][0]))
            for i in candidates
        ]
        scored = [(i, s) for i, s in scored if s is not None]
        if scored:
            ranked = sorted(scored, key=lambda x: x[1][0], reverse=True)
            best_i, best_stats = ranked[0]
            runner_up = ranked[1][1][0] if len(ranked) > 1 else -1.0
            # 必须明确领先：等分词面对应不同材料时不能猜一个
            if best_stats[0] - runner_up >= _ANCHOR_DISAMBIG_MARGIN:
                return "bound", best_i + 1, ai_text
        # 跨材料多命中且上下文无法消歧：不能猜，按引用失败处理
        return "failed", None, short

    # 逐字零命中：模型改写或编造。用标签上下文句对全部分块扩展模糊匹配，
    # 命中则卡片改用分块真实原句（保留历史扩展上下文匹配机制）。
    best: Optional[tuple[int, float, int, int]] = None
    for i, (chunk_norm, _offsets) in enumerate(norm_chunks):
        if not chunks[i]:
            continue
        scored = _score_anchor_against_chunk(anchor_norm, chunk_norm)
        if scored is None:
            continue
        ratio, start, end = scored
        if best is None or ratio > best[1]:
            best = (i, ratio, start, end)
    if best is not None:
        i, _ratio, start, end = best
        real = _raw_window(chunks[i], norm_chunks[i][1], start, end)
        if real:
            return "bound", i + 1, real
    return "failed", None, short


def _bm25_scores(query_tokens: list[str], tokenized_docs: list[list[str]]) -> list[float]:
    """对每个文档给出 BM25 相关分（k1=1.5, b=0.75），使用**平滑恒正 IDF**。

    这里刻意不使用 rank_bm25 的原始 IDF = log((N - df + 0.5) / (df + 0.5))：
    当某词出现在超过一半分块时（分块总数少、或论文通篇围绕同一核心概念——
    两者都极常见）该值变负，会把"强相关"的整篇文档扣成负分，进而被误判成
    "未检索到段落"。改用平滑 IDF = log1p((N - df + 0.5) / (df + 0.5))，它在
    任何 df 下都为正：低频词权重高、高频词权重小但仍有贡献，兼顾区分度与
    "命中即相关"的基本语义。

    :returns: 与 tokenized_docs 一一对应的分数列表
    """
    n_docs = len(tokenized_docs)
    if n_docs == 0 or not query_tokens:
        return [0.0] * n_docs
    doc_len = [len(doc) for doc in tokenized_docs]
    avgdl = sum(doc_len) / n_docs
    df: dict[str, int] = {}
    for doc in tokenized_docs:
        for term in set(doc):
            df[term] = df.get(term, 0) + 1
    k1, b = 1.5, 0.75
    scores = [0.0] * n_docs
    for q in query_tokens:
        qdf = df.get(q, 0)
        if qdf == 0:
            continue
        idf = math.log1p((n_docs - qdf + 0.5) / (qdf + 0.5))
        for i, doc in enumerate(tokenized_docs):
            freq = doc.count(q)
            if freq == 0:
                continue
            denom = freq + k1 * (1 - b + b * doc_len[i] / avgdl)
            scores[i] += idf * (freq * (k1 + 1) / denom)
    return scores


class RAGEngine:
    def __init__(self, client: LLMClient) -> None:
        self.client = client

    # ---------- 分块 ----------
    @staticmethod
    def chunk_text(text: str, chunk_size: int = CHUNK_SIZE,
                   overlap: int = CHUNK_OVERLAP) -> list[str]:
        """按句子边界分块：每个分块以完整句子起止，引用可读、有头有尾。

        说明：
        - 先把文本切成完整句子，再按 chunk_size 贪心拼装句子成块；
        - 若单句超过 chunk_size（长公式 / 引用列表），退化为字符窗口切分
          （保留 overlap），避免无限循环，也保证该句内容不被遗漏；
        - 相比固定字符窗口，句子级分块不会出现"引用没头没尾"的问题。
        """
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return []
        sentences = _split_sentences(text)
        if not sentences:
            return []
        chunks: list[str] = []
        current = ""
        for s in sentences:
            if len(s) > chunk_size:
                # 单句超长（长公式 / 引用列表）：先收尾当前块，再退化为字符窗口切分
                if current:
                    chunks.append(current)
                    current = ""
                step = chunk_size - overlap
                if step < 1:
                    step = max(1, chunk_size // 2)
                windows = [s[i:i + chunk_size] for i in range(0, len(s), step)]
                # 末尾残窗过短时并入前窗：避免夹在块序列中间的短块在 BM25
                # 长度归一化下虚高（文末残块的同款处理在函数末尾）
                if (len(windows) >= 2
                        and len(windows[-1]) < chunk_size * 0.3):
                    windows[-2] += windows[-1]
                    windows.pop()
                chunks.extend(windows)
            elif not current:
                current = s
            elif len(current) + 1 + len(s) <= chunk_size:
                current += " " + s
            else:
                chunks.append(current)
                current = s
        if current:
            chunks.append(current)
        # 末尾残块（如致谢/作者简介尾巴）过短时并入上一块：避免独立短块在
        # BM25 长度归一化下获得虚高分数、挤掉正文相关块
        if len(chunks) >= 2 and len(chunks[-1]) < chunk_size * 0.3:
            chunks[-2] = chunks[-2] + " " + chunks[-1]
            chunks.pop()
        return chunks

    # ---------- 检索 ----------
    @staticmethod
    def retrieve(query: str, chunks: list[str], top_k: int = TOP_K) -> list[tuple[str, float]]:
        """BM25 检索最相关的 top_k 个分块。

        检索分只表示**词形层面的重叠信号**：得分高代表分块确实出现了问题中的
        词汇；得 0 分则只说明没有共享词（同义改写 / 跨语言 / 交叉学科术语差异
        都会造成 0 分），**并不等价于"无关"**。因此即便全部 0 分也返回 top_k，
        由上层（prepare_answer）标注弱相关后交给 LLM 做实质相关性判断，而不是
        直接判死为"未检索到段落"。
        """
        if not chunks:
            return []
        tokenized_chunks = [_bm25_tokens(c) for c in chunks]
        scores = _bm25_scores(_bm25_tokens(query), tokenized_chunks)
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
        return [(chunks[i], scores[i]) for i in ranked]

    # ---------- 上下文项筛选（第一轮，混合模式） ----------
    def select_context_items(self, question: str,
                             summaries: list[dict], current: Optional[dict] = None,
                             max_items: int = MAX_CONTEXT_SELECT) -> list[int]:
        """根据摘要判定哪些候选项与问题相关。

        当前论文作为特殊候选 id=0（标注"当前论文"），与 context 项一同交给
        AI 判定是否需要阅读全文，未选中的候选不读，以节约时间与 token。
        提示词会**强调当前论文是用户的阅读焦点、默认选中**，但最终选择权
        仍在 AI：它可以显式输出 [] 表示问题与当前论文无关；仅在 LLM 调用
        失败/输出不可解析时才退回 BM25（该降级路径同样默认带上 id=0）。

        :param summaries: context 项 [{"id": int, "title": str, "summary": str}, ...]
        :param current: 当前论文 {"id": 0, "title": str, "summary": str}；None 表示不纳入
        :returns: 选中的候选 id 列表（0 表示当前论文；其余为 context item id）
        """
        candidates: list[dict] = []
        if current is not None:
            candidates.append(current)
        candidates.extend(summaries)
        candidates = candidates[:MAX_SUMMARY_LIST]
        if not candidates:
            return []
        listing = "\n\n".join(
            f"[{it['id']}] {it['title']}\n摘要: {(it.get('summary') or '')[:200]}"
            for it in candidates
        )
        # 描述当前焦点（论文 / 上下文库），无焦点时说明仅凭问题作答
        if current is not None:
            focus_desc = (
                "用户当前打开着一篇论文（编号 0，标注'当前论文'），其余编号为上下文库中的材料。"
                "**编号 0 是用户正在阅读的论文，代表明确的阅读焦点，默认应当选中它读取全文**；"
                "仅当问题明显与该论文无关时（如纯通用知识问题、或只涉及其他材料/写作的请求）"
                "才可不选编号 0。根据用户问题与各候选项的摘要，判断还需要阅读哪些候选项的"
            )
        else:
            focus_desc = "用户未打开论文，可用材料为下列上下文库条目。根据用户问题与各候选项的摘要，判断需要阅读哪些候选项的"
        system = (
            f"你是论文研究助手的上下文调度器。{focus_desc}"
            "全文才能回答问题；除上述对当前论文的默认偏好外，与问题无关的候选项不要选中，"
            "以节约计算。可输出空数组。"
            "只输出 JSON 数组，例如 [0,3]，不要输出其他任何文字。"
        )
        user = f"用户问题：{question}\n\n可用候选项（含编号）：\n{listing}"
        try:
            result = self.client.chat(
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=0,
            )
            content = result.get("content") or ""
            ids = _parse_int_list(content)
            valid = {it["id"] for it in candidates}
            ids = [i for i in ids if i in valid]
            if ids:
                return ids[:max_items]
            # 模型成功响应且显式给出空数组：尊重"无需读取任何候选"的判断，
            # 不用 BM25 降级把材料重新塞回去；输出无法解析时才走降级
            if re.search(r"\[\s*\]", content):
                return []
        except Exception:
            # LLM 不可用则回退 BM25
            pass
        return self._bm25_select(question, candidates, max_items)

    @staticmethod
    def _bm25_select(question: str, items: list[dict], max_items: int) -> list[int]:
        """回退：在摘要文本上做 BM25（非负 IDF，CJK 感知分词），选最相关项。

        仅在 LLM 选材调用失败时使用。当前打开的论文（id 保留为 0）是用户的
        显式阅读焦点：即使 CJK 分词后摘要与问题仍可能词面零重合（如问
        "局限性"而摘要只列成果），降级选择仍默认把 0 置于队首（受 max_items
        截断保护）；其余候选项按真实 BM25 分数排序。
        """
        texts = [f"{(it.get('summary') or '')} {it['title']}" for it in items]
        tokenized = [_bm25_tokens(t) for t in texts]
        scores = _bm25_scores(_bm25_tokens(question), tokenized)
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:max_items]
        picked = [items[i]["id"] for i in ranked if scores[i] > 0]
        if any(it["id"] == 0 for it in items):
            picked = [0, *[x for x in picked if x != 0]]
        return picked[:max_items]

    # ---------- 流式"思考 + 筛选"（ReAct：把选择候选的推理过程实时展示） ----------
    def select_materials_reasoning(self, question: str,
                                   summaries: list[dict], current: Optional[dict] = None,
                                   max_items: int = MAX_CONTEXT_SELECT):
        """边流式输出"为什么读这些候选"的思考，边决定要读取哪些候选（当前论文 + 上下文库）。

        与 :meth:`select_context_items` 等价但多一个流式思考环节：模型先输出一段
        面向用户的简短推理（说明依据问题打算阅读哪些候选及其原因），随后在同一回合
        给出选择。真实候选读取动作由调用方在拿到选择后执行。

        :param summaries: context 项 [{"id": int, "title": str, "summary": str}, ...]
        :param current: 当前论文 {"id": 0, ...}；None 表示不纳入
        :yields: {"type": "thought", "delta": str} 思考增量；
                 最后 {"type": "selected", "ids": [int, ...]}（无候选时直接 yield 空选择）
        """
        candidates: list[dict] = []
        if current is not None:
            candidates.append(current)
        candidates.extend(summaries or [])
        candidates = candidates[:MAX_SUMMARY_LIST]
        if not candidates:
            yield {"type": "selected", "ids": []}
            return
        valid_ids = {it["id"] for it in candidates}

        listing = "\n\n".join(
            f"[{it['id']}] {it['title']}\n摘要: {(it.get('summary') or '')[:200]}"
            for it in candidates
        )
        focus_desc = (
            "用户当前打开着一篇论文（编号 0，标注'当前论文'），其余编号为上下文库"
            "中的材料。**编号 0 是用户正在阅读的论文，代表明确的阅读焦点：默认必须"
            "选中它读取全文**，仅当问题明显与该论文无关时（纯通用知识问题，或只涉及"
            "其他材料/写作的请求）才可不选编号 0。"
            if current is not None else
            "用户未打开论文，可用材料为下列上下文库条目。"
        )
        system = (
            "你是论文研究助手的上下文调度器。"
            f"{focus_desc} 在此基础上判断为了回答问题还要读取哪些候选项的全文。"
            "除对当前论文的上述默认偏好外，与问题无关的候选项不要选中，以节约时间与 token。\n"
            "输出要求：先输出一段**思考**（会实时展示给用户）：说明根据问题你打算"
            "阅读哪些候选、为什么（不要引用具体数字或编号）；思考后另起一行输出选择，"
            f"格式为 SELECT: [候选编号数组]，只读候选输出 SELECT: []。\n"
            f"示例思考格式：'用户询问具体方法细节，需要读取当前论文及相关材料的全文。'\n"
            "除思考与 SELECT 行外不要输出其他内容。"
        )
        user = f"用户问题：{question}\n\n可用候选项（含编号）：\n{listing}"

        parts: list[str] = []
        try:
            for delta in self.client.chat_stream(
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=0,
            ):
                parts.append(delta)
                yield {"type": "thought", "delta": delta}
        except Exception:
            # LLM 不可用：跳过思考，直接用 BM25 回退选择
            ids = self._bm25_select(question, candidates, max_items)
            yield {"type": "selected", "ids": ids}
            return

        full = "".join(parts)
        # 优先取最后一处 SELECT: [...] 标记；模型未遵循格式时回退全文字符解析
        ids: list[int] = []
        markers = list(re.finditer(r"SELECT\s*:\s*(\[[^\]\n]*\])", full, flags=re.I))
        explicit_empty = bool(markers) and markers[-1].group(1).strip() == "[]"
        if markers:
            raw = re.findall(r"\d+", markers[-1].group(1))
        else:
            raw = re.findall(r"\d+", full)
        for x in raw:
            try:
                num = int(x)
            except ValueError:
                continue
            if num in valid_ids and num not in ids:
                ids.append(num)
        if not ids and not explicit_empty:
            # 模型未给出可解析的选择（格式漂移/空输出）：回退 BM25，保证流程可用。
            # 显式 SELECT: [] 代表"无需读取"，必须尊重，不做降级。
            ids = self._bm25_select(question, candidates, max_items)
        yield {"type": "selected", "ids": ids[:max_items]}


    # ---------- 问答 ----------
    def answer(self, question: str, fulltext: str, paper: dict) -> dict:
        """对单篇论文全文回答问题（兼容旧接口）。"""
        return self.answer_multi(
            question,
            sources=[{"label": paper.get("title", ""), "text": fulltext}],
            paper=paper,
        )

    def answer_multi(self, question: str, sources: list[dict],
                     paper: Optional[dict] = None,
                     history: Optional[list] = None) -> dict:
        """对多个数据源回答问题（非流式，兼容旧接口）。

        :param sources: [{"label": str, "text": str, "context_id": int|None, ...}, ...]
        :param paper: 当前论文元数据（可空）
        :param history: 精简对话历史（追问上下文，不含全文）
        :returns: {"answer", "sources": [{"index","label","context_id","text","score"}], "usage"}
        """
        sources_out, messages = self.prepare_answer(question, sources, paper, history)
        result = self.client.chat(messages, temperature=0.2)
        # 与流式路径一致：增量解析行内引用块（未决态转发），流末统一做
        # 逐字绑定 / 上下文消歧 / 扩展模糊匹配 / 失败卡终态化
        extractor = InlineQuoteExtractor()
        visible = extractor.feed(result["content"])
        tail = extractor.finish()
        answer = finalize_inline_answer(visible + tail, sources_out)
        return {
            "answer": answer,
            "sources": sources_out,
            "usage": result["usage"],
        }

    def prepare_answer(self, question: str, sources: list[dict],
                       paper: Optional[dict] = None,
                       history: Optional[list] = None,
                       grounded: bool = True) -> tuple[list[dict], list[dict]]:
        """检索 + 组装 prompt（流式 / 非流式共用）。

        :param history: 精简对话历史（仅 user/assistant 文字，不含全文与出处详情）
        :param grounded: True（默认）= 必须基于检索材料，材料无可用段落时抛
            ValueError；False = 允许在**无任何材料**时仅凭模型通用知识作答
            （调用方负责先向用户发出"无材料"提示）。
        :returns: (sources_out, messages)
                  sources_out：出处分块 [{"index","label","context_id","text","score"}]
                  messages：发给 LLM 的对话（system + 历史 + user）
        """
        passages: list[dict] = []
        for src in sources:
            text = src.get("text") or ""
            if not text:
                continue
            chunks = self.chunk_text(text)
            if not chunks:
                continue
            for chunk, score in self.retrieve(question, chunks):
                passages.append({
                    "label": src.get("label", ""),
                    "context_id": src.get("context_id"),
                    "paper_id": src.get("paper_id"),
                    "text": chunk,
                    "score": score,
                })

        if not passages:
            if grounded:
                # 仅当材料里确实没有可切分的全文段落时才报错（如全是图表/引用列表）
                raise ValueError(tr("rag.no_readable_passages"))
            # 无材料模式：不检索任何段落，直接组装"通用知识作答"对话
            return self._prepare_unguided_answer(question, paper, history)

        passages.sort(key=lambda p: p["score"], reverse=True)
        passages = passages[:TOP_K]

        # 弱相关：入选上下文没有在同一个块内连续覆盖问题的任何话题短语
        # （如问"展望/局限"而节选论文无结论章，命中的只是致谢里的通用
        # 词）——BM25 全 0 的旧信号在 CJK 分词修复后已不再触发，故改以
        # 短语结构覆盖判定（纯单字查询仍看全 0）。这类问题往往是开放式/
        # 跨材料联想型：词面缺失不代表材料无关，交由 LLM 判断实质相关性，
        # 并允许它基于可用材料分析或如实指出缺口。
        zero_scores = not any(p["score"] > 0 for p in passages)
        weak = zero_scores or is_weak_lexical_match(
            question, [p["text"] for p in passages]
        )

        title = (paper or {}).get("title", "")
        year = (paper or {}).get("year")
        authors = (paper or {}).get("authors", []) or []
        author_str = ", ".join(authors[:3])
        if len(authors) > 3:
            author_str += " et al."

        prompt_sources = "\n\n".join(
            f"[Source {i + 1} - {p['label']}]\n{p['text']}"
            for i, p in enumerate(passages)
        )

        system = (
            "You are PaperMind, the AI research assistant embedded in a three-column "
            "research desktop: a PDF reader for the currently open paper on the left, "
            "a LaTeX editor on the right, and a Q&A panel with a context library in "
            "the middle. You help the researcher think: answer grounded in the "
            "provided sources, then go further by connecting and extending them.\n\n"
            "=== ENVIRONMENT ===\n"
            "- The currently open paper is stated in the User message (id=0).\n"
            "- Other sources (tagged with a context id) come from the researcher's "
            "context library; they may be papers or web pages.\n"
            "- Earlier turns may be included as conversation history; they are "
            "context only and do not add sources beyond the ones listed below.\n"
            "- The sources below are delimited by [Source N - ...] headers for "
            "your reading only — the numbers are NOT citation keys and must "
            "never appear in your answer. Tracing works automatically: you "
            "embed a verbatim copy of the source sentence and the system finds "
            "which source it came from.\n\n"
            "=== RESPONSE RULES ===\n"
            "1. Ground facts in the sources. Facts, figures, results, claims and "
            "methods taken from a source must be quoted VERBATIM as COMPLETE "
            "sentences (from the start of a sentence to its period, word-for-word, "
            "never paraphrased or truncated), wrapped in an inline citation tag "
            "at the exact point where you use the fact (rule 7).\n"
            "2. Synthesize and reason beyond quotation — this is your core value. "
            "Connect ideas across sources: compare and contrast papers, reconcile "
            "conflicting claims, chain their conclusions toward the question, "
            "transfer methods or findings to the researcher's own problem, and "
            "explore implications, including cross-disciplinary links the sources "
            "do not spell out.\n"
            "3. Never dress up an inference as a source fact. When you go beyond "
            "what the quoted material states, frame it explicitly (\"the sources "
            "imply that ...\", \"one could hypothesize ...\", \"by analogy, ...\", "
            "\"this suggests ...\"), so verbatim-quoted facts stay visibly sourced "
            "and your analysis stays visibly yours.\n"
            "4. Use Markdown structure: short headings, bullets, bold key terms, "
            "and tables when useful, so the answer is easy to scan.\n"
            "5. If the materials genuinely do not support the question even after "
            "reasonable synthesis, say so explicitly, explain what is missing, and "
            "suggest what to search for or add — never fabricate.\n"
            "6. Answer in the language of the question.\n"
            "7. Inline citations — the citation IS part of the sentence, not a "
            "footnote. Whenever you state a fact taken from a source, embed a "
            "citation tag containing the supporting source sentence at that exact "
            "spot, in EXACTLY this form:\n"
            "[Q]<one core sentence copied VERBATIM, character for character, "
            "from one of the sources>[/Q]\n"
            "   - NO number inside the tag: the system locates the source by "
            "matching the quoted text itself. Never write [Source N] or [Q:N] "
            "in your answer.\n"
            "   - The tag may sit in the MIDDLE of your sentence, right where "
            "the fact is used, e.g. \"The model achieves [Q]We report a top-1 "
            "accuracy of 85.3%.[/Q] on ImageNet, which suggests ...\"; it may "
            "also sit right after the sentence. Each citation card is "
            "independent — cite the same source as many times as you use it.\n"
            "   - The excerpt must be a CONTINUOUS, CHARACTER-FOR-CHARACTER copy "
            "from one source block (never rephrased, translated, abbreviated or "
            "stitched together), in the source's own language and punctuation, "
            "≤80 characters, one sentence (at most two) — the single sentence "
            "that best supports the claim at that spot. Short or non-verbatim "
            "quotes cannot be matched and will be shown as failed citations.\n"
            "   - Never place a tag inside a heading or a table cell; for a "
            "fact in a table, put the tag in the sentence right after the "
            "table.\n"
            "   - Do NOT append any trailing quote list or manifest, and do not "
            "output any other machine-readable block. If a claim has no "
            "verbatim source sentence worth quoting, state it as your own "
            "analysis without a tag.\n"
        )
        user = (
            f"Currently open paper: \"{title}\" ({year}) by {author_str}.\n\n"
            if title else "Currently open paper: not loaded.\n\n"
        )
        if weak:
            user += (
                "Note: lexical retrieval for this question is weak — the passages "
                "below were matched only by common/generic words, while the "
                "question's distinctive terms (specific topic words, names, or "
                "phrases such as future-work / limitation terminology) do not "
                "appear in them. The source text may simply not cover what is "
                "asked (e.g. an excerpt without a conclusion/outlook section). "
                "Read the passages critically: do not infer coverage that is not "
                "there, and do not suggest consulting a chapter whose existence "
                "in the material is unverified. If they do not address the "
                "question, say so explicitly, state what is missing, and suggest "
                "what additional material would help.\n\n"
            )
        user += (
            f"Sources:\n{prompt_sources}\n\nQuestion: {question}\n\n"
            "Embed the verbatim [Q]...[/Q] citations inline within your answer "
            "exactly as specified in response rule 7 (no numbers, no source tags)."
        )

        sources_out = [
            {
                "index": i + 1,
                "label": p["label"],
                "context_id": p["context_id"],
                "paper_id": p["paper_id"],
                "text": p["text"],
                "score": round(p["score"], 3),
            }
            for i, p in enumerate(passages)
        ]
        messages = [{"role": "system", "content": system}]
        for h in _normalize_history(history):
            messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": user})
        return sources_out, messages

    def _prepare_unguided_answer(self, question: str,
                                 paper: Optional[dict],
                                 history: Optional[list]) -> tuple[list[dict], list[dict]]:
        """组装"无检索材料"的回答对话：仅凭模型通用知识作答，并明确标注未核实。

        与 :meth:`prepare_answer` 的 grounded 路径共用 persona 与历史规整，
        但不包含任何 [Source N] 段落；若用户当前打开着论文（仅拿到元数据、
        全文不可读），把标题/作者/年份告知模型——它可能凭公开知识认识该论文，
        但必须显式标注不确定性。
        """
        title = (paper or {}).get("title", "")
        year = (paper or {}).get("year")
        authors = (paper or {}).get("authors", []) or []
        author_str = ", ".join(authors[:3])
        if len(authors) > 3:
            author_str += " et al."

        system = (
            "You are PaperMind, the AI research assistant embedded in a researcher's "
            "desktop (PDF reader + context library + Q&A panel).\n\n"
            "=== IMPORTANT: NO RETRIEVED MATERIAL THIS TURN ===\n"
            "No readable source material is available: the open paper's full text "
            "could not be read, the context library provided nothing, and external "
            "tools retrieved nothing usable. You must STILL answer the user's "
            "question helpfully, using your own general knowledge.\n\n"
            "=== RESPONSE RULES ===\n"
            "1. Answer the question directly and substantively from general "
            "knowledge. Near the start, state in one short sentence that the answer "
            "is based on your general knowledge rather than retrieved sources and "
            "may be outdated or inaccurate, and that opening a paper or adding "
            "context enables a grounded answer.\n"
            "2. Never fabricate citations, [Source N] tags, quotes, figures, or "
            "claims that you pretend came from a specific paper. If the open paper "
            "is identified in the User message, you may share what you generally "
            "know about it but mark uncertainty explicitly.\n"
            "3. Prefer well-established facts; flag speculative or fast-moving "
            "information as such. Suggest concrete material the user could add.\n"
            "4. Use Markdown structure (short headings, bullets, bold key terms) so "
            "the answer is easy to scan.\n"
            "5. Answer in the language of the question.\n"
        )
        user = (
            f"Currently open paper: \"{title}\" ({year}) by {author_str}.\n"
            if title else "Currently open paper: not loaded.\n"
        )
        user += "No retrieved sources are available for this turn.\n\n"
        user += f"Question: {question}"

        messages = [{"role": "system", "content": system}]
        for h in _normalize_history(history):
            messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": user})
        return [], messages

    def stream_answer(self, question: str, sources: list[dict],
                      paper: Optional[dict] = None,
                      history: Optional[list] = None,
                      grounded: bool = True):
        """流式问答生成器（供 SSE 使用）。

        :param grounded: False 时允许 sources 为空（或全部不可切分），走通用
            知识作答路径（首帧 sources 为空列表）。
        :yields: dict 事件：
            {"type": "sources", "sources": [...]}  首帧，出处分块（无材料时为 []）
            {"type": "delta", "delta": str}        每个回答文本增量
        """
        sources_out, messages = self.prepare_answer(
            question, sources, paper, history, grounded=grounded,
        )
        yield {"type": "sources", "sources": sources_out}
        for delta in self.client.chat_stream(messages, temperature=0.2):
            yield {"type": "delta", "delta": delta}


def build_rag_engine() -> RAGEngine:
    """工厂：按当前配置构造 RAG 引擎；未配置 key 时抛出明确错误。"""
    return RAGEngine(LLMClient())
