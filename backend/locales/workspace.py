"""``workspace`` 命名空间文案：工作区路由与安全文件层
（``routes/workspaces.py``、``storage/workspace.py``）。

覆盖：工作区增删改查校验错误、路径校验错误、上传文件类型校验错误。
"""
from __future__ import annotations

MESSAGES: dict[str, dict[str, str]] = {
    "zh": {
        # 工作区标识与路径校验
        "workspace.invalid_id": "非法的工作区标识",
        "workspace.invalid_segment": "非法路径段: {segment}",
        "workspace.segment_too_long": "路径段过长",
        "workspace.path_escape": "路径越界：不允许访问工作区目录之外的文件",
        # 工作区元数据
        "workspace.create_conflict": "工作区创建失败：标识冲突，请重试",
        "workspace.not_found": "工作区不存在",
        "workspace.name_required": "工作区名称不能为空",
        # 文件读写
        "workspace.file_not_found": "文件不存在: {rel_path}",
        "workspace.unique_name_failed": "无法生成唯一文件名",
        # 路由层
        "workspace.internal_error": "服务内部错误: {err}",
        "workspace.upload_file_missing": "缺少上传文件（字段名 file）",
        "workspace.filename_no_path": "不允许带路径的文件名，请使用纯文件名",
        "workspace.unsupported_file_type": "不支持的文件类型: {ext}（支持 {exts}）",
        "workspace.not_a_pdf": "文件内容不是有效的 PDF",
        "workspace.content_required": "缺少 content",
        "workspace.text_ext_required": "仅可新建/编辑文本文件（支持 {exts}），二进制文件请使用上传",
        "workspace.main_tex_protected": "main.tex 是固定编译入口，不能删除（可清空内容后重写）",
        # LaTeX 编译
        "workspace.compile.missing_engine": "未找到 xelatex 可执行文件，请先安装 TeX 发行版（如 TeX Live 或 MiKTeX）",
        "workspace.compile.launch_failed": "编译器启动失败: {err}",
        "workspace.compile.pass_timeout": "单趟 xelatex 超时（超过 {seconds} 秒），请检查文档是否存在死循环",
        "workspace.compile.failed": "编译失败，请查看日志定位错误",
        "workspace.compile.ok": "编译成功",
        # SyncTeX 反向定位（双击 PDF 跳源码）
        "workspace.synctex.bad_params": "SyncTeX 参数不合法：需要 page（≥1 的整数）与 x/y（≥0 的数字）",
        "workspace.synctex.no_data": "缺少 SyncTeX 数据：请先成功编译文档后再双击 PDF",
        "workspace.synctex.missing_tool": "未找到 synctex 可执行文件，请确认 TeX 发行版已完整安装（MiKTeX/TeX Live 均自带）",
        "workspace.synctex.timeout": "SyncTeX 反向定位超时（超过 {seconds} 秒）",
        "workspace.synctex.launch_failed": "synctex 启动失败: {err}",
        "workspace.synctex.no_match": "该位置未能匹配到源码（可尝试点击正文文字处）",
        "workspace.synctex.outside": "SyncTeX 结果指向工作区之外的文件，已拒绝",
        "workspace.synctex.source_missing": "SyncTeX 指向的源文件不存在: {path}",
    },
    "en": {
        # Workspace id and path validation
        "workspace.invalid_id": "Invalid workspace id",
        "workspace.invalid_segment": "Invalid path segment: {segment}",
        "workspace.segment_too_long": "Path segment too long",
        "workspace.path_escape": "Path escape: access outside the workspace directory is not allowed",
        # Workspace metadata
        "workspace.create_conflict": "Failed to create workspace: id conflict, please retry",
        "workspace.not_found": "Workspace not found",
        "workspace.name_required": "Workspace name cannot be empty",
        # File read/write
        "workspace.file_not_found": "File not found: {rel_path}",
        "workspace.unique_name_failed": "Unable to generate a unique file name",
        # Route layer
        "workspace.internal_error": "Internal server error: {err}",
        "workspace.upload_file_missing": "Missing uploaded file (field name: file)",
        "workspace.filename_no_path": "File names containing a path are not allowed; use a plain file name",
        "workspace.unsupported_file_type": "Unsupported file type: {ext} (supported: {exts})",
        "workspace.not_a_pdf": "The file content is not a valid PDF",
        "workspace.content_required": "Missing content",
        "workspace.text_ext_required": "Only text files can be created/edited online ({exts}); upload binary files instead",
        "workspace.main_tex_protected": "main.tex is the fixed compile entry and cannot be deleted (you may clear and rewrite it)",
        # LaTeX compile
        "workspace.compile.missing_engine": "xelatex was not found. Please install a TeX distribution (TeX Live or MiKTeX)",
        "workspace.compile.launch_failed": "Failed to launch the compiler: {err}",
        "workspace.compile.pass_timeout": "A single xelatex pass timed out (exceeded {seconds}s); check for loops in the document",
        "workspace.compile.failed": "Compilation failed; see the log for details",
        "workspace.compile.ok": "Compilation succeeded",
        # SyncTeX inverse search (double-click PDF to jump to source)
        "workspace.synctex.bad_params": "Invalid SyncTeX parameters: page (positive integer) and x/y (non-negative numbers) are required",
        "workspace.synctex.no_data": "SyncTeX data is missing: compile the document successfully before double-clicking the PDF",
        "workspace.synctex.missing_tool": "The synctex executable was not found. Make sure your TeX distribution (MiKTeX/TeX Live) is fully installed",
        "workspace.synctex.timeout": "SyncTeX inverse search timed out (exceeded {seconds}s)",
        "workspace.synctex.launch_failed": "Failed to launch synctex: {err}",
        "workspace.synctex.no_match": "No source location matches this point (try double-clicking on the body text)",
        "workspace.synctex.outside": "SyncTeX resolved to a file outside the workspace; rejected",
        "workspace.synctex.source_missing": "The source file reported by SyncTeX does not exist: {path}",
    },
}
