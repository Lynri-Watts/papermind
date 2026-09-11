"""CORE API v3 数据源适配器。

- 搜索：``GET https://api.core.ac.uk/v3/search/works?q=...&limit=...``
- 详情：``GET https://api.core.ac.uk/v3/works/{id}``
- 鉴权：``Authorization: Bearer <CORE_API_KEY>``（**可选**——匿名也可用，但限流更严，
  约 5 次请求/10 秒；填 key 后限流放宽）
- 全文：响应中的 ``downloadUrl`` 即 CORE 托管的开放获取 PDF 直链，下载成功率高

CORE 聚合全球开放获取仓储，覆盖大量 Semantic Scholar / OpenAlex 未收录的
机构仓储全文，作为"能否拿到全文"的补充来源。

注意：CORE 不提供结构化引用数据——``references`` 字段实测恒为空且没有
引用/被引子端点，故 :meth:`CoreProvider.get_references` /
:meth:`CoreProvider.get_citations` 如实返回空列表（引用追踪由 Semantic Scholar 负责）。
"""
from __future__ import annotations

import time
from typing import Optional

import requests

import settings_store
from config import HTTP_TIMEOUT
from i18n import tr
from providers.base import Paper, PaperProvider, SearchQuery, make_paper_id
from providers.download import PdfDownloadError, download_pdf, parse_pdf_to_text

BASE_URL = "https://api.core.ac.uk/v3"


def _quote_value(value: str) -> str:
    """把值包成 CORE 查询语言的短语（去掉值内引号以免破坏表达式）。"""
    cleaned = value.replace('"', " ").strip()
    return f'"{cleaned}"'


def _landing_url(work: dict, work_id: str) -> str:
    """落地页：优先 CORE 的 display 链接，其次在线阅读器，最后按 id 构造。"""
    by_type: dict[str, str] = {}
    for link in work.get("links") or []:
        if isinstance(link, dict) and link.get("url"):
            by_type.setdefault(link.get("type") or "", link["url"])
    return (
        by_type.get("display")
        or by_type.get("reader")
        or f"https://core.ac.uk/works/{work_id}"
    )


def _venue(work: dict) -> Optional[str]:
    """出版方信息：CORE 的 journals[].title 常为 null，publisher 更可靠。"""
    if work.get("publisher"):
        return work["publisher"]
    for journal in work.get("journals") or []:
        if isinstance(journal, dict) and journal.get("title"):
            return journal["title"]
    return None


class CoreProvider(PaperProvider):
    source = "core"

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "PaperMind/0.1"})

    # ---------- 内部工具 ----------
    def _auth_headers(self) -> dict:
        """每次请求时读取 key，使界面配置无需重启即生效。"""
        api_key = settings_store.get(self.source)
        return {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _auth_error(self, status: int) -> str:
        if settings_store.get(self.source):
            return tr("search.core_auth_failed", status=status)
        return tr("search.core_anonymous_rejected")

    def _get(self, path: str, params: dict) -> dict:
        """GET 请求；遇 429 限流退避重试一次，鉴权失败给出可操作的原因。"""
        headers = self._auth_headers()
        for _ in range(2):
            resp = self.session.get(
                f"{BASE_URL}{path}", params=params, headers=headers,
                timeout=HTTP_TIMEOUT,
            )
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", "5"))
                time.sleep(min(retry_after, 10))
                continue
            if resp.status_code in (401, 403):
                raise RuntimeError(self._auth_error(resp.status_code))
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError(tr("search.core_rate_limited"))

    @classmethod
    def _to_paper(cls, work: dict) -> Paper:
        work_id = str(work.get("id"))
        authors = [
            a["name"] for a in (work.get("authors") or [])
            if isinstance(a, dict) and a.get("name")
        ]
        return Paper(
            id=make_paper_id(cls.source, work_id),
            title=(work.get("title") or "").strip(),
            authors=authors,
            year=work.get("yearPublished"),
            abstract=work.get("abstract") or "",
            source=cls.source,
            external_id=work_id,
            url=_landing_url(work, work_id),
            pdf_url=work.get("downloadUrl"),
            citation_count=work.get("citationCount"),
            publication_venue=_venue(work),
            doi=work.get("doi"),
        )

    # ---------- 公开接口 ----------
    def search(self, query: str, limit: int = 10) -> list[Paper]:
        data = self._get("/search/works", {"q": query, "limit": limit})
        return [self._to_paper(w) for w in data.get("results", [])]

    def search_structured(self, q: SearchQuery) -> list[Paper]:
        """多字段检索：使用 CORE 原生查询语言（Lucene 风格）。

        - 标题 → ``title:``，摘要 → ``abstract:``，作者 → ``authors:``，全文 → ``fullText:``
          （多词值一律用引号包成短语，未加引号时 CORE 会按"任一或全部词"松散匹配）；
        - 关键词 → 直接作为相关性查询词（跨字段匹配）；
        - 年份区间 → ``yearPublished>="2020" AND yearPublished<="2024"``。
          注意不能用文档里的 ``yearPublished:[2020 TO 2024]`` 区间写法——实测该写法
          直接 500，而带引号的 ``>=`` / ``<=`` 比较式可用。
        """
        clauses: list[str] = []
        if q.title:
            clauses.append(f"title:{_quote_value(q.title)}")
        if q.abstract:
            clauses.append(f"abstract:{_quote_value(q.abstract)}")
        if q.author:
            clauses.append(f"authors:{_quote_value(q.author)}")
        if q.fulltext:
            clauses.append(f"fullText:{_quote_value(q.fulltext)}")
        if q.keywords:
            clauses.append(q.keywords)
        if q.year_from is not None:
            clauses.append(f'yearPublished>="{q.year_from}"')
        if q.year_to is not None:
            clauses.append(f'yearPublished<="{q.year_to}"')
        if not clauses:
            return []
        data = self._get("/search/works", {
            "q": " AND ".join(clauses),
            "limit": q.limit,
        })
        return [self._to_paper(w) for w in data.get("results", [])]

    def get_paper(self, external_id: str) -> Paper:
        return self._to_paper(self._get(f"/works/{external_id}", {}))

    def get_references(self, external_id: str, limit: int = 100) -> list[Paper]:
        # CORE 的 references 字段实测恒为空，且无引用子端点，如实返回空
        return []

    def get_citations(self, external_id: str, limit: int = 100) -> list[Paper]:
        # CORE 不提供被引数据
        return []

    def get_fulltext(self, paper: Paper) -> Optional[str]:
        """下载 CORE 托管的开放获取 PDF 并解析纯文本。"""
        if not paper.pdf_url:
            return None
        try:
            content = download_pdf(paper.pdf_url, session=self.session)
        except PdfDownloadError:
            return None
        if content is None:
            return None
        return parse_pdf_to_text(content)
