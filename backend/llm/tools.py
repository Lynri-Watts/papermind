"""OpenAI 工具调用（function calling）基础设施。

分层：
- ``BaseTool``：所有工具的基类。子类声明 ``name`` / ``description`` /
  ``parameters``（JSON Schema），并实现 ``execute(arguments, context) -> ToolResult``。
- ``ToolRegistry``：工具注册表。统一管理工具注册、schema 生成与按名执行。
- ``PaperSearchTool``：在学术论文数据库中多字段检索，返回候选论文的标题、摘要
  与**标准论文 id**。
- ``ReadPaperTool``：按**标准论文 id**（``source:external_id`` /
  ``local:<ws>:<path>``）读取单篇论文的全文（PDF，三级缓存）。
- ``ReadDocumentTool``：读取用户当前正在编辑的 LaTeX 文档。

``paper_search`` 与 ``read_paper`` 是**两个互相平行、各自独立**的工具，代码不规定
调用先后：是否调用、先调用哪个由系统提示词按任务需要决策；两者的联动只通过
**标准论文 id** 发生（read_paper 的 id 可来自 paper_search 的返回，也可来自
系统在材料清单中直接给出的论文 id）。read_paper 只处理论文 PDF，不处理网页；
网页材料没有论文 id，不能传入本工具。
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

    在学术论文数据库（Semantic Scholar / arXiv / OpenAlex）中检索，返回匹配
    论文的标题、作者、年份、摘要、引用数与**标准论文 id**。摘要供判断相关性；
    需要全文时凭返回的标准 id 调用与之平行的 ``read_paper`` 工具（是否检索、
    是否续读由系统按任务决定，本工具自身不做任何强制）。
    """

    name = "paper_search"
    description = (
        "在学术论文数据库（Semantic Scholar / arXiv / OpenAlex）中检索论文。"
        "可指定一个或多个维度：标题、摘要正文关键词、作者、论文关键词、全文词、"
        "出版年份范围。返回匹配论文列表，包含标题、作者、年份、摘要、引用数与"
        "每篇论文的标准论文 id（source:external_id 形式）。"
        "适用于：需要确认库中有哪些相关论文，或需要先获得标准论文 id 才能"
        "进一步读取全文的场合。摘要只反映论文概要；若任务需要论文的方法、"
        "数据、公式、结论依据等具体细节，应再凭返回的标准 id 调用 read_paper "
        "读取全文；仅凭摘要不足以覆盖细节问题。"
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
    """按**标准论文 id** 读取论文全文（PDF；三级缓存：DB → 磁盘 PDF → 远程下载）。

    与 ``paper_search`` 互相平行、各自独立：不要求 id 必须来自 paper_search——
    凡是已知的标准论文 id（系统材料清单中给出的，或 paper_search 返回的）都可
    直接读取，是否读取、读取哪几篇由系统按任务需要决定。只处理论文 PDF：
    不接受选材编号（纯数字）与网页材料。
    """

    name = "read_paper"
    description = (
        "读取一篇或多篇**论文**的完整正文（PDF 解析文本，过长时回执截断展示），"
        "用于获取摘要之外的具体细节（方法、实验数据、公式、结论依据等）。"
        "一次最多读取 5 篇。\n"
        "paper_ids 只接受**标准论文 id**，即 source:external_id 形式："
        "arxiv:<arXiv 号>、semantic_scholar:<id>、openalex:W<id>、"
        "local:<工作区>:<相对路径>。id 可从两处获得，二者平行、无先后要求："
        "①系统给出的当前可用材料清单中标注为论文的「论文 id」；"
        "②paper_search 返回结果的 id 字段。\n"
        "以下输入均非法，会被拒绝：材料清单里的方括号选材编号（如 0、9 等"
        "纯数字，它们不是论文 id）；网页地址或网页材料（网页不是论文 PDF，"
        "不在本工具能力范围内）。"
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "paper_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "要读取全文的标准论文 id 列表（source:external_id 或 "
                    "local:<工作区>:<相对路径>）；不接受选材编号等纯数字，"
                    "不接受网页 URL"
                ),
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
            # 纯数字是材料清单的内部选材编号（0=当前论文，其余=上下文库条目），
            # 不是标准论文 id：硬拒绝并给出正确的 id 来源，不做猜测转换
            # （工具层没有编号→标准 id 的映射，臆测映射会读错论文）
            if pid.isdigit():
                failures.append((pid, tr("rag.read_paper_internal_index", pid=pid)))
                continue
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
    """读取用户当前正在编辑的 LaTeX 文档全文。

    文档内容不随提问无条件注入；是否需要读取由系统按任务决定（写作类任务）。
    本工具与论文检索/读取互相独立：它读取的是用户的 LaTeX 文稿，不是论文库材料。
    """

    name = "read_document"
    description = (
        "读取用户当前正在编辑的论文（LaTeX 文档）全文，返回文档当前内容。"
        "适用于需要针对文稿本身的任务（改写、续写、语法/结构检查、把材料插入论文等）。"
        "与论文库无关：不检索也不读取外部论文，无参数；当前没有打开的编辑器时"
        "会明确返回无文档。"
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
