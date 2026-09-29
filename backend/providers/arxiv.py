"""arXiv API 数据源适配器。

- 搜索/详情：https://export.arxiv.org/api/query（Atom XML，无需 key）
- 全文：https://arxiv.org/pdf/{id}.pdf（100% 开放获取）

arXiv 不提供结构化引用数据，references/citations 返回空列表
（引用追踪由 Semantic Scholar 提供）。
"""
from __future__ import annotations

import re
import threading
import time
import xml.etree.ElementTree as ET
from typing import Optional

import requests

from config import HTTP_TIMEOUT
from i18n import tr
from providers.base import Paper, PaperProvider, SearchQuery, make_paper_id
from providers.download import (
    PdfDownloadError,
    download_pdf_first_available,
    parse_pdf_to_text,
)

QUERY_URL = "https://export.arxiv.org/api/query"

# arXiv 官方使用条款建议请求间隔 ≥ 3 秒。实测短时间连发 export.arxiv.org 会
# 触发边缘突发限流：返回 **406 空响应且不带任何响应头**（非标准速率错误码），
# 持续约 20 秒冷却窗，窗内 search / structured / get_paper 的每个请求都失败
# （ReAct 一轮里多源 paper_search 再叠加 read_paper 极易踩中）；arxiv.org 的
# PDF 下载同属 arXiv 服务，突发时同样会 503。用进程级节流 + 对 406/429/5xx
# 的退避重试，把单源抖动挡在聚合层之内。
_ARXIV_MIN_INTERVAL = 3.0
_ARXIV_RETRY_STATUSES = {406, 429, 500, 502, 503, 504}
# 最多 2 次重试：第 1 次重试前基础等待 5s，第 2 次 15s（实测冷却约 20s，
# 多数情况下 5~15s 后首个请求即恢复 200）
_ARXIV_BACKOFF = (5.0, 15.0)
_arxiv_rate_lock = threading.Lock()
_arxiv_last_request_at = 0.0


def _arxiv_throttle() -> None:
    """保证距上一次 arXiv API 请求至少 ``_ARXIV_MIN_INTERVAL`` 秒（进程级）。"""
    global _arxiv_last_request_at
    with _arxiv_rate_lock:
        wait = _ARXIV_MIN_INTERVAL - (time.monotonic() - _arxiv_last_request_at)
        if wait > 0:
            time.sleep(wait)
        _arxiv_last_request_at = time.monotonic()


NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


def _extract_id_from_abs_url(abs_url: str) -> str:
    """从 arXiv abs URL 提取 id。

    兼容两种格式：
    - 新版：http://arxiv.org/abs/2103.03404  → 2103.03404
    - 旧版：http://arxiv.org/abs/hep-ph/0304186v1  → hep-ph/0304186v1
    """
    # 去掉末尾反斜杠与 URL 片段的尾部斜杠，捕获 /abs/ 之后剩余内容
    m = re.search(r"/abs/([A-Za-z0-9._\/:+-]+?)/?$", abs_url)
    if m:
        return m.group(1)
    raise ValueError(tr("search.arxiv_id_parse_failed", url=abs_url))


