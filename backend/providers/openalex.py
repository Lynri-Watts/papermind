"""OpenAlex 数据源适配器。

- 搜索/详情：https://api.openalex.org/works（免费、无需 key）
- 提供 mailto 进入 polite pool（100 req/s）
- 元数据全面，作为搜索与详情的主备份数据源
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import quote

import requests

from config import HTTP_TIMEOUT
from i18n import tr
import settings_store
from providers.base import Paper, PaperProvider, SearchQuery, make_paper_id, year_range
from providers.download import PdfDownloadError, download_pdf, parse_pdf_to_text

BASE_URL = "https://api.openalex.org"

# OpenAlex 的 filter 用逗号分隔多个条件，值内不允许出现逗号等保留字符
# （即使 URL 编码也会被 400 拒绝）；空格保留以便多词检索。
_FILTER_RESERVED = re.compile(r"[,:;()\[\]{}\"'|&=+?#]")


def _clean_search_value(value: str) -> str:
    """清理放入 ``filter=*.search:`` 的文本值中的保留字符。"""
    value = _FILTER_RESERVED.sub(" ", value)
    return re.sub(r"\s+", " ", value).strip()


def _extract_work_id(openalex_url: str) -> str:
    m = re.search(r"/W\d+$", openalex_url)
    if m:
        return m.group(0)[1:]
    raise ValueError(tr("search.openalex_id_parse_failed", url=openalex_url))


# arXiv 直链 PDF（100% 开放获取，最可靠），优先于出版社/仓储链接
_ARXIV_PDF_RE = re.compile(r"arxiv\.org/pdf/", re.IGNORECASE)


def _pick_pdf_url(work: dict) -> Optional[str]:
    """从 OpenAlex work 里挑选「最可能直接下载成功」的 PDF 链接。

    OpenAlex 的 ``open_access.oa_url`` 只是"最佳开放获取地址"，常指向出版社
    落地页或需要登录/订阅的页面（实测 oup/jamda/ncbi 等会 403 或返回 HTML）。
    因此按以下优先级挑选：
    1. 任一 location 的 arXiv 直链 ``arxiv.org/pdf/...``（最可靠）
    2. ``best_oa_location.pdf_url``
    3. 其它 ``locations[].pdf_url``
    4. 兜底 ``open_access.oa_url``（可能不是 PDF，交给下载层再尝试解析）
    """
    candidates: list[str] = []

    def add(url: Optional[str]) -> None:
        if url and url not in candidates:
            candidates.append(url)

    for loc in work.get("locations") or []:
        add((loc or {}).get("pdf_url"))
    best = work.get("best_oa_location") or {}
    add(best.get("pdf_url"))

    for url in candidates:
        if _ARXIV_PDF_RE.search(url):
            return url
    if best.get("pdf_url"):
        return best["pdf_url"]
    if candidates:
        return candidates[0]
    return (work.get("open_access") or {}).get("oa_url")


class OpenAlexProvider(PaperProvider):
    source = "openalex"

    def __init__(self) -> None:
        self.session = requests.Session()

    def _headers(self) -> dict:
        """礼貌请求标识（mailto）在每次请求时读取，界面改后无需重启即生效。"""
        mailto = settings_store.get(self.source) or "papermind@example.com"
        return {"User-Agent": f"PaperMind/0.1 (mailto:{mailto})"}

    def _params(self, **kw) -> dict:
        params = dict(kw)
        mailto = settings_store.get(self.source)
        if mailto:
            params["mailto"] = mailto
        return params

    # ---------- 内部工具 ----------
    def _get(self, path: str, params: dict) -> dict:
        resp = self.session.get(
            f"{BASE_URL}{path}", params=self._params(**params),
            headers=self._headers(), timeout=HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _to_paper(work: dict) -> Paper:
        work_id = _extract_work_id(work["id"])
        authors = [
            a["author"]["display_name"]
            for a in work.get("authorships", [])
            if a.get("author", {}).get("display_name")
        ]
        loc = work.get("primary_location") or {}
        return Paper(
            id=make_paper_id(OpenAlexProvider.source, work_id),
            title=work.get("display_name") or "",
            authors=authors,
            year=work.get("publication_year"),
            abstract=_extract_abstract(work.get("abstract_inverted_index")),
            source=OpenAlexProvider.source,
            external_id=work_id,
            url=loc.get("landing_page_url") or work.get("id") or "",
            pdf_url=_pick_pdf_url(work),
            citation_count=work.get("cited_by_count"),
            reference_count=len(work.get("referenced_works", [])),
            publication_venue=(loc.get("source") or {}).get("display_name"),
            doi=work.get("doi"),
        )

    # ---------- 公开接口 ----------
    def search(self, query: str, limit: int = 10) -> list[Paper]:
        data = self._get("/works", {
            "search": query,
            "per-page": limit,
        })
        return [self._to_paper(w) for w in data.get("results", [])]

    def search_structured(self, q: SearchQuery) -> list[Paper]:
        """多字段检索：OpenAlex 用 filter 的 ``.search`` 后缀做字段化搜索。

        - 标题 → ``title.search``，正文 → ``abstract.search``，全文 → ``fulltext.search``；
        - 作者 → ``raw_author_name.search``（匹配署名原名）；
        - 年份区间 → ``publication_year:2018-2022``；
        - 关键词 → 走 ``search`` 相关性参数（覆盖标题/摘要/全文）。
        """
        filters: list[str] = []
        if q.title:
            filters.append(f"title.search:{_clean_search_value(q.title)}")
        if q.abstract:
            filters.append(f"abstract.search:{_clean_search_value(q.abstract)}")
        if q.fulltext:
            filters.append(f"fulltext.search:{_clean_search_value(q.fulltext)}")
        if q.author:
            filters.append(f"raw_author_name.search:{_clean_search_value(q.author)}")
        if q.year_from is not None or q.year_to is not None:
            filters.append(f"publication_year:{year_range(q.year_from, q.year_to)}")
        params: dict = {"per-page": q.limit}
        if filters:
            params["filter"] = ",".join(filters)
        if q.keywords:
            params["search"] = q.keywords
        data = self._get("/works", params)
        return [self._to_paper(w) for w in data.get("results", [])]

    def get_paper(self, external_id: str) -> Paper:
        work = self._get(f"/works/{external_id}", {})
        return self._to_paper(work)

    def get_references(self, external_id: str, limit: int = 100) -> list[Paper]:
        """OpenAlex 的 referenced_works 只含 id；批量查询详情。"""
        work = self._get(f"/works/{external_id}", {})
        ref_ids = work.get("referenced_works", [])[:limit]
        if not ref_ids:
            return []
        filters = "|".join(re.sub(r"^https?://openalex.org/", "", r)
                           for r in ref_ids)
        data = self._get("/works", {
            "filter": f"ids.openalex:{filters}",
            "per-page": min(limit, 100),
        })
        return [self._to_paper(w) for w in data.get("results", [])]

    def get_citations(self, external_id: str, limit: int = 100) -> list[Paper]:
        data = self._get("/works", {
            "filter": f"cites:{external_id}",
            "per-page": min(limit, 100),
        })
        return [self._to_paper(w) for w in data.get("results", [])]

    def get_fulltext(self, paper: Paper) -> Optional[str]:
        """OpenAlex 不托管全文；若 oa_url 指向 PDF 则尝试解析。"""
        if paper.pdf_url and paper.pdf_url.lower().endswith(".pdf"):
            try:
                content = download_pdf(paper.pdf_url, session=self.session)
            except PdfDownloadError:
                return None
            if content is not None:
                return parse_pdf_to_text(content)
        return None


def _extract_abstract(inverted_index: Optional[dict]) -> str:
    """OpenAlex 用倒排索引存储摘要，需还原成顺序文本。"""
    if not inverted_index:
        return ""
    pos_map: dict[int, str] = {}
    for word, positions in inverted_index.items():
        for p in positions:
            pos_map[p] = word
    return " ".join(pos_map[i] for i in sorted(pos_map))
