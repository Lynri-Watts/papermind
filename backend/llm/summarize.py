"""文本摘要工具：LLM 生成 + 无 key / 失败时降级截取。"""
from __future__ import annotations

from llm.client import LLMClient

FALLBACK_SUMMARY_CHARS = 500
LLM_SUMMARY_MAX_CHARS = 400
LLM_INPUT_CHARS = 8000


def truncate_summary(text: str, limit: int = FALLBACK_SUMMARY_CHARS) -> str:
    """降级摘要：取正文开头并截断。"""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def summarize_text(client: LLMClient, text: str, title: str = "") -> str:
    """用 LLM 生成中文摘要；LLM 失败时降级为截取开头。

    :returns: 摘要字符串（不超过 LLM_SUMMARY_MAX_CHARS 字符）
    """
    if not text:
        return ""
    try:
        source = f"标题: {title}\n\n内容:\n{text[:LLM_INPUT_CHARS]}" if title else f"内容:\n{text[:LLM_INPUT_CHARS]}"
        result = client.chat(
            messages=[
                {"role": "system", "content": (
                    "你是学术研究助手。请为给定内容生成一段简洁的中文摘要，"
                    f"控制在 {LLM_SUMMARY_MAX_CHARS} 字以内，突出核心观点与可复用价值，"
                    "不要输出标题或编号。"
                )},
                {"role": "user", "content": source},
            ],
            temperature=0.3,
        )
        summary = result["content"].strip()
        if summary:
            return summary[:LLM_SUMMARY_MAX_CHARS]
    except Exception:
        # LLM 不可用不阻塞导入，降级截取
        pass
    return truncate_summary(text)
