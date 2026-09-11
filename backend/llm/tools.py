"""OpenAI 工具调用（function calling）基础设施。

分层：
- ``BaseTool``：所有工具的基类。子类声明 ``name`` / ``description`` /
  ``parameters``（JSON Schema），并实现 ``execute(arguments, context) -> ToolResult``。
- ``ToolRegistry``：工具注册表。统一管理工具注册、schema 生成与按名执行。
- ``PaperSearchTool``：多字段结构化论文搜索（与图形界面 /api/search 共用同一服务）。
  返回候选论文及其摘要，是工具链的第一步"获取摘要与筛选依据"。
- ``ReadPaperTool``：按论文 id 读取全文（三级缓存）。是工具链的第二步"获取具体
  内容"：LLM 依据 paper_search 返回的摘要判断哪些论文与问题相关后，再调用本工具
  读取这些论文的全文来深入回答。
- ``ReadDocumentTool``：读取用户当前正在编辑的 LaTeX 文档。写作场景由 LLM
  根据用户问题主动请求读取，而非每次无条件注入。

工具链的先后顺序由 LLM 自主编排（通过工具描述与 RAG 提示词引导），代码不做强制；
任何一步都可被用户逐工具确认。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import storage.db as db
from i18n import tr
from providers import SOURCE_LABELS
from providers.base import SearchQuery
from services.fulltext import get_paper_fulltext_checked
from services.search import search_papers_structured


@dataclass
class ToolResult:
    """工具执行结果。``content`` 将作为 tool 角色的消息内容回传给 LLM。"""

    content: str
    data: Optional[dict] = None


class BaseTool:
    """工具基类：子类只需声明元数据并实现 :meth:`execute`。"""

    name: str = ""
    description: str = ""
    parameters: dict = {}

    def schema(self) -> dict:
        """生成 OpenAI tools 数组项（function 类型）。"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        """执行工具。

        :param arguments: LLM 填写的工具参数
        :param context: 执行期上下文（如当前会话携带的 document/选中论文），可为 None
        """
        raise NotImplementedError


class ToolRegistry:
    """工具注册表：统一管理工具注册、schema 生成与按名执行。"""

    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        if not tool.name:
            raise ValueError(tr("rag.tool_missing_name"))
        if tool.name in self._tools:
            raise ValueError(tr("rag.tool_duplicate", name=tool.name))
        self._tools[tool.name] = tool

    def unregister(self, name: str) -> None:
        self._tools.pop(name, None)

    def get(self, name: str) -> BaseTool:
        return self._tools[name]

    def schemas(self) -> list[dict]:
        """返回已注册全部工具的 OpenAI schema 数组。"""
        return [t.schema() for t in self._tools.values()]

    def execute(self, name: str, arguments: dict,
                context: Optional[dict] = None) -> ToolResult:
        if name not in self._tools:
            raise KeyError(tr("rag.tool_unknown", name=name))
        return self._tools[name].execute(arguments, context)


class PaperSearchTool(BaseTool):
    """候选文献检索工具：多字段结构化论文搜索。

    LLM 根据用户意图，在 title / abstract / keywords / author / fulltext /
    year_from / year_to 中挑选字段生成参数；系统跨数据源检索，把论文列表
    （含摘要）以 tool 角色返回给 LLM。这是工具链的**第一步**：返回摘要候选，
    供 LLM 依据摘要判断哪些论文与问题相关，随后调用 ``read_paper`` 读取全文。
    """

    name = "paper_search"
    description = (
        "在学术论文数据库（Semantic Scholar / arXiv / OpenAlex）中检索论文。"
        "可指定用户提到的任意一个或多个维度：标题、摘要正文关键词、作者、"
        "论文关键词、全文词、出版年份范围。返回匹配论文列表，包含标题、作者、"
        "年份、摘要、引用数与论文 id。\n"
        "使用方式：这是文献补充工作流的**第一步**——先调用本工具获取候选论文"
        "及其摘要，依据摘要判断哪些论文与问题直接相关后，再调用 read_paper "
        "读取这些论文的全文用于深入回答；若摘要已足够回答则可直接作答。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "论文标题中应出现的关键词"},
            "abstract": {
                "type": "string",
                "description": "论文摘要（正文简介）中应出现的关键词",
            },
            "keywords": {"type": "string", "description": "论文自带关键词（tags）"},
            "author": {"type": "string", "description": "作者姓名"},
            "fulltext": {
                "type": "string",
                "description": "在论文全文任意位置出现的词（OpenAlex 支持全文检索）",
            },
            "year_from": {
                "type": "integer",
                "description": "出版年份下界（含），如 2017",
            },
            "year_to": {
                "type": "integer",
                "description": "出版年份上界（含），如 2020",
            },
            "limit": {
                "type": "integer",
                "description": "最多返回篇数",
                "minimum": 1,
                "maximum": 20,
                "default": 10,
            },
        },
        "additionalProperties": False,
    }

    def __init__(self) -> None:
        # 与图形界面 /api/search 共用同一搜索服务（聚合检索 + 本地缓存回填）
        self._search = search_papers_structured

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        q = SearchQuery(
            title=arguments.get("title", ""),
            abstract=arguments.get("abstract", ""),
            keywords=arguments.get("keywords", ""),
            author=arguments.get("author", ""),
            fulltext=arguments.get("fulltext", ""),
            year_from=arguments.get("year_from"),
            year_to=arguments.get("year_to"),
            limit=int(arguments.get("limit", 10)),
        )
        if q.is_empty:
            return ToolResult(tr("rag.search_no_criteria"))
        try:
            result = self._search(q)
        except Exception as exc:
            return ToolResult(tr("rag.search_failed", exc=exc))
        papers = result.papers
        if not papers:
            return ToolResult(tr("rag.search_no_results"))

        lines = [tr("rag.search_found", n=len(papers), sources=result.describe_sources())]
        # 未返回结果的来源如实说明（如 Semantic Scholar 匿名限流 429），避免"只见某一个源"的困惑
        skipped = [o for o in result.outcomes if o.status != "ok"]
        if skipped and result.provider == "all":
            detail = "、".join(
                f"{SOURCE_LABELS.get(o.source, o.source)}：{o.error or tr('rag.source_no_match')}"
                for o in skipped
            )
            lines.append(tr("rag.search_skipped_sources", detail=detail))
        for i, p in enumerate(papers, 1):
            authors = ", ".join(p.authors[:3])
            if len(p.authors) > 3:
                authors += " et al."
            abstract = (p.abstract or "").strip()
            if len(abstract) > 300:
                abstract = abstract[:297] + "..."
            lines.append(
                f"{i}. {p.title}（{p.year}）\n"
                f"   {tr('rag.label_authors')}: {authors or tr('rag.value_unknown')}\n"
                f"   {tr('rag.label_source')}: {SOURCE_LABELS.get(p.source, p.source)}\n"
                f"   {tr('rag.label_citations')}: {p.citation_count or 0} | "
                f"{tr('rag.label_id')}: {p.id}\n"
                f"   {tr('rag.label_abstract')}: {abstract or tr('rag.value_no_abstract')}"
            )
        data = {
            "provider": result.provider,
            "sources": [o.to_dict() for o in result.outcomes],
            # 与 /api/search 返回完全一致的字段（Paper.to_dict()）
            "papers": [p.to_dict() for p in papers],
        }
        return ToolResult("\n".join(lines), data)


class ReadPaperTool(BaseTool):
    """按论文 id 读取全文（三级缓存：DB → 磁盘 PDF → 远程下载）。

    这是文献补充工作流的**第二步**：在 paper_search 返回候选论文与摘要后，
    LLM 依据摘要筛选出与问题直接相关的论文，调用本工具读取这些论文的全文
    用于深入回答。读取的全文会作为出处分块参与最终回答（经 /answer）。
    """

    name = "read_paper"
    description = (
        "按论文 id 读取其全文内容，用于深入回答需要具体细节的问题。"
        "这是文献补充工作流的**第二步**：调用前应先通过 paper_search 获取候选"
        "论文列表及其摘要，依据摘要判断哪些论文与问题直接相关后，从候选的 id 中"
        "挑选相关论文传入 paper_ids。一次最多读取 5 篇。"
        "返回每篇论文的全文（过长时截断展示）。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "paper_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要读取全文的论文 id 列表（必须取自 paper_search 返回结果的 id 字段）",
            },
        },
        "required": ["paper_ids"],
        "additionalProperties": False,
    }

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        raw_ids = arguments.get("paper_ids") or []
        if not isinstance(raw_ids, list) or not raw_ids:
            return ToolResult(tr("rag.read_paper_no_ids"))
        ids = [str(i).strip() for i in raw_ids[:5] if str(i).strip()]

        loaded: list[dict] = []
        # 逐篇记录失败原因（未开放 PDF / 403 / 404 / 解析失败 / 扫描版等），
        # 精确反馈给 LLM 与用户，LLM 可据此换读其它论文或如实告知局限
        failures: list[tuple[str, str]] = []
        for pid in ids:
            text, reason = get_paper_fulltext_checked(pid)
            if not text:
                failures.append((pid, reason or tr("rag.read_paper_unknown_reason")))
                continue
            meta = db.get_paper(pid) or {}
            loaded.append({
                "id": pid,
                "title": meta.get("title") or pid,
                "text": text,
            })

        if not loaded:
            lines = [tr("rag.read_paper_failed_header")]
            lines += [f"- {pid}：{reason}" for pid, reason in failures]
            return ToolResult("\n".join(lines))

        lines = [tr("rag.read_paper_loaded_header", n=len(loaded))]
        for p in loaded:
            preview = p["text"].replace("\n", " ")[:300]
            lines.append(
                f"- {p['title']}（id: {p['id']}）\n"
                f"  {tr('rag.read_paper_preview_label')}: {preview}…"
            )
        if failures:
            lines.append(tr("rag.read_paper_extra_failed", n=len(failures)))
            lines += [f"- {pid}：{reason}" for pid, reason in failures]
        data = {
            # 前端展示用（不携带全文，避免大体积传输）
            "papers": [{"id": p["id"], "title": p["title"]} for p in loaded],
            # /answer 回答依据：完整全文（存会话，供 prepare_answer 检索）
            "fulltexts": [{"id": p["id"], "title": p["title"], "text": p["text"]} for p in loaded],
        }
        return ToolResult("\n".join(lines), data)


class ReadDocumentTool(BaseTool):
    """读取用户当前正在编辑的 LaTeX 文档（写作场景专用）。

    与 paper_search 不同，本文档内容不会随提问无条件注入；只有当用户问题
    涉及写作任务（改写 / 续写 / 检查语法 / 整理结构 / 把材料插入论文）时，
    LLM 才会调用本工具主动请求读取，再由用户确认后执行。执行结果经 /answer
    作为"当前文档"来源参与检索与回答。
    """

    name = "read_document"
    description = (
        "读取用户当前正在编辑的论文（LaTeX 文档）全文。当用户问题涉及写作任务——"
        "如改写某段、续写、检查语法或结构、把上下文内容插入论文——时调用本工具"
        "获取文档当前内容，以便针对文档本身作答。与论文检索无关。"
    )
    parameters: dict = {"type": "object", "properties": {}, "additionalProperties": False}

    def execute(self, arguments: dict, context: Optional[dict] = None) -> ToolResult:
        document = ((context or {}).get("document") or "").strip()
        if not document:
            return ToolResult(tr("rag.read_document_empty"))
        # 截断避免 tool 消息过长（完整内容仍存于 data，供 /answer 检索使用）
        preview = document if len(document) <= 6000 else document[:6000] + "\n" + tr("rag.read_document_truncated")
        return ToolResult(
            tr("rag.read_document_loaded", n=len(document)) + f"\n\n{preview}",
            {"document": document},
        )


# 默认注册表：可被上层直接复用，也可另行构造并注册自定义工具
_default_registry = ToolRegistry()
_default_registry.register(PaperSearchTool())
_default_registry.register(ReadPaperTool())
_default_registry.register(ReadDocumentTool())


def default_registry() -> ToolRegistry:
    """返回内置工具的注册表（含论文搜索、全文读取与文档读取工具）。"""
    return _default_registry