class ArxivProvider(PaperProvider):
    source = "arxiv"

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "PaperMind/0.1 (research assistant)"})

    # ---------- 内部工具 ----------
    def _query(self, params: dict) -> bytes:
        """GET arXiv API：进程级 ≥3s 节流；遇 406/429/5xx 退避重试最多 2 次。

        突发限流的 406 响应不带 Retry-After（甚至无任何响应头），按固定退避
        等待；429/503 若给出 Retry-After 则优先尊重（上限 30s）。
        """
        resp: Optional[requests.Response] = None
        for attempt in range(len(_ARXIV_BACKOFF) + 1):
            _arxiv_throttle()
            resp = self.session.get(QUERY_URL, params=params, timeout=HTTP_TIMEOUT)
            if (
                resp.status_code in _ARXIV_RETRY_STATUSES
                and attempt < len(_ARXIV_BACKOFF)
            ):
                retry_after = resp.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else _ARXIV_BACKOFF[attempt]
                except (TypeError, ValueError):
                    delay = _ARXIV_BACKOFF[attempt]
                time.sleep(min(max(delay, 1.0), 30.0))
                continue
            resp.raise_for_status()
            return resp.content
        # 理论不可达：最后一次 attempt 不会 continue，由 raise_for_status 收尾
        raise RuntimeError(tr(
            "search.arxiv_rate_limited",
            status=resp.status_code if resp is not None else "?",
        ))

    @staticmethod
    def _parse_entries(xml_bytes: bytes) -> list[Paper]:
        root = ET.fromstring(xml_bytes)
        papers: list[Paper] = []
        for entry in root.findall("atom:entry", NS):
            abs_url = entry.findtext("atom:id", "", NS)
            ext_id = _extract_id_from_abs_url(abs_url)
            title = re.sub(r"\s+", " ", entry.findtext("atom:title", "", NS)).strip()
            summary = re.sub(r"\s+", " ", entry.findtext("atom:summary", "", NS)).strip()
            published = entry.findtext("atom:published", "", NS)
            year = int(published[:4]) if published else None

            authors: list[str] = []
            for author in entry.findall("atom:author", NS):
                name = author.findtext("atom:name", "", NS)
                if name:
                    authors.append(name.strip())

            pdf_url = None
            for link in entry.findall("atom:link", NS):
                if link.get("rel") == "related" and link.get("title") == "pdf":
                    pdf_url = link.get("href")

            papers.append(Paper(
                id=make_paper_id(ArxivProvider.source, ext_id),
                title=title,
                authors=authors,
                year=year,
                abstract=summary,
                source=ArxivProvider.source,
                external_id=ext_id,
                url=abs_url,
                pdf_url=pdf_url,
                pdf_candidates=[pdf_url] if pdf_url else [],
            ))
        return papers

    # ---------- 公开接口 ----------
    def search(self, query: str, limit: int = 10) -> list[Paper]:
        # 注意：不能对 query 预先 quote()——requests 会再编码一次 % 号
        # （空格变 %2520），arXiv 收不到可解析的表达式而静默返回 0 条。
        # 多词用 all:(w1 w2) 括号形式（与 search_structured 的字段子句一致）。
        xml_bytes = self._query({
            "search_query": self._field_clause("all", query),
            "max_results": limit,
            "sortBy": "relevance",
            "sortOrder": "descending",
        })
        return self._parse_entries(xml_bytes)

    @staticmethod
    def _field_clause(prefix: str, value: str) -> str:
        """把一个多词值构造成 arXiv 字段子句。

        多词用括号包裹：arXiv 会把括号内各词按 AND 处理并做相关性排序。
        不能用 ``prefix:w1 AND prefix:w2`` 形式——标题/作者中的停用词
        （is / all / you 等）会让整个子句返回 0 结果。
        """
        words = value.split()
        if not words:
            return ""
        if len(words) == 1:
            return f"{prefix}:{words[0]}"
        return f"{prefix}:({' '.join(words)})"

    def search_structured(self, q: SearchQuery) -> list[Paper]:
        """多字段检索：使用 arXiv 原生的字段限定（ti/abs/au/all）。

        - 标题 → ``ti:``，摘要/正文 → ``abs:``，作者 → ``au:``；
        - 关键词 / 全文词 → ``all:``（元数据全字段匹配）；
        - 年份区间 → ``submittedDate:[YYYY0101 TO YYYY1231]``。
        """
        clauses: list[str] = []
        if q.title:
            clauses.append(self._field_clause("ti", q.title))
        if q.abstract:
            clauses.append(self._field_clause("abs", q.abstract))
        if q.author:
            clauses.append(self._field_clause("au", q.author))
        if q.keywords:
            clauses.append(self._field_clause("all", q.keywords))
        if q.fulltext:
            clauses.append(self._field_clause("all", q.fulltext))
        if q.year_from is not None or q.year_to is not None:
            frm = q.year_from or 0
            to = q.year_to or 9999
            clauses.append(f"submittedDate:[{frm}0101 TO {to}1231]")
        if not clauses:
            return []
        search_query = " AND ".join(clauses)
        xml_bytes = self._query({
            "search_query": search_query,
            "max_results": q.limit,
            "sortBy": "relevance",
            "sortOrder": "descending",
        })
        return self._parse_entries(xml_bytes)

    def get_paper(self, external_id: str) -> Paper:
        xml_bytes = self._query({
            "id_list": external_id,
            "max_results": 1,
        })
        papers = self._parse_entries(xml_bytes)
        if not papers:
            raise LookupError(tr("search.arxiv_not_found", external_id=external_id))
        return papers[0]

    def get_references(self, external_id: str, limit: int = 100) -> list[Paper]:
        # arXiv 不提供结构化引用数据
        return []

    def get_citations(self, external_id: str, limit: int = 100) -> list[Paper]:
        # arXiv 不提供结构化被引数据
        return []

    def get_fulltext(self, paper: Paper) -> Optional[str]:
        """从 arXiv PDF 下载并解析纯文本（arXiv 100% OA）。"""
        fallback = f"https://arxiv.org/pdf/{paper.external_id}"
        urls = list(paper.pdf_candidates) or []
        if fallback not in urls:
            urls.append(fallback)
        _arxiv_throttle()
        try:
            content, _used = download_pdf_first_available(
                urls, session=self.session,
            )
        except PdfDownloadError:
            return None
        return parse_pdf_to_text(content)
