"""「AI 写作工具组」文案：工具回执（面向 LLM）与写作审核 REST 消息。"""
from __future__ import annotations

MESSAGES = {
    "zh": {
        # 工具：环境/参数
        "writing.no_workspace": "当前没有打开写作工作区（请先在写作页面中打开一个工作区再提问）。",
        "writing.workspace_missing": "写作工作区不存在或已被删除。",
        "writing.bad_path": "文件路径非法：只允许工作区内的相对路径（POSIX 风格，不得含 .. 或盘符）。",
        "writing.ext_not_allowed": "AI 写作工具只允许操作 {allowed} 类型的文件，收到：{path}",
        "writing.file_exists": "文件已存在：{path}（create_file 不覆盖已有文件；如要修改请用 edit_file）。",
        "writing.file_not_found": "文件不存在：{path}（先用 list_files 确认路径，或用 create_file 新建）。",
        "writing.main_missing": "工作区中没有 main.tex，已自动创建骨架。",

        # read_file
        "writing.read_header": "== {path}（共 {total} 行，hash={hash}） ==",
        "writing.read_range": "当前显示第 {start}-{end} 行；需要其他区段时带 start_line/end_line 再读。",
        "writing.range_bad": "行号范围非法（文件共 {total} 行）：{start}-{end}",
        "writing.range_too_large": "请求区段过大（超过 {limit} 字符），请缩小 start_line/end_line 范围。",

        # list_files
        "writing.list_header": "工作区文本文件（共 {n} 个；不含 PDF/辅助产物）：",
        "writing.list_empty": "工作区中还没有文本文件（main.tex 将在首次读取时自动创建）。",

        # edit_file
        "writing.actions_empty": "actions 必须是非空数组。",
        "writing.actions_limit": "单批最多 {limit} 个动作，收到 {count} 个；请拆成多批。",
        "writing.block_too_large": "old/new 单块不得超过 {limit} 字符。",
        "writing.hash_mismatch": "文件版本与你读取时不一致（expect_hash 不匹配）：文件在你读取后已被改动。"
                                 "请重新 read_file 获取最新内容与 hash 后再编辑。",
        "writing.edit_done": "已对 {path} 应用 {count} 处修改并写盘，新 hash={hash}。"
                             "修改已在编辑器中高亮待审，用户可逐块接受或拒绝；"
                             "你无需重复读取即可继续后续编辑。",
        "writing.failures_header": "整批 {count} 个动作均未写入（原子保护）。请按下列信息修正后整批重试：",
        "writing.fail_not_found": "动作 {index}：old/anchor 在文件中零命中。"
                                  "请核对是否与文件逐字一致（含标点与缩进）；"
                                  "相似内容可能在第 {candidates} 行附近，可读取确认后扩大锚点上下文。",
        "writing.fail_not_found_no_hint": "动作 {index}：old/anchor 在文件中零命中，"
                                          "请重新 read_file 核对原文后使用更长、更唯一的锚点。",
        "writing.fail_multiple": "动作 {index}：old/anchor 在第 {lines} 行出现 {count} 次（非唯一）。"
                                 "请把锚点向前后扩展到只匹配一处的唯一片段。",
        "writing.fail_empty": "动作 {index}：old/anchor 为空或纯空白。",
        "writing.fail_same": "动作 {index}：old 与 new 完全相同（无实际修改）。",

        # create_file
        "writing.create_done": "已新建 {path}（{lines} 行，hash={hash}）。",
        "writing.input_done": "已在 main.tex 中加入 \\input{{{name}}}。",

        # add_bib_entries
        "writing.paper_not_found": "论文不存在或不可见：{paper_id}（请先 paper_search 确认 id）。",
        "writing.bib_added": "已向 {bib} 追加 {count} 条 BibTeX：{keys}",
        "writing.bib_dup": "重复跳过：{paper_id}（{reason}）",
        "writing.bib_wired": "已在 main.tex 接入文献资源：{detail}",
        "writing.bib_anchor_missing": "无法把 {bib} 接入 main.tex：找不到 {anchor} 锚点，请先修正文档结构。",
        "writing.bib_none": "没有可追加的新条目（全部已存在于 {bib}）。cite key 需要用 read_file 打开该文件确认。",

        # compile_document
        "writing.compile_ok": "编译成功：main.pdf 已生成（{passes} 趟）。",
        "writing.compile_failed": "编译失败，共解析出 {count} 处错误（已同步到前端编译面板）。"
                                  "请按 file:line 定位，用 edit_file 修正后重新编译。错误清单：\n{errors}",
        "writing.compile_engine_missing": "本机未检测到 xelatex，无法编译（请安装 TeX Live / MiKTeX）。",
        "writing.compile_log_hint": "日志尾部：\n{log}",

        # REST：审核/回滚
        "writing.rev_not_found": "写作修订不存在：{rev_id}",
        "writing.rev_wrong_scope": "该修订不属于当前工作区。",
        "writing.rev_not_pending": "该修订已处理（{status}），不能重复操作。",
        "writing.rev_stale": "该修改处已发生变化（锚点不唯一或已被改动），无法干净还原；"
                             "如需恢复请手动编辑。",
        "writing.rollback_done": "已回滚本次 AI 写作的 {count} 处修改。",
        "writing.rollback_empty": "该写作事务没有可回滚的待处理修改。",
        "writing.rollback_conflict": "回滚在第 {seq} 处（{path}）遇到冲突：该处已被后续改动，"
                                     "已完成前 {done} 处回滚并在此停止，请手动检查剩余部分。",
        "writing.rollback_txn_undone": "该写作事务已经回滚过，不能重复回滚。",
        "writing.rollback_kept_file": "文件 {path} 创建后又被修改，未删除（仅还原其中可识别的修改）。",
    },
    "en": {
        "writing.no_workspace": "No writing workspace is currently open (open one in the writing page before asking).",
        "writing.workspace_missing": "The writing workspace does not exist or has been deleted.",
        "writing.bad_path": "Invalid file path: only workspace-relative POSIX paths are allowed (no .. or drive letters).",
        "writing.ext_not_allowed": "Writing tools may only operate on {allowed} files; got: {path}",
        "writing.file_exists": "File already exists: {path} (create_file never overwrites; use edit_file to modify).",
        "writing.file_not_found": "File not found: {path} (check with list_files first, or create_file).",
        "writing.main_missing": "main.tex did not exist in the workspace; a skeleton was created.",

        "writing.read_header": "== {path} ({total} lines, hash={hash}) ==",
        "writing.read_range": "Showing lines {start}-{end}; pass start_line/end_line to read other ranges.",
        "writing.range_bad": "Bad line range (file has {total} lines): {start}-{end}",
        "writing.range_too_large": "Requested range is too large (over {limit} chars); narrow start_line/end_line.",

        "writing.list_header": "Workspace text files ({n}; PDF/build artifacts excluded):",
        "writing.list_empty": "No text files in the workspace yet (main.tex is created on first read).",

        "writing.actions_empty": "actions must be a non-empty array.",
        "writing.actions_limit": "At most {limit} actions per call, got {count}; split into multiple calls.",
        "writing.block_too_large": "Each old/new block must not exceed {limit} chars.",
        "writing.hash_mismatch": "The file changed since you read it (expect_hash mismatch). "
                                 "Re-call read_file for the latest content and hash, then edit again.",
        "writing.edit_done": "Applied {count} edit(s) to {path} and saved; new hash={hash}. "
                             "Edits are highlighted in the editor pending review (the user can "
                             "accept/reject each hunk); continue editing without re-reading.",
        "writing.failures_header": "None of the {count} actions were written (atomic guard). Fix and retry the whole batch:",
        "writing.fail_not_found": "Action {index}: old/anchor not found (0 match). Check it is verbatim "
                                  "(punctuation/indentation included); similar text may be near lines "
                                  "{candidates} — read and widen the anchor context.",
        "writing.fail_not_found_no_hint": "Action {index}: old/anchor not found (0 match). Re-read the "
                                          "file and use a longer, unique anchor.",
        "writing.fail_multiple": "Action {index}: old/anchor matches {count} times at lines {lines}. "
                                 "Extend the anchor until it matches exactly one place.",
        "writing.fail_empty": "Action {index}: old/anchor is empty or whitespace.",
        "writing.fail_same": "Action {index}: old and new are identical (no change).",

        "writing.create_done": "Created {path} ({lines} lines, hash={hash}).",
        "writing.input_done": "Added \\input{{{name}}} to main.tex.",

        "writing.paper_not_found": "Paper not found or not visible: {paper_id} (confirm the id with paper_search).",
        "writing.bib_added": "Appended {count} BibTeX entr(y/ies) to {bib}: {keys}",
        "writing.bib_dup": "Skipped duplicate: {paper_id} ({reason})",
        "writing.bib_wired": "Wired the bibliography resource into main.tex: {detail}",
        "writing.bib_anchor_missing": "Cannot wire {bib} into main.tex: anchor {anchor} not found; fix the document structure first.",
        "writing.bib_none": "No new entries to append (all already in {bib}). Use read_file on it to find cite keys.",

        "writing.compile_ok": "Compilation succeeded: main.pdf generated ({passes} pass(es)).",
        "writing.compile_failed": "Compilation failed with {count} parsed error(s) (also shown in the "
                                  "front-end panel). Locate via file:line, fix with edit_file, then "
                                  "compile again. Errors:\n{errors}",
        "writing.compile_engine_missing": "xelatex was not found on this machine; install TeX Live / MiKTeX.",
        "writing.compile_log_hint": "Log tail:\n{log}",

        "writing.rev_not_found": "Writing revision not found: {rev_id}",
        "writing.rev_wrong_scope": "That revision does not belong to the current workspace.",
        "writing.rev_not_pending": "That revision was already handled ({status}).",
        "writing.rev_stale": "The edited region has changed (anchor no longer unique/intact); "
                             "it cannot be cleanly reverted. Please edit manually.",
        "writing.rollback_done": "Reverted {count} change(s) from this AI writing run.",
        "writing.rollback_empty": "Nothing pending to roll back in that writing transaction.",
        "writing.rollback_conflict": "Rollback hit a conflict at seq {seq} ({path}): the region was "
                                     "changed later. {done} earlier change(s) were reverted; stopped "
                                     "here — please inspect the rest manually.",
        "writing.rollback_txn_undone": "That writing transaction has already been rolled back.",
        "writing.rollback_kept_file": "{path} was modified after creation; it was kept (only identifiable edits inside were reverted).",
    },
}
