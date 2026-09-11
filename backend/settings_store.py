"""运行时设置：数据源凭据、聚合顺序与 LLM 服务配置。

设计要点
--------
1. **唯一持久化载体是数据库表 ``app_settings``**（``backend/data/papermind.db``，
   该目录被 .gitignore 忽略）。用户通过前端「设置」页写入；保存后立即 :func:`reload`，
   provider / LLM 客户端在**不重启服务**的情况下即取到新配置（它们都在请求时经本模块
   读取，而非在 import 时固化）。
2. **key 只存在于后端数据库**。:func:`snapshot` 只回传"是否已配置"与掩码，绝不回传明文
   密钥，因此前端与仓库都不会出现 key。
3. ``source_priority`` 是「数据源启用状态 + 聚合优先级」的**唯一真相**：
   出现在该有序列表中的源即为启用，顺序即优先级；未出现即禁用。避免
   "启用集合"与"优先级列表"两份数据互相矛盾。
4. ``backend/.env`` 只保留 HOST/PORT/DEBUG 等**非敏感服务配置**。首次启动时若发现
   ``app_settings`` 为空（老版本升级），会把 .env 中的受管键一次性迁移进数据库，
   并从 .env 中移除这些键（见 :func:`_migrate_from_env`）。
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

import storage.db as db
from i18n import tr

logger = logging.getLogger(__name__)

ENV_PATH = Path(__file__).resolve().parent / ".env"

# ---------- 数据源目录（前端「设置」页据此渲染；新增数据源只需在此登记） ----------
# credential_key: 凭据在 app_settings 表中的键；None 表示该源无需任何配置
# secret: True=密钥（界面/接口只回掩码）；False=可明文回显（如邮箱）
# required: 该凭据是否为"该源可用"的必要条件
# credential_label / description: i18n 文案键（在 snapshot() 内按当前语言经 tr() 解析）；
#   label 为专有名词，直接存展示值，不翻译
SOURCE_CATALOG: list[dict] = [
    {
        "id": "semantic_scholar",
        "label": "Semantic Scholar",
        "credential_key": "credential.semantic_scholar",
        "credential_env": "SEMANTIC_SCHOLAR_API_KEY",
        "credential_label": "settings.source.semantic_scholar.credential_label",
        "secret": True,
        "required": False,
        "help_url": "https://www.semanticscholar.org/product/api",
        "description": "settings.source.semantic_scholar.description",
    },
    {
        "id": "openalex",
        "label": "OpenAlex",
        "credential_key": "credential.openalex",
        "credential_env": "OPENALEX_MAILTO",
        "credential_label": "settings.source.openalex.credential_label",
        "secret": False,
        "required": False,
        "help_url": "https://openalex.org/",
        "description": "settings.source.openalex.description",
    },
    {
        "id": "arxiv",
        "label": "arXiv",
        "credential_key": None,
        "credential_env": None,
        "credential_label": None,
        "secret": False,
        "required": False,
        "help_url": "https://info.arxiv.org/help/api/index.html",
        "description": "settings.source.arxiv.description",
    },
    {
        "id": "core",
        "label": "CORE",
        "credential_key": "credential.core",
        "credential_env": "CORE_API_KEY",
        "credential_label": "settings.source.core.credential_label",
        "secret": True,
        "required": False,
        "help_url": "https://core.ac.uk/services/api",
        "description": "settings.source.core.description",
    },
]

SOURCE_IDS: list[str] = [entry["id"] for entry in SOURCE_CATALOG]
SOURCE_LABELS: dict[str, str] = {entry["id"]: entry["label"] for entry in SOURCE_CATALOG}

# 默认聚合优先级（引用数据最全者优先）
DEFAULT_SOURCE_PRIORITY: list[str] = ["semantic_scholar", "openalex", "arxiv", "core"]

# LLM 默认值（数据库未填写时生效）
DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1"
DEFAULT_LLM_MODEL = "gpt-4o-mini"
DEFAULT_LLM_TIMEOUT = 120

# app_settings 中的逻辑键名
KEY_LLM_BASE_URL = "llm_base_url"
KEY_LLM_MODEL = "llm_model"
KEY_LLM_API_KEY = "llm_api_key"
KEY_SOURCE_PRIORITY = "source_priority"

_cache: dict = {}


def _clean_api_key(key: str) -> str:
    """真实 API key 必须是纯 ASCII 且不含空白；
    占位符（如 example 里的 'sk-你的key'）视为未配置。"""
    key = (key or "").strip()
    if key.isascii() and not any(ch.isspace() for ch in key):
        return key
    return ""


def _parse_source_priority(raw: str) -> list[str]:
    """把存储的 ``source_priority`` 字符串解析为已知数据源的有序列表（去重、保持顺序）。

    - 空值：视为未配置，返回默认优先级（新装环境）；
    - 含未知数据源：属于配置错误，明确抛错而非静默兜底。
    """
    if not raw.strip():
        return list(DEFAULT_SOURCE_PRIORITY)
    seen: list[str] = []
    for part in raw.split(","):
        source = part.strip().lower()
        if source and source in SOURCE_LABELS and source not in seen:
            seen.append(source)
    unknown = [
        p.strip() for p in raw.split(",")
        if p.strip() and p.strip().lower() not in SOURCE_LABELS
    ]
    if unknown:
        raise ValueError(tr("settings.source_priority_unknown", sources=", ".join(unknown)))
    if not seen:
        raise ValueError(tr("settings.source_priority_empty"))
    return seen


def _migrate_from_env() -> dict[str, str]:
    """首次启动的一次性迁移：把 .env 中的受管键读入数据库，并从 .env 移除。

    迁移判据是 ``app_settings`` 表为空（老版本没有该表数据）。迁移完成后 .env
    只保留 HOST/PORT/DEBUG 等服务配置；.env 不存在或没有受管键时（全新安装），
    则以代码默认值初始化数据库设置。
    """
    if ENV_PATH.exists():
        load_dotenv(ENV_PATH, override=False)

    priority = _parse_source_priority(os.getenv("SOURCE_PRIORITY", ""))
    migrated: dict[str, str] = {
        KEY_LLM_BASE_URL: (os.getenv("LLM_BASE_URL", "") or "").strip() or DEFAULT_LLM_BASE_URL,
        KEY_LLM_MODEL: (os.getenv("LLM_MODEL", "") or "").strip() or DEFAULT_LLM_MODEL,
        KEY_LLM_API_KEY: _clean_api_key(os.getenv("LLM_API_KEY", "")),
        KEY_SOURCE_PRIORITY: ",".join(priority),
    }
    for entry in SOURCE_CATALOG:
        if entry["credential_key"] and entry["credential_env"]:
            migrated[entry["credential_key"]] = (os.getenv(entry["credential_env"], "") or "").strip()

    db.set_settings(migrated)

    # 从 .env 移除已迁移的受管键（保留服务配置、注释与空行的可读性）
    managed_env_keys = {"LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "SOURCE_PRIORITY"}
    managed_env_keys.update(
        entry["credential_env"] for entry in SOURCE_CATALOG if entry["credential_env"]
    )
    _strip_env_keys(managed_env_keys)

    logger.info("已将 .env 中的受管设置一次性迁移到数据库 app_settings 表")
    return migrated


def _strip_env_keys(keys: set[str]) -> None:
    """从 .env 删除指定键的赋值行（含界面写入分节标题），原子落盘。

    服务配置（HOST/PORT/DEBUG）与其它注释原样保留；清理多余连续空行。
    """
    if not ENV_PATH.exists():
        return
    kept: list[str] = []
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.lstrip()
        if stripped.startswith("# =") and "由界面「设置」写入" in stripped:
            continue
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in keys:
                continue
        kept.append(line)
    # 去掉首尾空行，并把连续空行压缩为一行
    cleaned: list[str] = []
    prev_blank = True
    for line in kept:
        blank = not line.strip()
        if blank and prev_blank:
            continue
        cleaned.append(line)
        prev_blank = blank
    while cleaned and not cleaned[-1].strip():
        cleaned.pop()
    tmp_path = ENV_PATH.with_name(ENV_PATH.name + ".tmp")
    tmp_path.write_text("\n".join(cleaned) + ("\n" if cleaned else ""), encoding="utf-8")
    tmp_path.replace(ENV_PATH)


def reload() -> None:
    """从数据库重新加载全部运行时配置（界面写入后立即调用，热加载）。"""
    db.init_db()
    stored = db.get_settings()
    if not stored:
        # 全新安装或老版本升级：一次性从 .env 迁移（或落默认值）
        stored = _migrate_from_env()

    credentials: dict[str, str] = {}
    for entry in SOURCE_CATALOG:
        if entry["credential_key"]:
            credentials[entry["id"]] = (stored.get(entry["credential_key"], "") or "").strip()

    _cache.clear()
    _cache.update({
        "llm_base_url": (stored.get(KEY_LLM_BASE_URL, "") or "").strip() or DEFAULT_LLM_BASE_URL,
        "llm_model": (stored.get(KEY_LLM_MODEL, "") or "").strip() or DEFAULT_LLM_MODEL,
        "llm_api_key": _clean_api_key(stored.get(KEY_LLM_API_KEY, "")),
        "llm_timeout": DEFAULT_LLM_TIMEOUT,
        "credentials": credentials,
        "source_priority": _parse_source_priority(stored.get(KEY_SOURCE_PRIORITY, "")),
    })
    logger.info("设置已加载：启用数据源=%s，LLM=%s",
                ",".join(_cache["source_priority"]), _cache["llm_model"])


def get(source_id: str) -> str:
    """取某数据源的凭据（未配置返回空串）。"""
    return _cache["credentials"].get(source_id, "")


def llm_config() -> dict:
    """LLM 连接配置（每次调用都取当前值，供每请求新建的 LLMClient 使用）。"""
    return {
        "base_url": _cache["llm_base_url"],
        "api_key": _cache["llm_api_key"],
        "model": _cache["llm_model"],
        "timeout": _cache["llm_timeout"],
    }


def source_priority() -> list[str]:
    """启用的数据源，按聚合优先级排列。"""
    return list(_cache["source_priority"])


def enabled_sources() -> list[str]:
    """仅返回启用的数据源 id（语义同 :func:`source_priority`）。"""
    return list(_cache["source_priority"])


def _mask(value: str) -> str:
    """密钥掩码：只保留末 4 位，其余打点。"""
    if not value:
        return ""
    if len(value) <= 4:
        return "••••"
    return "••••" + value[-4:]


def snapshot() -> dict:
    """当前设置的**可安全下发**视图（密钥只给掩码与"是否已配置"）。"""
    priority = _cache["source_priority"]
    sources: list[dict] = []
    for entry in SOURCE_CATALOG:
        raw = _cache["credentials"].get(entry["id"], "")
        item = {
            "id": entry["id"],
            "label": entry["label"],
            "credential_label": tr(entry["credential_label"]) if entry["credential_label"] else None,
            "secret": entry["secret"],
            "required": entry["required"],
            "help_url": entry["help_url"],
            "description": tr(entry["description"]),
            "configured": bool(raw),
            "enabled": entry["id"] in priority,
            "priority": priority.index(entry["id"]) if entry["id"] in priority else -1,
        }
        if entry["credential_key"]:
            item["value"] = _mask(raw) if entry["secret"] else raw
        sources.append(item)
    # 启用者按优先级在前，禁用者随后（保持目录顺序），便于界面直接渲染
    sources.sort(key=lambda s: (s["priority"] if s["priority"] >= 0 else len(SOURCE_IDS)))
    return {
        "llm": {
            "base_url": _cache["llm_base_url"],
            "model": _cache["llm_model"],
            "api_key_configured": bool(_cache["llm_api_key"]),
            "api_key_hint": _mask(_cache["llm_api_key"]),
        },
        "sources": sources,
    }


def _validate_llm(payload: dict) -> dict[str, str]:
    """校验并抽取 LLM 字段的数据库更新项。"""
    updates: dict[str, str] = {}
    if "base_url" in payload:
        base_url = str(payload["base_url"] or "").strip()
        if not base_url.startswith(("http://", "https://")):
            raise ValueError(tr("settings.invalid_base_url"))
        updates[KEY_LLM_BASE_URL] = base_url
    if "model" in payload:
        model = str(payload["model"] or "").strip()
        if not model:
            raise ValueError(tr("settings.empty_model"))
        updates[KEY_LLM_MODEL] = model
    if "api_key" in payload:
        # 空串表示清除，交给使用侧报"未配置"
        updates[KEY_LLM_API_KEY] = str(payload["api_key"] or "").strip()
    return updates


def _validate_source_order(order) -> list[str]:
    """校验界面提交的「启用数据源有序列表」。"""
    if not isinstance(order, list):
        raise ValueError(tr("settings.source_order_not_list"))
    result: list[str] = []
    for raw in order:
        source = str(raw).strip().lower()
        if source not in SOURCE_LABELS:
            raise ValueError(tr("settings.source_order_unknown", source=source))
        if source not in result:
            result.append(source)
    if not result:
        raise ValueError(tr("settings.source_order_empty"))
    return result


def update(payload: dict) -> dict:
    """保存设置并立即生效。

    约定：字段**出现即更新**（凭据传空串表示清除）；未出现的字段保持原值，
    这样界面无需回传掩码占位、也不会误清空用户已有的 key。

    :raises ValueError: 任一字段校验失败（路由层转成 400 并给出具体原因）
    """
    updates: dict[str, str] = {}

    llm = payload.get("llm")
    if llm:
        if not isinstance(llm, dict):
            raise ValueError(tr("settings.llm_not_object"))
        updates.update(_validate_llm(llm))

    credentials = payload.get("credentials")
    if credentials:
        if not isinstance(credentials, dict):
            raise ValueError(tr("settings.credentials_not_object"))
        unknown = [k for k in credentials if k not in SOURCE_LABELS]
        if unknown:
            raise ValueError(tr("settings.credentials_unknown", sources=", ".join(unknown)))
        for entry in SOURCE_CATALOG:
            db_key = entry["credential_key"]
            if not db_key or entry["id"] not in credentials:
                continue
            updates[db_key] = str(credentials[entry["id"]] or "").strip()

    order = payload.get("source_order")
    if order is not None:
        updates[KEY_SOURCE_PRIORITY] = ",".join(_validate_source_order(order))

    if not updates:
        raise ValueError(tr("settings.nothing_to_save"))

    db.set_settings(updates)
    reload()
    return snapshot()


# 进程启动时加载一次（之后由 update 触发 reload）
reload()
