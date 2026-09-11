"""论文检索服务：统一「AI 工具调用」与「图形界面 /api/search」两条搜索路径。

两条路径共享同一套实现——参数构造 → 跨数据源聚合检索 → 本地缓存回填 →
统一序列化，保证无论用户从 UI 搜索，还是让 AI 通过工具搜索，得到的结果、
行为与后续可用性（按 id 取论文/全文）完全一致。
"""
from __future__ import annotations

import logging

import storage.db as db
from i18n import tr
from providers import AggregateResult, aggregated_search, aggregated_search_structured
from providers.base import Paper, SearchQuery

logger = logging.getLogger(__name__)


def search_papers_structured(q: SearchQuery, sources=None) -> AggregateResult:
    """多字段结构化检索：跨数据源搜索并把结果回填本地缓存。

    :param q: 结构化检索条件（title/abstract/keywords/author/fulltext/年份）
    :param sources: 来源筛选（None=全部数据源；列表=仅使用指定来源）
    :returns: 聚合结果（论文列表 + 实际来源 + 各来源状态）
    """
    # 调试输出：搜索器收到的参数块（AI 工具与 UI 高级搜索共用此入口）
    print(
        "[搜索] 结构化检索参数块: "
        + str({
            "title": q.title,
            "abstract": q.abstract,
            "keywords": q.keywords,
            "author": q.author,
            "fulltext": q.fulltext,
            "year_from": q.year_from,
            "year_to": q.year_to,
            "limit": q.limit,
            "sources": sources,
        })
    )
    if q.is_empty:
        raise ValueError(tr("search.empty_structured_query"))
    result = aggregated_search_structured(q, sources)
    _cache_papers(result.papers)
    return result


def search_papers_keyword(query: str, limit: int = 10, sources=None) -> AggregateResult:
    """关键词搜索（UI 快速搜索），同样回填本地缓存。

    :param sources: 来源筛选（None=全部数据源；列表=仅使用指定来源）
    :returns: 聚合结果（论文列表 + 实际来源 + 各来源状态）
    """
    # 调试输出：搜索器收到的参数块（UI 关键词搜索/工具快捷路径共用此入口）
    print(f"[搜索] 关键词检索参数块: query={query!r}, limit={limit}, sources={sources}")
    if not query.strip():
        raise ValueError(tr("search.missing_keyword"))
    result = aggregated_search(query, limit, sources)
    _cache_papers(result.papers)
    return result


def _cache_papers(papers: list[Paper]) -> None:
    """把搜索结果回填本地缓存，避免后续按 id 取论文/全文时重复网络请求。"""
    for p in papers:
        try:
            db.upsert_paper(
                paper_id=p.id, title=p.title, authors=p.authors, year=p.year,
                abstract=p.abstract, source=p.source, external_id=p.external_id,
                url=p.url, pdf_url=p.pdf_url, doi=p.doi,
                citation_count=p.citation_count,
            )
        except Exception as exc:  # 缓存回填失败不应阻断搜索返回
            logger.warning("回填论文缓存失败 %s: %s", p.id, exc)
