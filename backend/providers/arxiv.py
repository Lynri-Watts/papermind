"""arXiv API 数据源适配器。

- 搜索/详情：https://export.arxiv.org/api/query（Atom XML，无需 key）
- 全文：https://arxiv.org/pdf/{id}.pdf（100% 开放获取）

arXiv 不提供结构化引用数据，references/citations 返回空列表
（引用追踪由 Semantic Scholar 提供）。
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Optional

import requests

from config import HTTP_TIMEOUT
from i18n import tr
from providers.base import Paper, PaperProvider, SearchQuery, make_paper_id
from providers.download import PdfDownloadError, download_pdf, parse_pdf_to_text

QUERY_URL = "https://export.arxiv.org/api/query"

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
        resp = self.session.get(QUERY_URL, params=params, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        return resp.content

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
        pdf_url = paper.pdf_url or f"https://arxiv.org/pdf/{paper.external_id}"
        try:
            content = download_pdf(pdf_url, session=self.session)
        except PdfDownloadError:
            return None
        return parse_pdf_to_text(content)
