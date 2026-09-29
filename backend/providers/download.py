"""论文全文下载工具：统一 HTTP 客户端。

解决全文下载的共性问题：
- 带真实 User-Agent（arXiv/SS 会对无 UA 直连瞬时断开）
- 对连接/超时/分块读取类瞬时错误，以及 429/503 限流做指数退避重试
- 用 PDF 魔数校验返回内容，避免把 HTML 错误页当 PDF 返回
- 识别反爬验证墙（Radware/Cloudflare 人机校验页），给出准确原因而非笼统的
  "内容不是有效 PDF"
- 若宿主返回的是 HTML 落地页，尝试用其中的 citation_pdf_url 元信息再取一次真 PDF
- :func:`download_pdf_first_available` 按顺序尝试一篇论文的**多个开放获取镜像**
  （arXiv / 出版社 PDF / PMC 等，由各 provider 在 Paper.pdf_candidates 给出），
  任一镜像返回真 PDF 即成功——单源被反爬墙拦截不再等于论文不可下载
- 业务性错误（401/403/404）与格式不符不重试、不吞成假数据
"""
from __future__ import annotations

import logging
import re
import time
from typing import Optional, Sequence
from urllib.parse import urljoin

import requests

from config import HTTP_TIMEOUT
from i18n import tr

logger = logging.getLogger(__name__)

PDF_MAGIC = b"%PDF"

# 仅对这类"瞬时性"错误重试；401/403/404 等业务码由 raise_for_status 抛出，不重试
_RETRIABLE = (
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    requests.exceptions.ChunkedEncodingError,
)
# 限流/临时过载：退避后重试（arXiv 突发期会返回 503）
_RETRIABLE_HTTP = {429, 503}

DEFAULT_HEADERS = {
    "User-Agent": "PaperMind/0.1 (research assistant; mailto:papermind@example.com)",
    "Accept": "application/pdf,application/x-pdf,*/*",
}

# 落地页里的真实 PDF 地址（Google Scholar 等通用约定，属性顺序不固定）
_CITATION_PDF_RES = (
    re.compile(r"""<meta[^>]*name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']""", re.I),
    re.compile(r"""<meta[^>]*content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']""", re.I),
)

# 反爬/人机验证墙特征：状态码常常是 200，正文却是验证页 HTML——必须与普通
# "宿主错误页"区分开（实测 IOP 经 Radware 302 到 validate.perfdrive.com 验证页；
# Cloudflare 拦截页标题为 "Just a moment..."）
_BOT_WALL_SIGNATURES = (
    b"validate.perfdrive.com",
    b"Radware Bot Manager",
    b"Just a moment",
    b"/cdn-cgi/challenge-platform",
    b"cf-challenge",
    b"captcha-delivery.com",
)
_BOT_WALL_HOST_RE = re.compile(r"validate\.perfdrive\.com|challenges\.cloudflare\.com", re.I)


def _looks_like_bot_wall(content: bytes, final_url: str) -> bool:
    """识别"人机验证/反爬墙"页面（200 + HTML，无 citation_pdf_url）。"""
    if _BOT_WALL_HOST_RE.search(final_url or ""):
        return True
    head = content[:30000]
    return any(sig in head for sig in _BOT_WALL_SIGNATURES)


