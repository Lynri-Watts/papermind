"""设置 API：数据源凭据 / 启用顺序 与 LLM 服务配置的读写与连通性测试。

- ``GET  /api/settings``      当前设置（密钥只回掩码与"是否已配置"，绝不回明文）
- ``PUT  /api/settings``      保存设置（写入 ``backend/.env`` 并立即生效，无需重启）
- ``POST /api/settings/test`` 对 LLM 或某个数据源发起一次真实请求，验证配置可用

连通性测试的失败是**被测试对象的结果**而非接口错误，因此统一以 HTTP 200 +
``{"ok": false, "message": ...}`` 返回，便于界面直接展示原因。
"""
from __future__ import annotations

import time

from flask import Blueprint, jsonify, request

import settings_store
from i18n import tr
from routes.papers import ApiError

settings_api = Blueprint("settings", __name__)


@settings_api.errorhandler(ApiError)
def _handle_api_error(err: ApiError):
    return jsonify({"error": err.message}), err.status


@settings_api.errorhandler(Exception)
def _handle_unexpected(err: Exception):
    return jsonify({"error": tr("settings.internal_error", err=err)}), 500


# 连通性测试用的探测查询（各源均能命中的通用词）
_PROBE_QUERY = "machine learning"


def _test_llm() -> dict:
    """用一次最小对话验证 base_url / api_key / model 三者都可用。"""
    from llm.client import LLMClient, LLMNotConfiguredError

    try:
        client = LLMClient()
    except LLMNotConfiguredError as exc:
        return {"ok": False, "message": str(exc)}

    started = time.perf_counter()
    try:
        result = client.chat([{"role": "user", "content": "ping"}])
    except Exception as exc:
        return {"ok": False, "message": tr("settings.llm_call_failed", exc=exc)}
    latency = int((time.perf_counter() - started) * 1000)

    if not (result.get("content") or "").strip():
        return {
            "ok": False,
            "message": tr("settings.llm_empty_content"),
            "latency_ms": latency,
        }
    model = settings_store.llm_config()["model"]
    return {"ok": True, "message": tr("settings.llm_connected", model=model), "latency_ms": latency}


def _test_source(source_id: str) -> dict:
    """对数据源发一次真实检索，验证 key / 网络 / 限流是否正常。

    直接经 get_provider 取源，不受"是否启用"影响——停用的源也能先测试再启用。
    """
    if source_id not in settings_store.SOURCE_IDS:
        raise ApiError(tr("settings.unknown_source", source_id=source_id))

    from providers import get_provider

    provider = get_provider(source_id)
    started = time.perf_counter()
    try:
        papers = provider.search(_PROBE_QUERY, 1)
    except Exception as exc:
        return {"ok": False, "message": str(exc)}
    latency = int((time.perf_counter() - started) * 1000)

    if not papers:
        return {
            "ok": False,
            "message": tr("settings.source_no_result"),
            "latency_ms": latency,
        }
    return {"ok": True, "message": tr("settings.source_connected", n=len(papers)), "latency_ms": latency}


@settings_api.get("/settings")
def get_settings():
    return jsonify(settings_store.snapshot())


@settings_api.put("/settings")
def update_settings():
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(settings_store.update(body))
    except ValueError as exc:
        raise ApiError(str(exc)) from exc


@settings_api.post("/settings/test")
def test_connection():
    body = request.get_json(silent=True) or {}
    target = str(body.get("target") or "").strip()
    if not target:
        raise ApiError(tr("settings.missing_target"))
    if target == "llm":
        return jsonify(_test_llm())
    return jsonify(_test_source(target))
