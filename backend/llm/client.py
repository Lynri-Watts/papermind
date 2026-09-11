"""LLM 兼容层客户端。

仅依赖 OpenAI 格式（base_url + api_key + chat.completions），
因此任何兼容服务（OpenAI / DeepSeek / 智谱 / Moonshot 等）均可接入。

key 由用户经前端「设置」页填写（持久化在后端本地数据库 app_settings 表），
绝不进入前端存储或代码仓库。
配置在**每次新建客户端时**从 settings_store 读取，因此界面改完即生效。
"""
from __future__ import annotations

import json
from typing import Optional

import settings_store
from i18n import tr


class LLMNotConfiguredError(RuntimeError):
    """LLM key 未配置时抛出。"""


class LLMClient:
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None,
                 model: Optional[str] = None) -> None:
        """未显式传入的参数取「设置」页保存的当前值（app_settings 表）。"""
        cfg = settings_store.llm_config()
        base_url = base_url or cfg["base_url"]
        api_key = cfg["api_key"] if api_key is None else api_key
        model = model or cfg["model"]
        if not api_key:
            raise LLMNotConfiguredError(tr("rag.llm_not_configured"))
        # 延迟导入，避免未配置 key 时 openai 包报错
        from openai import OpenAI

        self._client = OpenAI(base_url=base_url, api_key=api_key, timeout=cfg["timeout"])
        self._model = model

    def chat(self, messages: list[dict], model: Optional[str] = None,
             temperature: float = 0.3) -> dict:
        """统一的 chat 接口。

        :param messages: [{"role": "system"|"user"|"assistant", "content": str}, ...]
        :returns: {"content": str, "usage": {"prompt_tokens": int, "completion_tokens": int}}
        """
        resp = self._client.chat.completions.create(
            model=model or self._model,
            messages=messages,
            temperature=temperature,
        )
        usage = resp.usage
        return {
            "content": resp.choices[0].message.content or "",
            "usage": {
                "prompt_tokens": getattr(usage, "prompt_tokens", None),
                "completion_tokens": getattr(usage, "completion_tokens", None),
            },
        }

    def chat_stream(self, messages: list[dict], model: Optional[str] = None,
                    temperature: float = 0.3):
        """流式 chat：逐段 yield 文本增量（用于 SSE 流式输出中间过程）。

        :param messages: 同 :meth:`chat`
        :yields: 回答的文本增量（str）；跳过空增量
        """
        stream = self._client.chat.completions.create(
            model=model or self._model,
            messages=messages,
            temperature=temperature,
            stream=True,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            text = getattr(delta, "content", None)
            if text:
                yield text

    def chat_stream_tool_call(self, messages: list[dict], tools: Optional[list[dict]] = None,
                              model: Optional[str] = None, temperature: float = 0.0):
        """流式 ReAct 单步决策：边生成边输出"思考"文字，结束时给出是否请求工具。

        OpenAI 兼容接口允许模型在同一回合内**先写一段内容（这里引导为"思考"）
        再请求工具调用**（assistant.content + tool_calls）。本方法把内容增量实时
        yield 给上层展示（用户可见 AI 在想什么），并在流结束时把工具调用解析出来。

        :param messages: 同 :meth:`chat`
        :param tools: OpenAI tools schema；None 表示不带工具
        :yields: dict 事件：
            {"type": "thought", "delta": str}    思考文本增量（边生成边输出）
            {"type": "decision", "tool": {"name","arguments"}|None, "thought": str}
                流结束：tool=None 表示不再需要工具（直接进入回答）；
                否则为请求的下一个工具（本实现只取第一个完整工具调用）
        """
        kwargs: dict = {
            "model": model or self._model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
        }
        if tools:
            kwargs["tools"] = tools
        stream = self._client.chat.completions.create(**kwargs)

        thought_parts: list[str] = []
        tool_acc: dict[int, dict] = {}

        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if content:
                thought_parts.append(content)
                yield {"type": "thought", "delta": content}
            for tc in (getattr(delta, "tool_calls", None) or []):
                cur = tool_acc.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                if getattr(tc, "id", None):
                    cur["id"] = tc.id
                if tc.function:
                    if tc.function.name:
                        cur["name"] += tc.function.name
                    if tc.function.arguments:
                        cur["arguments"] += tc.function.arguments

        thought = "".join(thought_parts)
        # 取第一个带完整名称的工具调用（多工具并行请求不在本项目交互语义内）
        for _, tc in sorted(tool_acc.items()):
            if tc.get("name"):
                try:
                    arguments = json.loads(tc["arguments"] or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                yield {
                    "type": "decision",
                    "tool": {"name": tc["name"], "arguments": arguments,
                             "call_id": tc.get("id") or ""},
                    "thought": thought,
                }
                return
        yield {"type": "decision", "tool": None, "thought": thought}
