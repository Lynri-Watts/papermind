"""上下文库条目内容获取：供 API 路由与 ``read_context`` 工具共用。

抽离自 ``routes/papers.py``（原 ``_context_fulltext_checked``），使工具层可
直接复用而无需依赖路由模块（避免循环导入）。
"""
from __future__ import annotations

from i18n import tr
from services.fulltext import get_paper_fulltext_checked


def context_fulltext_checked(item: dict) -> tuple[str, str]:
    """取 context 项的全文；读取失败时返回面向用户的具体原因：

    - paper：论文全文（取不到全文时回退摘要，仍为空则说明论文侧原因）
    - url：缓存的网页正文
    """
    if item["type"] == "paper":
        ref_id = item.get("ref_id")
        if not ref_id:
            return "", tr("api.context_item.no_paper_ref")
        text, reason = get_paper_fulltext_checked(ref_id)
        if text:
            return text, ""
        content = item.get("content")
        if isinstance(content, dict):
            abstract = content.get("abstract") or ""
            if abstract:
                return abstract, ""
        return "", reason or tr("api.context_item.no_public_fulltext")
    content = item.get("content")
    if isinstance(content, str) and content.strip():
        return content, ""
    return "", tr("api.context_item.no_saved_content")
