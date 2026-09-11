"""Provider 注册表与聚合入口。

- ``get_provider(source)``：按 id 前缀路由到对应源
- ``aggregated_search`` / ``aggregated_search_structured``：
  - 指定多个来源（或缺省=全部来源）：**并发**查询各源，把结果合并去重后
    轮流交叉输出，保证每个来源都有代表，且每条结果都带着自己的 source。
  - 指定单一来源：只查该源，不做跨源兜底（来源筛选的明确语义）。
  聚合结果还带每个来源的执行状态（ok/empty/error），便于如实告知用户
  "哪个源没返回、为什么"（如 Semantic Scholar 匿名限流 429）。
- 可选 ``sources`` 来源筛选参数：只使用用户指定的数据源（详见 :func:`_resolve_sources`）。
"""
from __future__ import annotations

import contextvars
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Optional

from i18n import tr
from providers.base import Paper, PaperProvider, SearchQuery
from providers.semantic_scholar import SemanticScholarProvider
from providers.arxiv import ArxivProvider
from providers.openalex import OpenAlexProvider
from providers.core import CoreProvider
import settings_store

logger = logging.getLogger(__name__)

# 数据源展示名（后端日志/工具回执复用，与前端展示一致）；
# 目录与展示名的唯一真相在 settings_store.SOURCE_CATALOG
SOURCE_LABELS: dict[str, str] = settings_store.SOURCE_LABELS

_PROVIDERS: dict[str, PaperProvider] = {
    SemanticScholarProvider.source: SemanticScholarProvider(),
    ArxivProvider.source: ArxivProvider(),
    OpenAlexProvider.source: OpenAlexProvider(),
    CoreProvider.source: CoreProvider(),
}


@dataclass
class SourceOutcome:
    """单个数据源的检索结果状态（供 UI/工具如实展示来源命中情况）。"""

    source: str
    status: str          # 'ok' | 'empty' | 'error'
    count: int = 0
    error: str = ""

    def to_dict(self) -> dict:
        data = {"source": self.source, "status": self.status, "count": self.count}
        if self.error:
            data["error"] = self.error
        return data


@dataclass
class AggregateResult:
    """聚合检索结果：论文列表 + 实际使用的来源 + 各来源状态。"""

    papers: list[Paper]
    provider: str                              # 单一来源 id，或 'all'（多源合并）
    outcomes: list[SourceOutcome] = field(default_factory=list)

    def describe_sources(self) -> str:
        """人类可读的来源概要（工具回执/日志用）。"""
        if self.provider != "all":
            return SOURCE_LABELS.get(self.provider, self.provider)
        hits = [
            f"{SOURCE_LABELS.get(o.source, o.source)} {o.count}"
            for o in self.outcomes if o.status == "ok"
        ]
        items = tr("search.source_joiner").join(hits) if hits else tr("search.no_hits")
        return tr("search.sources_all", items=items)


def get_provider(source: str) -> PaperProvider:
    if source not in _PROVIDERS:
        raise ValueError(tr("search.unknown_source", source=source))
    return _PROVIDERS[source]


def _resolve_sources(sources) -> list[str]:
    """规整来源筛选参数为「按当前优先级排列」的检索源列表。

    - 未提供 / 空列表：**当前已启用**的全部数据源（默认聚合行为）；
    - 提供列表：支持逗号分隔串与重复项，去重后保留其**优先级顺序**；
      若其中包含未知来源或已在「设置」中停用的来源，明确报错而非静默忽略。
    返回顺序固定为当前启用优先级列表的子序列，保证多源请求时聚合优先级稳定。
    :raises ValueError: 包含未知数据源，或包含已停用的数据源
    """
    enabled = settings_store.source_priority()
    if sources is None:
        return list(enabled)
    requested: list[str] = []
    for item in sources:
        for part in str(item).split(","):
            requested.append(part.strip().lower())
    requested = [s for s in requested if s]
    if not requested:
        return list(enabled)
    unknown = [s for s in requested if s not in settings_store.SOURCE_IDS]
    if unknown:
        raise ValueError(tr(
            "search.unknown_source_with_options",
            sources=", ".join(sorted(set(unknown))),
            options=", ".join(settings_store.SOURCE_IDS),
        ))
    disabled = [s for s in requested if s not in enabled]
    if disabled:
        raise ValueError(tr(
            "search.source_disabled",
            sources=", ".join(sorted(set(disabled))),
        ))
    # 只保留用户勾选的来源，并按当前优先级排序（去重）
    return [s for s in enabled if s in requested]


