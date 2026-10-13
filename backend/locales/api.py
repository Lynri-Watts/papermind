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
        "api.tool_label.read_context": "读取上下文材料",
        "api.tool_label.list_files": "列出工作区文件",
        "api.tool_label.read_file": "读取文稿",
        "api.tool_label.edit_file": "编辑文稿",
        "api.tool_label.create_file": "新建文稿",
        "api.tool_label.add_bib_entries": "加入 BibTeX 引用",
        "api.tool_label.compile_document": "编译文稿",
        "api.tool_label.list_mindmaps": "列出思维导图",
        "api.tool_label.create_mindmap": "新建思维导图",
        "api.tool_label.read_mindmap": "读取思维导图",
        "api.tool_label.edit_mindmap": "编辑思维导图",
        "api.tool_label.attach_paper_to_mindmap": "论文加入导图",
        # 列表 / 省略拼接
        "api.separator.list": "、",
        # SSE 阶段与错误提示
        "api.stopped": "已停止生成",
        "api.stage.thinking_next": "AI 正在思考下一步...",
        "api.stage.thought_failed": "思考过程出错，将基于已有材料回答：{exc}",
        "api.stage.unknown_tool": "AI 请求了未知工具 {name}，已停止工具循环",
        "api.stage.no_progress": "AI 连续请求同一工具，判定无进展，停止工具循环...",
        "api.stage.preparing_material": "正在整理材料...",
        "api.stage.generating": "正在生成回答...",
        "api.stage.mindmap_filling": "检测到新建导图尚未填充，AI 正在补全导图节点...",
        # 导图轮次兜底：create 后未填充即达到轮次上限 / 提前 READY 时的系统提醒
        "api.mindmap.fill_reminder":
            "系统提醒：你本轮新建的思维导图「{titles}」目前只有根节点，尚未填充任何"
            "内容，不能就这样交付给用户。请立即继续完成：在接下来最多 {turns} 个工具"
            "步骤内，用 edit_mindmap 批量添加完整的分支与子节点（内容必须基于本轮已"
            "检索/阅读的材料和用户问题）；若结构已在你心中成型，也可用 from_mermaid "
            "一次重建成完整导图。不要再次创建空白导图，不要删除重建，也不要用文字版"
            "思维导图代替。导图填充完成后再回复 READY。",
        # 最终回答可见的导图工具成果（以 DB 最终状态为准）
        "api.mindmap.finding_skeleton":
            "本轮 create_mindmap 新建了思维导图「{title}」（id: {map_id}），但截至工具"
            "循环结束它仍只有根节点、没有任何分支（edit_mindmap 填充未完成或未执行）。"
            "必须如实告知用户该导图已创建但尚未填充，不得谎称导图已完成，也不要再画"
            "文字版思维导图；可以提议让用户确认后继续补全。",
        "api.mindmap.finding_filled":
            "本轮思维导图工具已成功创建/更新导图「{title}」（id: {map_id}），当前共有 "
            "{nodes} 个节点，导图已在思维导图视图中就绪。回答中用一句话告知用户导图已"
            "生成即可，严禁再用 Markdown 列表/缩进/符号画一张文字版思维导图来代替它。",
        "api.tool_exec_failed": "{tool_label} 执行失败: {exc}",
        "api.rag.failed": "RAG 问答失败: {exc}",
        # 上下文条目读取失败原因（工具层共用）
        "api.reason.no_usable_content": "没有可用的正文内容",
        "api.read_fail.context_gone": "上下文项 #{sid}：已不存在，可能被删除",
        # 回答生成
        "api.answer.no_material_notice":
            "本轮没有读到可用于回答的材料（AI 未读取当前论文或上下文条目，也未检索到"
            "可读文献）。以下回答由 AI 基于通用知识生成，未经材料核实，请注意甄别；"
            "打开论文、把材料加入上下文库或明确要求 AI 阅读后，即可获得有据可依的回答。",
        "api.answer.no_passages_notice":
            "已有材料中没有可解析的正文段落（{note}）。以下回答由 AI 基于通用知识生成，请注意甄别。",
        # 材料兜底展示名
        "api.material_label.paper": "论文",
        "api.material_label.document": "当前文档",
        "api.material_label.candidate": "候选论文",
        "api.material_label.user_quote": "用户选中片段",
        "api.material_label.user_quote_paged": "用户选中片段·第{page}页",
        # 搜索
        "api.search.missing_query": "缺少搜索条件：请提供 q，或 title/abstract/keywords/author/fulltext 之一",
        "api.search.structured_empty": "结构化搜索至少需要指定 title/abstract/keywords/author/fulltext 之一",
        # 全文 / PDF
        "api.fulltext.local_parse_failed": "该本地文献无法解析全文（可能不是有效 PDF）",
        "api.fulltext.unavailable": "该论文无法获取全文（可能不开放 PDF）",
        "api.pdf.not_available": "该论文没有可下载的 PDF",
        "api.pdf.download_failed": "无法下载该论文的 PDF：{reason}",
        # RAG 问答参数
        "api.rag.missing_question": "缺少 question",
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
        "api.tool_label.read_context": "Read context material",
        "api.tool_label.list_files": "List workspace files",
        "api.tool_label.read_file": "Read document",
        "api.tool_label.edit_file": "Edit document",
        "api.tool_label.create_file": "Create document",
        "api.tool_label.add_bib_entries": "Add BibTeX entries",
        "api.tool_label.compile_document": "Compile document",
        "api.tool_label.list_mindmaps": "List mind maps",
        "api.tool_label.create_mindmap": "Create mind map",
        "api.tool_label.read_mindmap": "Read mind map",
        "api.tool_label.edit_mindmap": "Edit mind map",
        "api.tool_label.attach_paper_to_mindmap": "Attach paper to mind map",
        # List joining
        "api.separator.list": ", ",
        # SSE stages and error hints
        "api.stopped": "Generation stopped",
        "api.stage.thinking_next": "AI is thinking about the next step...",
        "api.stage.thought_failed": "Error during reasoning; answering from existing material: {exc}",
        "api.stage.unknown_tool": "AI requested an unknown tool {name}; stopping the tool loop",
        "api.stage.no_progress": "AI requested the same tool repeatedly with no progress; stopping the tool loop...",
        "api.stage.preparing_material": "Preparing material...",
        "api.stage.generating": "Generating answer...",
        "api.stage.mindmap_filling": "Newly created mind map is still empty; AI is filling its nodes...",
        # Mindmap turn-budget safety net: reminder when create happened but the
        # loop hit its turn cap (or READY) before any edit filled the map
        "api.mindmap.fill_reminder":
            "System reminder: the mind map you created this turn, \u201c{titles}\u201d, "
            "currently contains ONLY its root node and no branches — it cannot be "
            "delivered like this. Finish it now: within at most {turns} more tool "
            "steps, use edit_mindmap to add complete branches and child nodes in "
            "batch (grounded strictly in the materials retrieved/read this turn and "
            "in the user's request); if the structure is already clear in your mind, "
            "you may rebuild it fully in one shot with from_mermaid. Do NOT create "
            "another empty map, do not delete and recreate it, and do not substitute "
            "a text-based mind map. Reply READY only after the map is filled.",
        # Mindmap tool outcome visible to the final answer (DB state is authoritative)
        "api.mindmap.finding_skeleton":
            "create_mindmap created the mind map \u201c{title}\u201d (id: {map_id}) this "
            "turn, but by the end of the tool loop it still has only a root node and "
            "no branches (edit_mindmap filling was not completed or not executed). "
            "You must honestly tell the user the map was created but is not yet "
            "filled in; do not claim it is complete, do not draw a text-based mind "
            "map instead, and offer to fill it on the user's confirmation.",
        "api.mindmap.finding_filled":
            "The mindmap tools successfully created/updated the mind map "
            "\u201c{title}\u201d (id: {map_id}) this turn; it now contains {nodes} nodes "
            "and is ready in the mindmap view. Tell the user in one sentence that "
            "the map is ready; NEVER replace it with a Markdown/indented/text tree.",
        "api.tool_exec_failed": "{tool_label} failed: {exc}",
        "api.rag.failed": "RAG Q&A failed: {exc}",
        # Context item read failure reasons (shared by the tool layer)
        "api.reason.no_usable_content": "No usable body content",
        "api.read_fail.context_gone": "Context item #{sid}: no longer exists; it may have been deleted",
        # Answer generation
        "api.answer.no_material_notice":
            "No usable material was read this turn (the AI did not read the current paper or "
            "context items, and no readable literature was retrieved). The answer below is "
            "generated from the AI's general knowledge without source verification — please judge "
            "it carefully. Open a paper, add material to the context library, or explicitly ask the "
            "AI to read it to get a source-grounded answer.",
        "api.answer.no_passages_notice":
            "The available material contains no parseable body passages ({note}). The answer below is "
            "generated from the AI's general knowledge; please judge it carefully.",
        # Fallback material display names
        "api.material_label.paper": "Paper",
        "api.material_label.document": "Current document",
        "api.material_label.candidate": "Candidate paper",
        "api.material_label.user_quote": "highlighted excerpt",
        "api.material_label.user_quote_paged": "highlighted excerpt · p.{page}",
        # Search
        "api.search.missing_query": "Missing search criteria: provide q, or one of title/abstract/keywords/author/fulltext",
        "api.search.structured_empty": "Structured search requires at least one of title/abstract/keywords/author/fulltext",
        # Full text / PDF
        "api.fulltext.local_parse_failed": "Unable to parse the full text of this local paper (it may not be a valid PDF)",
        "api.fulltext.unavailable": "Unable to retrieve the full text of this paper (the PDF may not be openly available)",
        "api.pdf.not_available": "No downloadable PDF is available for this paper",
        "api.pdf.download_failed": "Failed to download the paper PDF: {reason}",
        # RAG question params
        "api.rag.missing_question": "Missing question",
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
