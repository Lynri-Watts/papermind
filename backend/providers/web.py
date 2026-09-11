"""URL 网页正文抓取与文本抽取（Context 系统用）。

仅依赖 requests + 标准库 html.parser，无额外依赖。
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import urlparse

import requests

from config import HTTP_TIMEOUT
from i18n import tr

# 非文本内容类型，直接拒绝
_SKIP_CONTENT_TYPES = (
    "image/", "video/", "audio/", "application/pdf", "application/octet-stream",
    "application/zip", "application/gzip",
)


class _TextExtractor(HTMLParser):
    """抽取 <title> 与正文可见文本，忽略 script/style/nav 等噪声。"""

    _SKIP_TAGS = {
        "script", "style", "noscript", "svg", "head", "nav", "footer", "header",
        "form", "iframe", "aside",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title = (self.title + data).strip()
        if self._skip_depth == 0:
            text = data.strip()
            if text:
                self.parts.append(text)


def fetch_webpage(url: str, max_chars: int = 200_000) -> dict:
    """抓取网页并抽取标题与正文。

    :returns: {"url": str, "title": str, "text": str}
    :raises ValueError: URL 非法或返回非文本内容
    :raises RuntimeError: 网络/解析失败或正文为空
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(tr("search.invalid_url", url=url))

    resp = requests.get(
        url,
        timeout=HTTP_TIMEOUT,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 PaperMind/1.0"
            ),
            "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
        },
    )
    resp.raise_for_status()

    ctype = resp.headers.get("Content-Type", "").lower()
    if any(s in ctype for s in _SKIP_CONTENT_TYPES):
        raise ValueError(tr("search.non_text_content", ctype=ctype))

    encoding = resp.encoding or "utf-8"
    html = resp.content.decode(encoding, errors="replace")

    extractor = _TextExtractor()
    try:
        extractor.feed(html)
    except Exception as exc:
        raise RuntimeError(tr("search.webpage_parse_failed", exc=exc)) from exc

    text = "\n".join(extractor.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    text = text[:max_chars]

    if not text:
        raise RuntimeError(tr("search.webpage_no_text"))

    return {"url": url, "title": extractor.title or url, "text": text}
