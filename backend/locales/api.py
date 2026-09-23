"""``api`` 命名空间文案：论文/业务 API 路由（``routes/papers.py``）。

覆盖：请求参数校验错误、SSE stage/error/observation 提示、工具展示名。
LLM 提示词（system/user）与工具 JSON Schema 描述属模型指令，不在本地化范围。
"""
from __future__ import annotations

MESSAGES: dict[str, dict[str, str]] = {
    "zh": {
        # 通用 / 服务端
        "api.internal_error": "服务内部错误: {err}",
        # 论文 id / 本地文献
        "api.invalid_paper_id": "非法论文 id: {paper_id}，应为 source:external_id 格式",
        "api.invalid_local_id": "非法本地文献 id",
        "api.local_file_missing": "本地文献文件不存在，可能已被删除",
        # 上下文项全文（RAG 共用：读取失败时的面向用户原因）
        "api.context_item.no_paper_ref": "该上下文项未关联具体论文",
        "api.context_item.no_public_fulltext": "该论文没有可公开获取的全文",
        "api.context_item.no_saved_content": "该上下文项没有保存正文内容",
        # ReAct 工具展示名
        "api.tool_label.paper_search": "学术论文检索",
        "api.tool_label.read_paper": "读取论文全文",
        "api.tool_label.read_document": "读取当前文档",
        "api.tool_label.read_materials": "读取候选材料",
        "api.tool_label.list_mindmaps": "列出思维导图",
        "api.tool_label.create_mindmap": "新建思维导图",
        "api.tool_label.read_mindmap": "读取思维导图",
        "api.tool_label.edit_mindmap": "编辑思维导图",
        "api.tool_label.attach_paper_to_mindmap": "论文加入导图",
        # 列表 / 省略拼接
        "api.separator.list": "、",
        "api.separator.reason": "；",
        "api.more_items": " 等 {n} 项",
        # SSE 阶段与错误提示
        "api.stopped": "已停止生成",
        "api.stage.fetch_current_fulltext": "正在获取当前论文全文...",
        "api.stage.reading_context": "正在读取上下文「{title}」...",
        "api.stage.selecting_materials": "正在判断需要阅读哪些材料...",
        "api.stage.thinking_next": "AI 正在思考下一步...",
        "api.stage.thought_failed": "思考过程出错，将基于已有材料回答：{exc}",
        "api.stage.unknown_tool": "AI 请求了未知工具 {name}，已停止工具循环",
        "api.stage.no_progress": "AI 连续请求同一工具，判定无进展，停止工具循环...",
        "api.stage.retrieving": "正在检索相关内容...",
        "api.stage.generating": "正在生成回答...",
        "api.tool_exec_failed": "{tool_label} 执行失败: {exc}",
        "api.rag.failed": "RAG 问答失败: {exc}",
        # 候选材料读取失败原因
        "api.reason.fulltext_missing": "未获取到全文",
        "api.reason.no_usable_content": "没有可用的正文内容",
        "api.read_fail.paper": "「{title}」：{reason}",
        "api.read_fail.paper_abstract_only": "「{title}」全文不可得（{reason}），已降级为仅依据摘要",
        "api.read_fail.context": "上下文「{title}」：{reason}",
        "api.read_fail.context_gone": "上下文项 #{sid}：已不存在，可能被删除",
        # 候选材料读取结果（observation / 内部读取情况）
        "api.read_materials.select_failed": "判断需要阅读的材料失败: {exc}",
        "api.read_materials.read_ok": "已读取 {n} 项候选材料：{shown}",
        "api.read_materials.empty": "内容为空",
        "api.read_materials.some_failed": "；{n} 项未能读取：{reasons}",
        "api.read_materials.some_degraded": "；{n} 项降级使用（如仅有摘要）：{reasons}",
        "api.read_materials.none_usable": "所选材料均无可用正文",
        "api.read_materials.all_failed": "候选材料均未能读取：{reasons}",
        # 回答生成
        "api.answer.no_material_notice":
            "当前没有可引用的文献材料（未打开论文、上下文库为空，也未检索到可读文献）。"
            "以下回答由 AI 基于通用知识生成，未经材料核实，请注意甄别；"
            "打开论文或添加上下文后即可获得有据可依的回答。",
        "api.answer.no_material_with_note":
            "材料未能成功读取（{note}）。以下回答未引用任何文献，"
            "由 AI 基于通用知识生成，请注意甄别；可尝试刷新论文 PDF 或添加上下文。",
        "api.answer.no_passages_notice":
            "已有材料中没有可解析的正文段落（{note}）。以下回答由 AI 基于通用知识生成，请注意甄别。",
        # 材料兜底展示名
        "api.material_label.paper": "论文",
        "api.material_label.document": "当前文档",
        "api.material_label.candidate": "候选论文",
        # 搜索
        "api.search.missing_query": "缺少搜索条件：请提供 q，或 title/abstract/keywords/author/fulltext 之一",
        "api.search.structured_empty": "结构化搜索至少需要指定 title/abstract/keywords/author/fulltext 之一",
        # 全文 / PDF
        "api.fulltext.local_parse_failed": "该本地文献无法解析全文（可能不是有效 PDF）",
        "api.fulltext.unavailable": "该论文无法获取全文（可能不开放 PDF）",
        "api.pdf.not_available": "该论文没有可下载的 PDF",
        "api.pdf.download_failed": "无法下载该论文的 PDF：{reason}",
        # RAG 问答参数
        "api.rag.missing_paper_id": "缺少 paper_id",
        "api.rag.missing_question": "缺少 question",
        "api.rag.no_evidence": "该问题与当前论文和上下文库均不相关，未找到可用于回答的依据",
        # state / 笔记 / 上下文库 / 数据块
        "api.title_required": "title 不能为空",
        "api.state.invalid": "state 必须是 JSON 对象",
        "api.chat_title.empty": "query 不能为空",
        "api.note.empty": "笔记内容不能为空",
        "api.context.invalid_type": "type 必须是 paper/url 之一",
        "api.context.paper_requires_id": "paper 类型需要提供 paper_id",
        "api.context.url_requires_url": "url 类型需要提供 url",
        "api.context.fetch_failed": "抓取网页失败: {exc}",
        "api.context.refetch_failed": "重新抓取网页失败: {exc}",
        "api.context.not_found": "上下文不存在",
        "api.context.tags_must_be_array": "tags 必须是数组",
        "api.data_block.invalid_type": "type 必须是 chart/table/equation/text 之一",
    },
    "en": {
        # Generic / server-side
        "api.internal_error": "Internal server error: {err}",
        # Paper id / local files
        "api.invalid_paper_id": "Invalid paper id: {paper_id}; expected format source:external_id",
        "api.invalid_local_id": "Invalid local paper id",
        "api.local_file_missing": "Local paper file not found; it may have been deleted",
        # Context item full text (shared by RAG: user-facing failure reasons)
        "api.context_item.no_paper_ref": "This context item is not linked to a specific paper",
        "api.context_item.no_public_fulltext": "No publicly accessible full text is available for this paper",
        "api.context_item.no_saved_content": "No body content was saved for this context item",
        # ReAct tool display names
        "api.tool_label.paper_search": "Academic paper search",
        "api.tool_label.read_paper": "Read paper full text",
        "api.tool_label.read_document": "Read current document",
        "api.tool_label.read_materials": "Read candidate materials",
        "api.tool_label.list_mindmaps": "List mind maps",
        "api.tool_label.create_mindmap": "Create mind map",
        "api.tool_label.read_mindmap": "Read mind map",
        "api.tool_label.edit_mindmap": "Edit mind map",
        "api.tool_label.attach_paper_to_mindmap": "Attach paper to mind map",
        # List / truncation joining
        "api.separator.list": ", ",
        "api.separator.reason": "; ",
        "api.more_items": " and {n} more",
        # SSE stages and error hints
        "api.stopped": "Generation stopped",
        "api.stage.fetch_current_fulltext": "Fetching full text of the current paper...",
        "api.stage.reading_context": "Reading context \"{title}\"...",
        "api.stage.selecting_materials": "Determining which materials to read...",
        "api.stage.thinking_next": "AI is thinking about the next step...",
        "api.stage.thought_failed": "Error during reasoning; answering from existing material: {exc}",
        "api.stage.unknown_tool": "AI requested an unknown tool {name}; stopping the tool loop",
        "api.stage.no_progress": "AI requested the same tool repeatedly with no progress; stopping the tool loop...",
        "api.stage.retrieving": "Retrieving relevant content...",
        "api.stage.generating": "Generating answer...",
        "api.tool_exec_failed": "{tool_label} failed: {exc}",
        "api.rag.failed": "RAG Q&A failed: {exc}",
        # Candidate material read failure reasons
        "api.reason.fulltext_missing": "Full text not retrieved",
        "api.reason.no_usable_content": "No usable body content",
        "api.read_fail.paper": "\"{title}\": {reason}",
        "api.read_fail.paper_abstract_only": "\"{title}\": full text unavailable ({reason}); fell back to the abstract only",
        "api.read_fail.context": "Context \"{title}\": {reason}",
        "api.read_fail.context_gone": "Context item #{sid}: no longer exists; it may have been deleted",
        # Candidate material read result (observation / internal read note)
        "api.read_materials.select_failed": "Failed to determine materials to read: {exc}",
        "api.read_materials.read_ok": "Read {n} candidate material item(s): {shown}",
        "api.read_materials.empty": "no content",
        "api.read_materials.some_failed": "; {n} item(s) could not be read: {reasons}",
        "api.read_materials.some_degraded": "; {n} item(s) used in degraded form (e.g. abstract only): {reasons}",
        "api.read_materials.none_usable": "None of the selected materials has usable body content",
        "api.read_materials.all_failed": "No candidate material could be read: {reasons}",
        # Answer generation
        "api.answer.no_material_notice":
            "No citable material is available right now (no paper is open, the context library is "
            "empty, and no readable literature was retrieved). The answer below is generated from the "
            "AI's general knowledge without source verification — please judge it carefully. Open a "
            "paper or add context to get a source-grounded answer.",
        "api.answer.no_material_with_note":
            "The material could not be read ({note}). The answer below cites no literature and is "
            "generated from the AI's general knowledge; please judge it carefully. Try refreshing the "
            "paper's PDF or adding context.",
        "api.answer.no_passages_notice":
            "The available material contains no parseable body passages ({note}). The answer below is "
            "generated from the AI's general knowledge; please judge it carefully.",
        # Fallback material display names
        "api.material_label.paper": "Paper",
        "api.material_label.document": "Current document",
        "api.material_label.candidate": "Candidate paper",
        # Search
        "api.search.missing_query": "Missing search criteria: provide q, or one of title/abstract/keywords/author/fulltext",
        "api.search.structured_empty": "Structured search requires at least one of title/abstract/keywords/author/fulltext",
        # Full text / PDF
        "api.fulltext.local_parse_failed": "Unable to parse the full text of this local paper (it may not be a valid PDF)",
        "api.fulltext.unavailable": "Unable to retrieve the full text of this paper (the PDF may not be openly available)",
        "api.pdf.not_available": "No downloadable PDF is available for this paper",
        "api.pdf.download_failed": "Failed to download the paper PDF: {reason}",
        # RAG question params
        "api.rag.missing_paper_id": "Missing paper_id",
        "api.rag.missing_question": "Missing question",
        "api.rag.no_evidence": "The question is unrelated to both the current paper and the context library; no evidence was found to answer it",
        # state / notes / context library / data blocks
        "api.title_required": "title cannot be empty",
        "api.state.invalid": "state must be a JSON object",
        "api.chat_title.empty": "query cannot be empty",
        "api.note.empty": "Note content cannot be empty",
        "api.context.invalid_type": "type must be one of paper/url",
        "api.context.paper_requires_id": "paper type requires paper_id",
        "api.context.url_requires_url": "url type requires url",
        "api.context.fetch_failed": "Failed to fetch the webpage: {exc}",
        "api.context.refetch_failed": "Failed to re-fetch the webpage: {exc}",
        "api.context.not_found": "Context not found",
        "api.context.tags_must_be_array": "tags must be an array",
        "api.data_block.invalid_type": "type must be one of chart/table/equation/text",
    },
}
