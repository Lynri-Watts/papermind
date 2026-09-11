"""Semantic Scholar Graph API v1 数据源适配器。

- 搜索：/graph/v1/paper/search
- 详情：/graph/v1/paper/{paper_id}
- 引用/被引：/graph/v1/paper/{paper_id}/references|citations
- 可选 x-api-key 提升限流（匿名时共享池）

引用数据最全（2.49B 引用），作为搜索与引用追踪的主数据源。
"""
from __future__ import annotations

import time
from typing import Optional

import requests

import settings_store
from config import HTTP_TIMEOUT
from i18n import tr
from providers.base import Paper, PaperProvider, SearchQuery, make_paper_id, year_range
from providers.download import PdfDownloadError, download_pdf, parse_pdf_to_text

BASE_URL = "https://api.semanticscholar.org/graph/v1"

# 统一需要的字段
FIELDS = (
    "paperId,title,authors,year,abstract,externalIds,url,"
    "openAccessPdf,citationCount,referenceCount,venue"
)


class SemanticScholarProvider(PaperProvider):
    source = "semantic_scholar"

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "PaperMind/0.1"})

    # ---------- 内部工具 ----------
    def _get(self, path: str, params: dict) -> dict:
        """GET 请求；遇 429 限流时退避重试一次。

        API key 在**每次请求时**从 settings_store 读取，因此用户在「设置」
        中填写/更换 key 后无需重启服务即生效。
        """
        headers: dict[str, str] = {}
        api_key = settings_store.get(self.source)
        if api_key:
            headers["x-api-key"] = api_key
        for attempt in range(2):
            resp = self.session.get(
                f"{BASE_URL}{path}", params=params, headers=headers,
                timeout=HTTP_TIMEOUT,
            )
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", "5"))
                time.sleep(min(retry_after, 10))
                continue
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError(tr("search.semantic_scholar_rate_limited"))

    @staticmethod
    def _extract_arxiv_id(entry: dict) -> Optional[str]:
        ext = entry.get("externalIds") or {}
        return ext.get("ArXiv")

    @classmethod
    def _to_paper(cls, entry: dict) -> Paper:
        paper_id = entry["paperId"]
        authors = [a["name"] for a in (entry.get("authors") or [])]
        arxiv_id = cls._extract_arxiv_id(entry)
        oa = entry.get("openAccessPdf") or {}
        # pdf 优先使用 arXiv（100% OA），否则用 openAccessPdf
        pdf_url = (
            f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else oa.get("url")
        )
        return Paper(
            id=make_paper_id(cls.source, paper_id),
            title=entry.get("title") or "",
            authors=authors,
            year=entry.get("year"),
            abstract=entry.get("abstract") or "",
            source=cls.source,
            external_id=paper_id,
            url=entry.get("url") or "",
            pdf_url=pdf_url,
            citation_count=entry.get("citationCount"),
            reference_count=entry.get("referenceCount"),
            publication_venue=entry.get("venue"),
            doi=(entry.get("externalIds") or {}).get("DOI"),
        )

    # ---------- 公开接口 ----------
    def search(self, query: str, limit: int = 10) -> list[Paper]:
        data = self._get("/paper/search", {
            "query": query,
            "limit": limit,
            "fields": FIELDS,
        })
        return [self._to_paper(e) for e in data.get("data", [])]

    def search_structured(self, q: SearchQuery) -> list[Paper]:
        """多字段检索：Semantic Scholar 支持 fielded query 与原生 year 区间。

        - 标题/正文/作者等各自以 ``字段:"短语"`` 形式限定到对应字段；
        - 关键词 / 全文词直接作为相关性查询词加入；
        - 年份区间用原生 ``year`` 参数过滤（如 ``2017-2020``）。
        """
        terms: list[str] = []
        if q.title:
            terms.append(f'title:"{q.title}"')
        if q.abstract:
            terms.append(f'abstract:"{q.abstract}"')
        if q.author:
            terms.append(f'author:"{q.author}"')
        if q.keywords:
            terms.append(q.keywords)
        if q.fulltext:
            terms.append(q.fulltext)
        query = " ".join(terms) if terms else q.to_query_string()
        params: dict = {"query": query, "limit": q.limit, "fields": FIELDS}
        if q.year_from is not None or q.year_to is not None:
            params["year"] = year_range(q.year_from, q.year_to)
        data = self._get("/paper/search", params)
        return [self._to_paper(e) for e in data.get("data", [])]

    def get_paper(self, external_id: str) -> Paper:
        data = self._get(f"/paper/{external_id}", {"fields": FIELDS})
        return self._to_paper(data)

    def get_references(self, external_id: str, limit: int = 100) -> list[Paper]:
        data = self._get(f"/paper/{external_id}/references", {
            "fields": FIELDS,
            "limit": limit,
        })
        return [self._to_paper(d["citedPaper"]) for d in data.get("data", [])]

    def get_citations(self, external_id: str, limit: int = 100) -> list[Paper]:
        data = self._get(f"/paper/{external_id}/citations", {
            "fields": FIELDS,
            "limit": limit,
        })
        return [self._to_paper(d["citingPaper"]) for d in data.get("data", [])]

    def get_fulltext(self, paper: Paper) -> Optional[str]:
        """SS 本身不提供全文；若非空则尝试从 arXiv / openAccessPdf 下载。
        使用统一下载工具（带 UA + 连接级重试），获取不到返回 None。"""
        if paper.pdf_url:
            try:
                content = download_pdf(paper.pdf_url, session=self.session)
            except PdfDownloadError:
                # 无 PDF / 403 / 网络失败：此处保持 None 语义，由上层 fulltext 服务给出原因
                return None
            if content is not None:
                return parse_pdf_to_text(content)
        return None
