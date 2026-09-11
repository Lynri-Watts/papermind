"""``pdf`` 命名空间文案：PDF 下载与全文解析
（``providers/download.py``、``services/fulltext.py``）。

覆盖：HTTP 状态对应的取不到 PDF 的具体原因、网络重试耗尽、
PDF 解析/文字层缺失原因、全文三级缓存的失败说明。
"""
from __future__ import annotations

MESSAGES: dict[str, dict[str, str]] = {
    "zh": {
        # 下载层（providers/download.py）：内容/状态码/网络
        "pdf.not_a_pdf": "下载到的内容不是有效 PDF（宿主可能返回了网页错误页）",
        "pdf.http_401": "PDF 需要登录或访问凭证",
        "pdf.http_403": "PDF 访问受限（需要登录或订阅权限）",
        "pdf.http_404": "PDF 地址不存在或论文已被移除",
        "pdf.http_410": "PDF 地址已失效",
        "pdf.http_rejected": "下载被服务器拒绝（HTTP {code}）",
        "pdf.network_retry_exhausted": "网络连接失败，多次重试后仍无法下载",
        # PdfDownloadError 消息里拼在 reason 后的 URL 后缀
        "pdf.url_suffix": "（{url}）",
        # 全文服务（services/fulltext.py）：标识解析/本地/缓存/远程
        "pdf.identifier_empty": "论文标识为空",
        "pdf.identifier_unrecognized": "无法把「{text}」识别为论文的稳定唯一标识（支持 DOI、arXiv 编号或带前缀 id）",
        "pdf.invalid_doi": "「{doi}」不是合法的 DOI",
        "pdf.local_pdf_missing": "本地工作区中未找到该 PDF（文件可能已被删除，或不是有效 PDF）",
        "pdf.parse_failed": "PDF 无法打开/解析（文件可能损坏，或格式不受支持）",
        "pdf.no_text_layer": "PDF 没有文字层（可能为扫描版/图片型 PDF），无法提取全文",
        "pdf.cache_corrupt_redownload_failed": "本地缓存的 PDF 已损坏无法解析，重新下载也未成功：{reason}",
        "pdf.unknown_reason": "未知原因",
        "pdf.invalid_paper_id_format": "论文 id 格式无法识别（应为 source:external_id）",
        "pdf.metadata_fetch_failed": "获取论文元数据失败：{exc}",
        "pdf.no_pdf_available": "该论文在 {source} 数据源未提供可下载的 PDF（未开放全文）",
        "pdf.download_failed": "PDF 下载失败：{exc}",
        "pdf.downloaded_parse_failed": "PDF 已下载但无法打开/解析（文件可能损坏，或格式不受支持）",
        "pdf.downloaded_no_text_layer": "PDF 已下载但没有文字层（可能为扫描版/图片型 PDF），无法提取全文",
    },
    "en": {
        # Download layer (providers/download.py): content / status code / network
        "pdf.not_a_pdf": "Downloaded content is not a valid PDF (the host may have returned a web error page)",
        "pdf.http_401": "PDF requires sign-in or access credentials",
        "pdf.http_403": "PDF access restricted (sign-in or subscription required)",
        "pdf.http_404": "PDF address not found or the paper has been removed",
        "pdf.http_410": "PDF address is no longer available",
        "pdf.http_rejected": "Download rejected by the server (HTTP {code})",
        "pdf.network_retry_exhausted": "Network connection failed; still unable to download after multiple retries",
        # URL suffix appended after reason in the PdfDownloadError message
        "pdf.url_suffix": " ({url})",
        # Full-text service (services/fulltext.py): identifier / local / cache / remote
        "pdf.identifier_empty": "Paper identifier is empty",
        "pdf.identifier_unrecognized": "Cannot recognize “{text}” as a stable unique identifier for the paper (supports DOI, arXiv ID, or a prefixed id)",
        "pdf.invalid_doi": "“{doi}” is not a valid DOI",
        "pdf.local_pdf_missing": "The PDF was not found in the local workspace (the file may have been deleted, or is not a valid PDF)",
        "pdf.parse_failed": "PDF cannot be opened/parsed (the file may be corrupt or the format is unsupported)",
        "pdf.no_text_layer": "The PDF has no text layer (possibly a scanned/image-based PDF), so full text cannot be extracted",
        "pdf.cache_corrupt_redownload_failed": "The locally cached PDF is corrupt and could not be parsed, and re-downloading also failed: {reason}",
        "pdf.unknown_reason": "Unknown reason",
        "pdf.invalid_paper_id_format": "Unrecognized paper id format (expected source:external_id)",
        "pdf.metadata_fetch_failed": "Failed to fetch paper metadata: {exc}",
        "pdf.no_pdf_available": "The paper has no downloadable PDF from the {source} source (full text not openly available)",
        "pdf.download_failed": "PDF download failed: {exc}",
        "pdf.downloaded_parse_failed": "The PDF was downloaded but cannot be opened/parsed (the file may be corrupt or the format is unsupported)",
        "pdf.downloaded_no_text_layer": "The PDF was downloaded but has no text layer (possibly a scanned/image-based PDF), so full text cannot be extracted",
    },
}
