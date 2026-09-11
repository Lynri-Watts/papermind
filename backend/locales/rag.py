"""``rag`` 命名空间文案：RAG 引擎与工具回执
（``llm/rag.py``、``llm/tools.py``、``llm/client.py``）。

覆盖：LLM 未配置提示、无正文可作答提示、工具回执正文（会同时回传 LLM
并显示在问答步骤卡片中）、工具注册表错误。
LLM system/user 提示词与工具 description/JSON Schema 属模型指令，不本地化。
"""
from __future__ import annotations

MESSAGES: dict[str, dict[str, str]] = {
    "zh": {
        # LLM 客户端
        "rag.llm_not_configured": "LLM API Key 未配置。请在「设置」页填写大模型服务后重试。",
        # RAG 引擎
        "rag.no_readable_passages": "可用的材料中没有可阅读的正文段落，无法作答。",
        # 工具注册表
        "rag.tool_missing_name": "工具必须声明 name",
        "rag.tool_duplicate": "工具已注册: {name}",
        "rag.tool_unknown": "未知工具: {name}",
        # 论文搜索工具回执
        "rag.search_no_criteria": "未提供任何搜索条件，无法搜索。请至少指定标题、正文、关键词、作者或全文之一。",
        "rag.search_failed": "论文搜索失败: {exc}",
        "rag.search_no_results": "未找到符合条件的论文。",
        "rag.search_found": "找到 {n} 篇论文（来源: {sources}）：",
        "rag.search_skipped_sources": "（未返回结果的来源：{detail}）",
        "rag.source_no_match": "无匹配",
        "rag.label_authors": "作者",
        "rag.label_source": "来源",
        "rag.label_citations": "引用",
        "rag.label_id": "id",
        "rag.label_abstract": "摘要",
        "rag.value_unknown": "未知",
        "rag.value_no_abstract": "（无摘要）",
        # 全文读取工具回执
        "rag.read_paper_no_ids": "未提供要读取全文的论文 id（paper_ids）。",
        "rag.read_paper_unknown_reason": "未知原因，未获取到全文",
        "rag.read_paper_failed_header": "无法读取所选论文的全文：",
        "rag.read_paper_loaded_header": "已读取 {n} 篇论文全文：",
        "rag.read_paper_preview_label": "开头预览",
        "rag.read_paper_extra_failed": "另有 {n} 篇未能读取：",
        # 当前文档读取工具回执
        "rag.read_document_empty": "当前没有可读取的文档（可能未在写作视图中打开编辑器）。",
        "rag.read_document_loaded": "已读取当前文档（共 {n} 字符）。内容如下：",
        "rag.read_document_truncated": "……（内容较长，已截断）",
    },
    "en": {
        # LLM client
        "rag.llm_not_configured": "The LLM API key is not configured. Please configure the LLM service in the Settings page, then retry.",
        # RAG engine
        "rag.no_readable_passages": "The available material has no readable body passages, so no answer can be produced.",
        # Tool registry
        "rag.tool_missing_name": "Tool must declare a name",
        "rag.tool_duplicate": "Tool already registered: {name}",
        "rag.tool_unknown": "Unknown tool: {name}",
        # Paper search tool result
        "rag.search_no_criteria": "No search criteria provided. Specify at least one of title, abstract, keywords, author, or fulltext.",
        "rag.search_failed": "Paper search failed: {exc}",
        "rag.search_no_results": "No papers matched the criteria.",
        "rag.search_found": "Found {n} papers (sources: {sources}):",
        "rag.search_skipped_sources": "(Sources that returned no results: {detail})",
        "rag.source_no_match": "No match",
        "rag.label_authors": "Authors",
        "rag.label_source": "Source",
        "rag.label_citations": "Citations",
        "rag.label_id": "id",
        "rag.label_abstract": "Abstract",
        "rag.value_unknown": "Unknown",
        "rag.value_no_abstract": "(No abstract)",
        # Fulltext reading tool result
        "rag.read_paper_no_ids": "No paper ids (paper_ids) provided to read the fulltext.",
        "rag.read_paper_unknown_reason": "Unknown reason; fulltext was not retrieved",
        "rag.read_paper_failed_header": "Could not read the fulltext of the selected papers:",
        "rag.read_paper_loaded_header": "Read the fulltext of {n} papers:",
        "rag.read_paper_preview_label": "Preview",
        "rag.read_paper_extra_failed": "{n} more could not be read:",
        # Current document reading tool result
        "rag.read_document_empty": "No document available to read (the editor may not be open in the writing view).",
        "rag.read_document_loaded": "Read the current document ({n} characters in total). Contents:",
        "rag.read_document_truncated": "……(content is long, truncated)",
    },
}
