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


def _split_sentences(text: str) -> list[str]:
    """按句号/问号/感叹号把文本切成完整句子（保护缩写与小数）。"""
    protected = _protect_abbreviations(text)
    parts = re.split(r"(?<=[.!?])\s+", protected)
    return [p.replace("\x00", ".").strip() for p in parts if p.strip()]


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
                for i in range(0, len(s), step):
                    chunks.append(s[i:i + chunk_size])
            elif not current:
                current = s
            elif len(current) + 1 + len(s) <= chunk_size:
                current += " " + s
            else:
                chunks.append(current)
                current = s
        if current:
            chunks.append(current)
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
        tokenized_chunks = [c.split() for c in chunks]
        scores = _bm25_scores(query.split(), tokenized_chunks)
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
        return [(chunks[i], scores[i]) for i in ranked]

    # ---------- 上下文项筛选（第一轮，混合模式） ----------
    def select_context_items(self, question: str,
                             summaries: list[dict], current: Optional[dict] = None,
                             max_items: int = MAX_CONTEXT_SELECT) -> list[int]:
        """根据摘要判定哪些候选项与问题相关。

        当前论文作为特殊候选 id=0（标注"当前论文"），与 context 项一同交给
        AI 判定是否需要阅读全文，未选中的候选不读，以节约时间与 token。

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
        focus_desc = "根据用户问题与各候选项的摘要，判断需要阅读哪些候选项的"
        if current is not None:
            focus_desc = "用户当前打开着一篇论文（编号 0，标注'当前论文'），其余编号为上下文库中的材料。根据用户问题与各候选项的摘要，判断需要阅读哪些候选项的"
        else:
            focus_desc = "用户未打开论文，可用材料为下列上下文库条目。根据用户问题与各候选项的摘要，判断需要阅读哪些候选项的"
        system = (
            f"你是论文研究助手的上下文调度器。{focus_desc}"
            "全文才能回答问题；与问题无关的候选项不要选中，以节约计算。可输出空数组。"
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
            ids = _parse_int_list(result["content"])
            valid = {it["id"] for it in candidates}
            ids = [i for i in ids if i in valid]
            if ids:
                return ids[:max_items]
        except Exception:
            # LLM 不可用则回退 BM25
            pass
        return self._bm25_select(question, candidates, max_items)

    @staticmethod
    def _bm25_select(question: str, items: list[dict], max_items: int) -> list[int]:
        """回退：在摘要文本上做 BM25（非负 IDF），选最相关项。"""
        texts = [f"{(it.get('summary') or '')} {it['title']}" for it in items]
        tokenized = [t.split() for t in texts]
        scores = _bm25_scores(question.split(), tokenized)
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:max_items]
        return [items[i]["id"] for i in ranked if scores[i] > 0]

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
            "中的材料。"
            if current is not None else
            "用户未打开论文，可用材料为下列上下文库条目。"
        )
        system = (
            "你是论文研究助手的上下文调度器。"
            f"{focus_desc} 需要判断为了回答问题要读取哪些候选项的全文。"
            "与问题无关的候选项不要选中，以节约时间与 token。\n"
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
        if not ids:
            # 思考里若混入编号或 LLM 空输出：回退 BM25，保证流程可用
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
        return {
            "answer": result["content"],
            "sources": sources_out,
            "usage": result["usage"],
        }

    def prepare_answer(self, question: str, sources: list[dict],
                       paper: Optional[dict] = None,
                       history: Optional[list] = None) -> tuple[list[dict], list[dict]]:
        """检索 + 组装 prompt（流式 / 非流式共用）。

        :param history: 精简对话历史（仅 user/assistant 文字，不含全文与出处详情）
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
            # 仅当材料里确实没有可切分的全文段落时才报错（如全是图表/引用列表）
            raise ValueError(tr("rag.no_readable_passages"))

        # 弱相关：问题与所有段落都无词形重叠（BM25 全 0）。这类问题往往是
        # 开放式/交叉学科联想型——词面不同不代表材料无关，交由 LLM 判断实质
        # 相关性，并允许它基于可用材料综合分析或如实指出缺口。
        weak = not any(p["score"] > 0 for p in passages)

        passages.sort(key=lambda p: p["score"], reverse=True)
        passages = passages[:TOP_K]

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
            "- Earlier turns may be included as conversation history. [Source N] "
            "references inside earlier answers refer to the sources of those turns, "
            "NOT to the current sources.\n"
            "- Each fact in an answer can be traced to one of the [Source N] blocks.\n\n"
            "=== RESPONSE RULES ===\n"
            "1. Ground facts in the sources. Facts, figures, results, claims and "
            "methods taken from a source must be quoted VERBATIM as COMPLETE "
            "sentences (from the start of a sentence to its period, word-for-word, "
            "never paraphrased or truncated) with an INLINE [Source N] immediately "
            "after the sentence.\n"
            "2. Synthesize and reason beyond quotation — this is your core value. "
            "Connect ideas across sources: compare and contrast papers, reconcile "
            "conflicting claims, chain their conclusions toward the question, "
            "transfer methods or findings to the researcher's own problem, and "
            "explore implications, including cross-disciplinary links the sources "
            "do not spell out.\n"
            "3. Never dress up an inference as a source fact. When you go beyond "
            "what the quoted material states, frame it explicitly (\"the sources "
            "imply that ...\", \"one could hypothesize ...\", \"by analogy, ...\", "
            "\"this suggests ...\"), so quoted facts stay verbatim with [Source N] "
            "and your analysis stays visibly yours.\n"
            "4. Use Markdown structure: short headings, bullets, bold key terms, "
            "and tables when useful, so the answer is easy to scan.\n"
            "5. If the materials genuinely do not support the question even after "
            "reasonable synthesis, say so explicitly, explain what is missing, and "
            "suggest what to search for or add — never fabricate.\n"
            "6. Answer in the language of the question.\n"
        )
        user = (
            f"Currently open paper: \"{title}\" ({year}) by {author_str}.\n\n"
            if title else "Currently open paper: not loaded.\n\n"
        )
        if weak:
            user += (
                "Note: none of the passages below shares vocabulary with the question "
                "(lexical match is weak). They may still be substantively relevant — "
                "judge before citing. If they do not actually address the question, "
                "say so explicitly and suggest what additional material would help.\n\n"
            )
        user += f"Sources:\n{prompt_sources}\n\nQuestion: {question}"

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

    def stream_answer(self, question: str, sources: list[dict],
                      paper: Optional[dict] = None,
                      history: Optional[list] = None):
        """流式问答生成器（供 SSE 使用）。

        :yields: dict 事件：
            {"type": "sources", "sources": [...]}  首帧，出处分块
            {"type": "delta", "delta": str}        每个回答文本增量
        """
        sources_out, messages = self.prepare_answer(question, sources, paper, history)
        yield {"type": "sources", "sources": sources_out}
        for delta in self.client.chat_stream(messages, temperature=0.2):
            yield {"type": "delta", "delta": delta}


def build_rag_engine() -> RAGEngine:
    """工厂：按当前配置构造 RAG 引擎；未配置 key 时抛出明确错误。"""
    return RAGEngine(LLMClient())
