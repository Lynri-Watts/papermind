"""论文全文下载工具：统一 HTTP 客户端。

解决全文下载的共性问题：
- 带真实 User-Agent（arXiv/SS 会对无 UA 直连瞬时断开）
- 对连接/超时/分块读取类瞬时错误做指数退避重连
- 用 PDF 魔数校验返回内容，避免把 HTML 错误页当 PDF 返回
- 若宿主返回的是 HTML 落地页，尝试用其中的 citation_pdf_url 元信息再取一次真 PDF
- 业务性错误（4xx/5xx）与格式不符不重试、不吞成假数据
"""
from __future__ import annotations

import logging
import re
import time
from typing import Optional
from urllib.parse import urljoin

import requests

from config import HTTP_TIMEOUT
from i18n import tr

logger = logging.getLogger(__name__)

PDF_MAGIC = b"%PDF"

# 仅对这类"瞬时性"错误重试；HTTP 业务码由 raise_for_status 抛出，不重试
_RETRIABLE = (
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    requests.exceptions.ChunkedEncodingError,
)

DEFAULT_HEADERS = {
    "User-Agent": "PaperMind/0.1 (research assistant; mailto:papermind@example.com)",
    "Accept": "application/pdf,application/x-pdf,*/*",
}

# 落地页里的真实 PDF 地址（Google Scholar 等通用约定，属性顺序不固定）
_CITATION_PDF_RES = (
    re.compile(r"""<meta[^>]*name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']""", re.I),
    re.compile(r"""<meta[^>]*content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']""", re.I),
)


class PdfDownloadError(Exception):
    """PDF 下载失败（携带面向用户的具体原因，供工具/路由准确反馈）。

    与返回 None 的旧约定不同：None 无法告诉调用方"为什么拿不到"。
    下载层用本异常区分 403/404/其它 HTTP 错误、网络瞬时错误重试耗尽、
    内容非 PDF 等情形，让上层（read_paper 工具 / read_materials 步骤 /
    /paper/{id}/pdf 路由）把准确原因透传给用户与 LLM。
    """

    def __init__(self, reason: str, url: str = "",
                 status_code: Optional[int] = None) -> None:
        super().__init__(reason + (tr("pdf.url_suffix", url=url) if url else ""))
        self.reason = reason
        self.url = url
        self.status_code = status_code


def _looks_like_pdf(content: bytes) -> bool:
    """用 PDF 魔数而不是 Content-Type 判断，避免宿主返回错误头。"""
    return content.startswith(PDF_MAGIC)


def _extract_citation_pdf_url(html: bytes, base_url: str) -> Optional[str]:
    """从 HTML 落地页中提取 ``citation_pdf_url`` 指向的真实 PDF 地址。"""
    try:
        text = html.decode("utf-8", errors="ignore")
    except Exception:  # 解码异常不阻断，返回 None 交给上层报错
        return None
    for pattern in _CITATION_PDF_RES:
        m = pattern.search(text)
        if m:
            return urljoin(base_url, m.group(1).strip())
    return None


def _resolve_landing_page_pdf(html: bytes, base_url: str,
                              sess: requests.Session, timeout: int) -> Optional[bytes]:
    """宿主返回 HTML 落地页时，顺着 ``citation_pdf_url`` 再取一次真 PDF。

    只做一次解析（不递归）：拿到的是 PDF 就返回字节，否则返回 None，
    由调用方按"内容非 PDF"如实报错。取不到就返回 None（不隐藏失败原因）。
    """
    pdf_url = _extract_citation_pdf_url(html, base_url)
    if not pdf_url:
        return None
    logger.info("宿主返回 HTML 落地页，尝试 citation_pdf_url: %s", pdf_url)
    try:
        resp = sess.get(pdf_url, headers=DEFAULT_HEADERS, timeout=timeout, stream=True)
        resp.raise_for_status()
        content = resp.content
    except Exception as exc:  # 解析出的候选失败→仍按原错误上报
        logger.warning("citation_pdf_url 下载失败: %s (%s)", pdf_url, exc)
        return None
    return content if _looks_like_pdf(content) else None


def download_pdf(
    url: str,
    *,
    retries: int = 3,
    timeout: int = HTTP_TIMEOUT,
    session: Optional[requests.Session] = None,
) -> bytes:
    """带 UA 与连接级重试下载 PDF 内容。

    - 成功且内容符合 PDF 魔数 → 返回字节
    - 下载失败 → 抛出 :class:`PdfDownloadError`，reason 区分：
      权限受限(403) / 地址不存在(404) / 其它 HTTP 错误 / 网络瞬时错误重试耗尽 /
      内容非 PDF。HTTP 业务码（4xx/5xx）不重试，网络类瞬时错误指数退避重试。
    """
    own_session = session is None
    sess = session if session is not None else requests.Session()
    try:
        last_exc: Optional[Exception] = None
        for attempt in range(retries):
            try:
                resp = sess.get(url, headers=DEFAULT_HEADERS, timeout=timeout, stream=True)
                resp.raise_for_status()
                content = resp.content
                # 内容非 PDF（如宿主返回 HTML 错误页/落地页）视为获取失败
                if not _looks_like_pdf(content):
                    content_type = resp.headers.get("Content-Type", "")
                    looks_html = "html" in content_type.lower() or content.lstrip()[:1] == b"<"
                    if looks_html:
                        # 落地页里可能带 citation_pdf_url 指向真 PDF，再取一次
                        resolved = _resolve_landing_page_pdf(content, resp.url, sess, timeout)
                        if resolved is not None:
                            return resolved
                    logger.warning("下载内容不是 PDF: %s (content-type=%s)", url, content_type)
                    raise PdfDownloadError(
                        tr("pdf.not_a_pdf"),
                        url=url,
                    )
                return content
            except requests.exceptions.HTTPError as exc:
                code = exc.response.status_code if exc.response is not None else None
                reason = {
                    401: tr("pdf.http_401"),
                    403: tr("pdf.http_403"),
                    404: tr("pdf.http_404"),
                    410: tr("pdf.http_410"),
                }.get(code, tr("pdf.http_rejected", code=code))
                raise PdfDownloadError(reason, url=url, status_code=code) from exc
            except _RETRIABLE as exc:
                last_exc = exc
                delay = min(2 ** attempt, 4)
                logger.warning("全文下载瞬时失败（%d/%d）: %s -> %s",
                               attempt + 1, retries, url, exc)
                if attempt < retries - 1:
                    time.sleep(delay)
        logger.error("全文下载失败，重试 %d 次后放弃: %s (%s)", retries, url, last_exc)
        raise PdfDownloadError(
            tr("pdf.network_retry_exhausted"), url=url,
        ) from last_exc
    finally:
        if own_session:
            sess.close()


def parse_pdf_to_text(content: bytes) -> str:
    """将 PDF 字节解析为纯文本；解析失败抛异常（不静默降级）。"""
    import pymupdf

    doc = pymupdf.open(stream=content, filetype="pdf")
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()