"""统一论文数据模型与 Provider 抽象。

三个论文数据源（Semantic Scholar / arXiv / OpenAlex）都输出统一的
``Paper`` 模型，保证上层路由与前端无需感知来源差异。

内部统一 id 格式：``{source}:{external_id}``
例：``semantic_scholar:204e3073870fae3d05bcbc2f6a8e263d9afd97``
例：``arxiv:2103.03404``
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class Paper:
    id: str                      # 内部统一 id（source:external_id）
    title: str
    authors: list[str] = field(default_factory=list)
    year: Optional[int] = None
    abstract: str = ""
    source: str = ""             # semantic_scholar | arxiv | openalex
    external_id: str = ""        # 源内的原始 id
    url: str = ""                # 落地页
    pdf_url: Optional[str] = None
    citation_count: Optional[int] = None
    reference_count: Optional[int] = None
    publication_venue: Optional[str] = None
    doi: Optional[str] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


def make_paper_id(source: str, external_id: str) -> str:
    return f"{source}:{external_id}"


def year_range(year_from: Optional[int], year_to: Optional[int]) -> str:
    """把起止年份格式化为数据源通用的年份区间串。

    - 两者都有：``2017-2020``
    - 只有起始：``2017-``（开放右端）
    - 只有结束：``-2020``（开放左端）
    """
    if year_from is not None and year_to is not None:
        return f"{year_from}-{year_to}"
    if year_from is not None:
        return f"{year_from}-"
    if year_to is not None:
        return f"-{year_to}"
    return ""


@dataclass
class SearchQuery:
    """多字段复合论文搜索条件。

    用于 AI 工具调用与前端高级搜索：可指定标题 / 正文 / 关键词 / 作者 /
    全文 / 年份范围等多个维度，由各数据源转成原生的字段化检索。
    """

    title: str = ""
    abstract: str = ""
    keywords: str = ""
    author: str = ""
    fulltext: str = ""
    year_from: Optional[int] = None
    year_to: Optional[int] = None
    limit: int = 10

    def __post_init__(self) -> None:
        for f in ("title", "abstract", "keywords", "author", "fulltext"):
            v = getattr(self, f)
            setattr(self, f, v.strip() if v else "")

    @property
    def is_empty(self) -> bool:
        """没有任何文本检索维度时为空（仅年份区间不足以构成有效检索）。"""
        return not (
            self.title or self.abstract or self.keywords or self.author or self.fulltext
        )

    def to_query_string(self) -> str:
        """把各字段合并为一条查询字符串（供不支持字段化检索的数据源使用）。"""
        parts = []
        for v in (self.title, self.abstract, self.keywords, self.author, self.fulltext):
            if v:
                parts.append(v)
        return " ".join(parts)


class PaperProvider:
    """论文数据源统一接口。所有子类必须实现以下方法。"""

    source = "base"

    def search(self, query: str, limit: int = 10) -> list[Paper]:
        raise NotImplementedError

    def search_structured(self, q: SearchQuery) -> list[Paper]:
        """按多字段复合条件检索论文。

        各数据源子类应实现原生字段化检索（如 arXiv 的 ti:/abs:/au:、
        OpenAlex 的 filter=title.search:...、Semantic Scholar 的 fielded query）；
        基类默认把各字段合并成一条查询字符串后走 :meth:`search`。
        """
        return self.search(q.to_query_string(), q.limit)

    def get_paper(self, external_id: str) -> Paper:
        raise NotImplementedError

    def get_references(self, external_id: str, limit: int = 100) -> list[Paper]:
        raise NotImplementedError

    def get_citations(self, external_id: str, limit: int = 100) -> list[Paper]:
        raise NotImplementedError

    def get_fulltext(self, paper: Paper) -> Optional[str]:
        """返回论文纯文本全文；无法获取时返回 None。"""
        raise NotImplementedError
