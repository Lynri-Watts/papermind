"""``search`` 命名空间文案：检索服务与数据源适配器
（``services/search.py``、``providers/__init__.py``、``providers/{web,openalex,arxiv,core,semantic_scholar}.py``）。

覆盖：检索条件校验错误、来源筛选错误、聚合检索失败原因、来源概要、
网页抓取错误与各数据源的可操作报错。
"""
from __future__ import annotations

MESSAGES: dict[str, dict[str, str]] = {
    "zh": {
        # 检索服务：结构化检索条件为空 / 关键词为空
        "search.empty_structured_query": "至少需要指定一个搜索条件（标题/摘要/关键词/作者/全文）",
        "search.missing_keyword": "缺少搜索关键词",
        # 来源概要：全部来源描述、无命中、多源命中项之间的分隔符
        "search.sources_all": "全部来源（{items}）",
        "search.no_hits": "无命中",
        "search.source_joiner": "、",
        # 来源筛选与聚合检索错误
        "search.unknown_source": "未知论文数据源: {source}",
        "search.unknown_source_with_options": "未知论文数据源: {sources}（可选: {options}）",
        "search.source_disabled": "数据源已在「设置」中停用: {sources}",
        "search.source_failed": "数据源 {source} 检索失败: {error}",
        "search.all_sources_failed": "所有论文数据源均检索失败: {detail}",
        # 网页正文抓取
        "search.invalid_url": "URL 不合法: {url}",
        "search.non_text_content": "该 URL 返回非文本内容（{ctype}），无法提取正文",
        "search.webpage_parse_failed": "解析网页失败: {exc}",
        "search.webpage_no_text": "未能从该网页提取到正文内容",
        # 各数据源 id 解析与未命中
        "search.openalex_id_parse_failed": "无法解析 OpenAlex work id: {url}",
        "search.arxiv_id_parse_failed": "无法从 arXiv URL 解析 id: {url}",
        "search.arxiv_not_found": "arXiv 未找到论文 {external_id}",
        # CORE 鉴权与限流
        "search.core_auth_failed": "CORE 鉴权失败（HTTP {status}），请检查 API Key 是否有效",
        "search.core_anonymous_rejected": "CORE 拒绝了匿名请求，请在「设置」中填写 CORE API Key",
        "search.core_rate_limited": "CORE 限流（429），请稍后重试或在「设置」中填写 CORE API Key",
        # Semantic Scholar 限流（匿名共享池，退避重试后仍 429）
        "search.semantic_scholar_rate_limited": "Semantic Scholar 限流（429），重试后仍未成功，请稍后重试或在「设置」中填写 API Key",
    },
    "en": {
        # Search service: empty structured query / empty keyword
        "search.empty_structured_query": "At least one search criterion is required (title/abstract/keywords/author/fulltext)",
        "search.missing_keyword": "Search keyword is required",
        # Source summary: all-sources description, no hits, separator between hits
        "search.sources_all": "All sources ({items})",
        "search.no_hits": "no hits",
        "search.source_joiner": ", ",
        # Source filtering and aggregated search errors
        "search.unknown_source": "Unknown paper source: {source}",
        "search.unknown_source_with_options": "Unknown paper source: {sources} (available: {options})",
        "search.source_disabled": "Data source disabled in Settings: {sources}",
        "search.source_failed": "Data source {source} search failed: {error}",
        "search.all_sources_failed": "All paper data sources failed: {detail}",
        # Webpage text extraction
        "search.invalid_url": "Invalid URL: {url}",
        "search.non_text_content": "The URL returned non-text content ({ctype}); cannot extract body text",
        "search.webpage_parse_failed": "Failed to parse the webpage: {exc}",
        "search.webpage_no_text": "No body text could be extracted from the webpage",
        # Source id parsing and not-found errors
        "search.openalex_id_parse_failed": "Cannot parse OpenAlex work id: {url}",
        "search.arxiv_id_parse_failed": "Cannot parse id from arXiv URL: {url}",
        "search.arxiv_not_found": "Paper not found on arXiv: {external_id}",
        # CORE authentication and rate limiting
        "search.core_auth_failed": "CORE authentication failed (HTTP {status}); check that the API key is valid",
        "search.core_anonymous_rejected": "CORE rejected the anonymous request; enter a CORE API key in Settings",
        "search.core_rate_limited": "CORE rate limited (429); retry later or enter a CORE API key in Settings",
        # Semantic Scholar rate limiting (anonymous shared pool; still 429 after backoff retry)
        "search.semantic_scholar_rate_limited": "Semantic Scholar rate limited (429); still failing after retry. Retry later or enter an API key in Settings",
    },
}
