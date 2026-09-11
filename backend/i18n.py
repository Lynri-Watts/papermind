"""后端多语言运行时（中 / 英）。

前端在每次请求携带 ``Accept-Language``（取当前界面语言，见 ``src/api/index.ts``），
本模块据此选择文案语言：

- :func:`resolve_language`：解析 ``Accept-Language``（取首个受支持语言，无匹配用默认语言）；
- :func:`current_language`：当前请求的语言；**无请求上下文**（如后台线程）时用默认语言；
- :func:`tr`：按当前语言取文案并插值，键缺失**明确抛错**而不静默回落。

边界约定：只有"会展示给用户的文案"才走 :func:`tr`；LLM system/user 提示词、
工具 JSON Schema 描述、日志与代码注释保持中文原样（它们是模型指令或开发信息，
不是界面文案）。
"""
from __future__ import annotations

from functools import lru_cache

from flask import has_request_context, request

from locales import LANGUAGES, catalog

#: 受支持的界面语言（与前端 ``SUPPORTED_LANGUAGES`` 一致）
SUPPORTED_LANGUAGES: tuple[str, ...] = LANGUAGES
#: 兜底语言：请求未声明 / 声明了不支持的语言时使用
DEFAULT_LANGUAGE: str = "zh"

#: 启动时一次性加载并校验（中英键不一致会在导入期直接报错）
CATALOG: dict[str, dict[str, str]] = catalog()


@lru_cache(maxsize=16)
def resolve_language(header: str | None) -> str:
    """从 ``Accept-Language`` 解析出受支持语言。

    按声明顺序取**第一个**受支持的语言主干（``zh-CN`` / ``en-US`` → ``zh`` / ``en``）；
    完全不含受支持语言时返回 :data:`DEFAULT_LANGUAGE`。
    """
    if not header:
        return DEFAULT_LANGUAGE
    for part in header.split(","):
        base = part.split(";")[0].strip().lower().split("-")[0]
        if base in SUPPORTED_LANGUAGES:
            return base
    return DEFAULT_LANGUAGE


def current_language() -> str:
    """当前请求的界面语言；无请求上下文时返回默认语言。"""
    if has_request_context():
        return resolve_language(request.headers.get("Accept-Language"))
    return DEFAULT_LANGUAGE


def tr(key: str, **params: object) -> str:
    """按当前语言取文案并插值。

    :param key: 形如 ``api.invalid_paper_id`` 的完整键（含命名空间前缀）
    :param params: 文案模板中的 ``{name}`` 占位参数
    :raises KeyError: 该语言下未配置此键（宁可报错也不静默漏出另一种语言）
    """
    table = CATALOG[current_language()]
    if key not in table:
        raise KeyError(f"缺少后端文案: {current_language()}.{key}")
    template = table[key]
    return template.format(**params) if params else template
