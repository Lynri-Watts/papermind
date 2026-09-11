"""后端文案目录（中/英）。

组织方式：**一个命名空间一个模块**（如 ``settings.py`` 对应「设置」相关文案），
每个模块导出 ``MESSAGES = {"zh": {...}, "en": {...}}``，键名自带命名空间前缀
（``settings.xxx``），因此在同一平面即可按点号查表，也便于按模块并行维护。

:func:`catalog` 在进程启动时把各命名空间合并为 ``{"zh": {...}, "en": {...}}``，
并**强校验中英键完全一致**——任一侧漏配键都会在导入期直接报错，
避免"英文界面漏出中文/中文界面漏出英文"的静默降级。
"""
from __future__ import annotations

from . import api, pdf, rag, search, settings, workspace

# 命名空间清单（新增命名空间时在此登记）
_NAMESPACES = (api, settings, workspace, search, pdf, rag)

LANGUAGES: tuple[str, ...] = ("zh", "en")


def catalog() -> dict[str, dict[str, str]]:
    """合并全部命名空间的中英文案，并校验键集合一一对应。"""
    merged: dict[str, dict[str, str]] = {lang: {} for lang in LANGUAGES}
    for module in _NAMESPACES:
        table = getattr(module, "MESSAGES", None)
        if not isinstance(table, dict):
            raise ValueError(f"{module.__name__} 未导出 MESSAGES 字典")
        for lang in LANGUAGES:
            entries = table.get(lang)
            if not isinstance(entries, dict):
                raise ValueError(f"{module.__name__} 缺少 {lang} 文案表")
            for key, value in entries.items():
                if key in merged[lang]:
                    raise ValueError(f"{lang} 文案键重复: {key}")
                merged[lang][key] = value

    missing_en = sorted(set(merged["zh"]) - set(merged["en"]))
    missing_zh = sorted(set(merged["en"]) - set(merged["zh"]))
    if missing_en or missing_zh:
        raise ValueError(
            "中英文案键不一致："
            f"缺英文={missing_en}；缺中文={missing_zh}"
        )
    return merged
