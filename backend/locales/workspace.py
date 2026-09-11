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
        "workspace.content_required": "缺少 content",
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
        "workspace.content_required": "Missing content",
    },
}