class PdfDownloadError(Exception):
    """PDF 下载失败（携带面向用户的具体原因，供工具/路由准确反馈）。

    与返回 None 的旧约定不同：None 无法告诉调用方"为什么拿不到"。
    下载层用本异常区分 403/404/其它 HTTP 错误、网络瞬时错误重试耗尽、
    内容非 PDF 等情形，让上层（read_paper 工具 / read_materials 步骤 /
    /paper/{id}/pdf 路由）把准确原因透传给用户与 LLM。
    """

    def __init__(self, reason: str, url: str = "",
                 status_code: Optional[int] = None,
                 bot_wall: bool = False) -> None:
        super().__init__(reason + (tr("pdf.url_suffix", url=url) if url else ""))
        self.reason = reason
        self.url = url
        self.status_code = status_code
        # True 表示失败由人机验证/反爬墙导致——多镜像聚合报因时优先呈现，
        # 因为它给出可操作建议（浏览器手动下载），比末尾镜像的 403/404 更关键
        self.bot_wall = bot_wall


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
                    # 反爬人机验证墙：重试同一地址无意义（不会自动放行无头
                    # 客户端），报准确原因并交给上层尝试下一个 OA 镜像
                    if _looks_like_bot_wall(content, resp.url):
                        logger.warning("PDF 地址被反爬验证墙拦截: %s (final=%s)",
                                       url, resp.url)
                        raise PdfDownloadError(
                            tr("pdf.bot_wall"), url=url,
                            status_code=resp.status_code, bot_wall=True,
                        )
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
                # 429/503：限流/临时过载，尊重 Retry-After 退避后重试
                if code in _RETRIABLE_HTTP and attempt < retries - 1:
                    retry_after = None
                    if exc.response is not None:
                        retry_after = exc.response.headers.get("Retry-After")
                    try:
                        delay = float(retry_after) if retry_after else min(2 ** attempt, 8)
                    except (TypeError, ValueError):
                        delay = min(2 ** attempt, 8)
                    logger.warning("PDF 下载被限流（%s），%.0fs 后重试（%d/%d）: %s",
                                   code, delay, attempt + 1, retries, url)
                    time.sleep(min(max(delay, 1.0), 30.0))
                    continue
                reason = {
                    401: tr("pdf.http_401"),
                    403: tr("pdf.http_403"),
                    404: tr("pdf.http_404"),
                    410: tr("pdf.http_410"),
                    429: tr("pdf.http_429"),
                    503: tr("pdf.http_503"),
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


def download_pdf_first_available(
    urls: Sequence[str],
    *,
    retries: int = 3,
    timeout: int = HTTP_TIMEOUT,
    session: Optional[requests.Session] = None,
) -> tuple[bytes, str]:
    """按顺序尝试一篇论文的多个开放获取地址，返回首个真 PDF。

    OpenAlex 等聚合源对同一篇论文登记多个 location（arXiv 直链、出版社 PDF、
    PMC 仓储落地页等）：出版社站点常被反爬墙拦截（实测 IOP/Radware 对无头
    客户端返回验证页 HTML），而 arXiv/PMC 镜像可用——单 URL 策略会把"首选
    镜像不可达"误判为"论文不可下载"。这里逐个尝试（去重、保序），任一成功
    即返回 ``(PDF 字节, 实际命中的 URL)``；全部失败时抛 :class:`PdfDownloadError`，
    原因包含尝试数量与最后一个地址的具体阻断理由。

    每个地址内部仍走 :func:`download_pdf`（重试、魔数校验、落地页解析等规则
    完全一致），本函数只负责"换镜像"这一层策略，不伪造任何内容。
    """
    seen: set[str] = set()
    attempts: list[tuple[str, PdfDownloadError]] = []
    for url in urls:
        url = (url or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        try:
            content = download_pdf(
                url, retries=retries, timeout=timeout, session=session,
            )
        except PdfDownloadError as exc:
            attempts.append((url, exc))
            logger.warning("全文候选地址失败，尝试下一镜像: %s -> %s",
                           url, exc.reason)
            continue
        if len(attempts):
            logger.info("第 %d 个候选地址命中真 PDF: %s",
                        len(attempts) + 1, url)
        return content, url
    if not attempts:
        # 传入的 URL 列表为空：调用方通常已先行检查，这里只做防御
        raise PdfDownloadError(tr("pdf.no_candidate_url"))
    last_url, last_exc = attempts[-1]
    # 若任一镜像被人机验证墙拦截，优先以该原因作为聚合结论（可操作：
    # 浏览器手动下载）；否则取最后一个镜像的具体阻断原因
    wall_hit = next(((u, e) for u, e in attempts if e.bot_wall), None)
    rep_url, rep_exc = wall_hit or (last_url, last_exc)
    raise PdfDownloadError(
        tr("pdf.all_mirrors_failed",
           n=len(attempts), last=rep_exc.reason),
        url=rep_url,
        status_code=rep_exc.status_code,
        bot_wall=wall_hit is not None,
    ) from rep_exc


def parse_pdf_to_text(content: bytes) -> str:
    """将 PDF 字节解析为纯文本；解析失败抛异常（不静默降级）。"""
    import pymupdf

    doc = pymupdf.open(stream=content, filetype="pdf")
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()