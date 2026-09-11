"""``settings`` 命名空间文案：设置页（``routes/settings.py``、``settings_store.py``）。

覆盖：设置校验错误、连通性测试结果、数据源凭据标签与说明。
数据源 ``label``（Semantic Scholar / arXiv 等）为专有名词，保持原样不翻译。
"""
from __future__ import annotations

MESSAGES: dict[str, dict[str, str]] = {
    "zh": {
        # 路由层：连通性测试与通用错误
        "settings.internal_error": "服务内部错误: {err}",
        "settings.llm_call_failed": "调用失败: {exc}",
        "settings.llm_empty_content": "服务返回了空内容，请检查模型名是否正确",
        "settings.llm_connected": "连接成功（模型 {model}）",
        "settings.unknown_source": "未知数据源: {source_id}",
        "settings.source_no_result": "请求成功但没有返回结果，请检查配置",
        "settings.source_connected": "连接成功（返回 {n} 条）",
        "settings.missing_target": "缺少 target 参数",
        # 设置存储：配置校验错误
        "settings.source_priority_unknown": "SOURCE_PRIORITY 含未知数据源: {sources}",
        "settings.source_priority_empty": "SOURCE_PRIORITY 不能为空（至少要启用一个数据源）",
        "settings.invalid_base_url": "LLM Base URL 必须以 http:// 或 https:// 开头",
        "settings.empty_model": "LLM 模型名不能为空",
        "settings.source_order_not_list": "source_order 必须是数组",
        "settings.source_order_unknown": "source_order 含未知数据源: {source}",
        "settings.source_order_empty": "至少要启用一个数据源",
        "settings.llm_not_object": "llm 必须是对象",
        "settings.credentials_not_object": "credentials 必须是对象",
        "settings.credentials_unknown": "credentials 含未知数据源: {sources}",
        "settings.nothing_to_save": "没有需要保存的设置项",
        # 数据源目录：凭据标签与说明（label 为专有名词，不在此表）
        "settings.source.semantic_scholar.credential_label": "API Key",
        "settings.source.semantic_scholar.description": "引用数据最全，检索与引用追踪主源。留空则用匿名共享池，限流很严（易 429）。",
        "settings.source.openalex.credential_label": "礼貌请求邮箱 (mailto)",
        "settings.source.openalex.description": "元数据全面，免费且无需 key。填入邮箱可进入 polite pool，限流大幅放宽。",
        "settings.source.arxiv.description": "预印本平台，PDF 100% 开放获取。无需任何配置。",
        "settings.source.core.credential_label": "API Key",
        "settings.source.core.description": "全球开放获取仓储聚合库，提供全文直链。匿名可用但限流较严（约 5 次/10 秒），填 key 可提升。",
    },
    "en": {
        # Routes: connectivity tests and generic errors
        "settings.internal_error": "Internal server error: {err}",
        "settings.llm_call_failed": "Request failed: {exc}",
        "settings.llm_empty_content": "The service returned empty content; check that the model name is correct",
        "settings.llm_connected": "Connected (model {model})",
        "settings.unknown_source": "Unknown data source: {source_id}",
        "settings.source_no_result": "Request succeeded but returned no results; check the configuration",
        "settings.source_connected": "Connected ({n} results)",
        "settings.missing_target": "Missing target parameter",
        # Settings store: config validation errors
        "settings.source_priority_unknown": "SOURCE_PRIORITY contains unknown data sources: {sources}",
        "settings.source_priority_empty": "SOURCE_PRIORITY cannot be empty (at least one data source must be enabled)",
        "settings.invalid_base_url": "LLM base URL must start with http:// or https://",
        "settings.empty_model": "LLM model name cannot be empty",
        "settings.source_order_not_list": "source_order must be an array",
        "settings.source_order_unknown": "source_order contains unknown data source: {source}",
        "settings.source_order_empty": "At least one data source must be enabled",
        "settings.llm_not_object": "llm must be an object",
        "settings.credentials_not_object": "credentials must be an object",
        "settings.credentials_unknown": "credentials contains unknown data sources: {sources}",
        "settings.nothing_to_save": "No settings to save",
        # Source catalog: credential labels and descriptions (labels are proper nouns, not here)
        "settings.source.semantic_scholar.credential_label": "API Key",
        "settings.source.semantic_scholar.description": "Most complete citation data; the primary source for search and citation tracking. If left blank, the anonymous shared pool is used with strict rate limits (prone to 429).",
        "settings.source.openalex.credential_label": "Polite request email (mailto)",
        "settings.source.openalex.description": "Comprehensive metadata, free of charge and requiring no key. Providing an email grants the polite pool, greatly relaxing rate limits.",
        "settings.source.arxiv.description": "Preprint platform with 100% open-access PDFs. No configuration required.",
        "settings.source.core.credential_label": "API Key",
        "settings.source.core.description": "Aggregator of global open-access repositories, offering direct full-text links. Usable anonymously but with strict rate limits (about 5 requests/10s); providing a key improves them.",
    },
}
