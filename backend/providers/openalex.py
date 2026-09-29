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
from providers.download import (
    PdfDownloadError,
    download_pdf_first_available,
    parse_pdf_to_text,
)

BASE_URL = "https://api.openalex.org"

# OpenAlex 的 filter 用逗号分隔多个条件，值内不允许有逗号等保留字符
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

# PMC / EuropePMC 落地页中的 PMCID（OpenAlex 对这类 location 通常不提供
# pdf_url，只有落地页；EBI EuropePMC 提供机器人友好的全文 PDF REST 端点）。
# 注意 PMC 老格式 URL 用纯数字 /articles/3374500，新格式为 /articles/PMC3374500，
# 两种都要识别并统一归一化为 PMCID（PMC + 数字）
_PMC_LANDING_RES = (
    re.compile(r"(?:www\.ncbi|pmc\.ncbi)\.nlm\.nih\.gov/pmc/articles/(?:PMC)?(\d+)", re.I),
    re.compile(r"europepmc\.org/articles/(?:PMC)?(\d+)", re.I),
)
_EBI_PMC_PDF_TMPL = (
    "https://www.ebi.ac.uk/europepmc/webservices/rest/articles/{pmcid}/fullTextPDF"
)


def _pdf_candidates(work: dict) -> list[str]:
    """从 OpenAlex work 的全部 locations 构造有序的全文候选地址列表。

    ``open_access.oa_url`` 只是"最佳开放获取地址"，常指向被反爬墙拦截的出版
    社 PDF（实测 IOP 经 Radware 返回人机验证页 HTML），而同一 work 的其它
    location（arXiv 直链 / PMC 仓储）其实可用。单取首选 URL 会把"首选镜像
    不可达"误判为"论文不可下载"，因此返回完整候选链，由下载层逐个尝试：

    1. arXiv 直链 PDF（最可靠，100% OA）
    2. best_oa_location.pdf_url 及其它 location 的 pdf_url（best 优先）
    3. PMC location 合成的 EBI EuropePMC 全文 PDF 端点
    4. 各仓储/出版社落地页本身（下载层会解析其中的 citation_pdf_url）
    5. 兜底 open_access.oa_url
    """
    def _dedupe_append(seq: list[str], url: Optional[str]) -> None:
        url = (url or "").strip()
        if url and url not in seq:
            seq.append(url)

    arxiv_urls: list[str] = []
    direct_pdfs: list[str] = []
    landings: list[str] = []

    best = work.get("best_oa_location") or {}
    # best_oa 直链置顶（locations 列表里通常也含它，去重保证不重复）
    _dedupe_append(direct_pdfs, best.get("pdf_url"))
    for loc in work.get("locations") or []:
        loc = loc or {}
        pu = loc.get("pdf_url")
        if pu:
            if _ARXIV_PDF_RE.search(pu):
                _dedupe_append(arxiv_urls, pu)
            _dedupe_append(direct_pdfs, pu)
        _dedupe_append(landings, loc.get("landing_page_url"))

    candidates: list[str] = []
    for url in arxiv_urls:
        _dedupe_append(candidates, url)
    for url in direct_pdfs:
        _dedupe_append(candidates, url)

    pmcids: list[str] = []
    for lp in landings:
        for pattern in _PMC_LANDING_RES:
            m = pattern.search(lp)
            if m:
                # 捕获组是纯数字（URL 里 PMC 前缀可有可无），统一补全为 PMCID
                _dedupe_append(pmcids, "PMC" + m.group(1))
    for pmcid in pmcids:
        _dedupe_append(candidates, _EBI_PMC_PDF_TMPL.format(pmcid=pmcid))
    for lp in landings:
        _dedupe_append(candidates, lp)
    _dedupe_append(candidates, (work.get("open_access") or {}).get("oa_url"))
    return candidates


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
        candidates = _pdf_candidates(work)
        return Paper(
            id=make_paper_id(OpenAlexProvider.source, work_id),
            title=work.get("display_name") or "",
            authors=authors,
            year=work.get("publication_year"),
            abstract=_extract_abstract(work.get("abstract_inverted_index")),
            source=OpenAlexProvider.source,
            external_id=work_id,
            url=loc.get("landing_page_url") or work.get("id") or "",
            pdf_url=candidates[0] if candidates else None,
            pdf_candidates=candidates,
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
        """OpenAlex 不托管全文；按 locations 候选链尝试各开放获取镜像。

        旧实现只在 pdf_url 以 ``.pdf`` 结尾时才下载，既漏掉无扩展名的直链
        （如 arXiv），也只试首选镜像；现统一走多镜像下载器。
        """
        urls = paper.pdf_candidates or ([paper.pdf_url] if paper.pdf_url else [])
        if not urls:
            return None
        try:
            content, _used = download_pdf_first_available(
                urls, session=self.session,
            )
        except PdfDownloadError:
            return None
        return parse_pdf_to_text(content)


def _extract_abstract(inverted_index: Optional[dict]) -> str:
    """OpenAlex 用倒排索引存储摘要，需还原成顺序文本。"""
    if not inverted_index:
        return ""
    pos_map: dict[int, str] = {}
    for word, positions in inverted_index.items():
        for p in positions:
            pos_map[p] = word
    return " ".join(pos_map[i] for i in sorted(pos_map))