def _run_source(search_fn: Callable[[PaperProvider], list[Paper]],
                source: str) -> tuple[SourceOutcome, list[Paper]]:
    """在单个数据源上执行检索，把异常转成 error 状态而不中断整体聚合。"""
    try:
        papers = search_fn(_PROVIDERS[source])
    except Exception as exc:  # 单源失败不影响其它源
        logger.warning("搜索源 %s 失败: %s", source, exc)
        return SourceOutcome(source, "error", 0, str(exc)), []
    if not papers:
        logger.info("搜索源 %s 无匹配结果", source)
        return SourceOutcome(source, "empty"), []
    return SourceOutcome(source, "ok", len(papers)), papers


_DOI_PREFIX_RE = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", re.IGNORECASE)


def _normalize_doi(doi: str) -> str:
    """归一化 DOI：各源写法不同（Semantic Scholar/CORE 给裸 DOI，
    OpenAlex 给 ``https://doi.org/10.x``），不归一化会导致同一篇论文重复出现。"""
    return _DOI_PREFIX_RE.sub("", (doi or "").strip()).lower()


def _dedupe_key(paper: Paper) -> str:
    """去重键：优先归一化 DOI，其次归一化标题（去标点/大小写）。"""
    doi = _normalize_doi(paper.doi or "")
    if doi:
        return "doi:" + doi
    return "title:" + re.sub(r"[^a-z0-9]+", "", (paper.title or "").lower())


def _merge_papers(per_source: dict[str, list[Paper]], order: list[str],
                  limit: int) -> list[Paper]:
    """多源结果合并去重，并按来源交叉（round-robin）输出。

    交叉而非"先按优先级串接"是为了让「全部来源」时各源都有代表，避免
    高优先级源单独占满整个列表、用户误以为只有某一个源可用。
    去重时保留优先级更高来源的副本（先入先得）。
    """
    seen: set[str] = set()
    merged: list[Paper] = []
    cursor = {src: 0 for src in order}
    while len(merged) < limit:
        progressed = False
        for src in order:
            papers = per_source[src]
            i = cursor[src]
            while i < len(papers):
                paper = papers[i]
                i += 1
                key = _dedupe_key(paper)
                if key and key in seen:
                    continue
                seen.add(key)
                merged.append(paper)
                progressed = True
                break
            cursor[src] = i
            if len(merged) >= limit:
                break
        if not progressed:
            break
    return merged


def _aggregate(search_fn: Callable[[PaperProvider], list[Paper]],
               sources=None, limit: Optional[int] = None) -> AggregateResult:
    """跨数据源聚合检索。

    - 单一来源：只查该源；该源出错时抛出 RuntimeError（不做跨源兜底）。
    - 多来源（含缺省全部）：并发查询所有来源，合并去重后交叉输出；
      部分来源出错不影响整体，但会在 outcomes 中如实标注；全部出错则抛错。

    :param sources: 来源筛选（None=全部来源；否则取其中按优先级排列的子集）
    :param limit: 结果条数上限（合并后截断）；None 表示不截断
    :raises ValueError: sources 含未知数据源
    :raises RuntimeError: 单源检索失败，或所有来源均失败
    """
    order = _resolve_sources(sources)
    if len(order) == 1:
        outcome, papers = _run_source(search_fn, order[0])
        if outcome.status == "error":
            raise RuntimeError(tr(
                "search.source_failed", source=order[0], error=outcome.error,
            ))
        return AggregateResult(papers[:limit] if limit else papers, order[0], [outcome])

    with ThreadPoolExecutor(max_workers=len(order)) as pool:
        # 各 provider 的报错在工作线程里调用 tr()；Flask 的请求上下文基于
        # contextvars，默认不传播到工作线程，故每个 submit 各自复制一次上下文。
        futures = {
            src: pool.submit(
                contextvars.copy_context().run, _run_source, search_fn, src,
            )
            for src in order
        }
        results = {src: futures[src].result() for src in order}

    outcomes = [results[src][0] for src in order]
    if all(o.status == "error" for o in outcomes):
        detail = "; ".join(f"{o.source}: {o.error}" for o in outcomes)
        raise RuntimeError(tr("search.all_sources_failed", detail=detail))
    per_source = {src: results[src][1] for src in order}
    if limit:
        papers = _merge_papers(per_source, order, limit)
    else:
        papers = [p for src in order for p in per_source[src]]
    return AggregateResult(papers, "all", outcomes)


def aggregated_search(query: str, limit: int = 10, sources=None) -> AggregateResult:
    """多源关键词搜索。

    :param sources: 来源筛选（None=全部数据源；列表=仅使用指定来源）
    """
    return _aggregate(lambda p: p.search(query, limit), sources, limit)


def aggregated_search_structured(q: SearchQuery, sources=None) -> AggregateResult:
    """多源结构化检索。

    :param sources: 来源筛选（None=全部数据源；列表=仅使用指定来源）
    """
    return _aggregate(lambda p: p.search_structured(q), sources, q.limit)
