"""论文与业务 API 路由。

统一 id 格式：``source:external_id``（如 ``semantic_scholar:xxxx``、``arxiv:2103.03404``）
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file, Response, stream_with_context

import storage.db as db
import storage.workspace as ws
from config import PDF_DIR
from i18n import tr
from llm.client import LLMClient, LLMNotConfiguredError
from llm.rag import (
    build_rag_engine,
    finalize_inline_answer,
    InlineQuoteExtractor,
)
from llm.summarize import summarize_text, truncate_summary
from llm.tools import default_registry
from llm.tools_mindmap import register_mindmap_tools
from providers import get_provider
from providers.base import SearchQuery
from providers.download import PdfDownloadError, download_pdf, parse_pdf_to_text
from providers.web import fetch_webpage
from services.fulltext import (get_paper_fulltext, get_paper_fulltext_checked,
                               local_pdf_bytes, split_local_id)
from services.search import search_papers_keyword, search_papers_structured

api = Blueprint("api", __name__)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@api.errorhandler(ApiError)
def _handle_api_error(err: ApiError):
    return jsonify({"error": err.message}), err.status


@api.errorhandler(Exception)
def _handle_unexpected(err: Exception):
    return jsonify({"error": tr("api.internal_error", err=err)}), 500


def _split_id(paper_id: str) -> tuple[str, str]:
    if ":" not in paper_id:
        raise ApiError(tr("api.invalid_paper_id", paper_id=paper_id))
    source, external_id = paper_id.split(":", 1)
    return source, external_id


def _parse_year(value: str | None) -> int | None:
    """解析年份参数；非法/越界返回 None。"""
    if not value:
        return None
    try:
        y = int(value)
    except (TypeError, ValueError):
        return None
    return y if 1000 <= y <= 3000 else None


def _ws_scope(workspace_id: str | None) -> str:
    """把请求里的工作区 id 归一化为内部作用域标记（上下文库隔离用）。

    ''（空）=全局库；非空 → 'ws:<workspace_id>'，与状态快照的 project_id
    命名规则一致，保证数据库行可自描述归属。
    """
    wid = (workspace_id or "").strip()
    return f"ws:{wid}" if wid else ""


# ---------- 论文元数据 / 全文辅助（Context 与 RAG 共用） ----------
def _pdf_title(content: bytes) -> str | None:
    """从 PDF 元数据提取标题；解析失败返回 None。"""
    try:
        import pymupdf
        doc = pymupdf.open(stream=content, filetype="pdf")
        try:
            title = (doc.metadata or {}).get("title") or ""
        finally:
            doc.close()
        title = title.strip()
        return title or None
    except Exception:
        return None


def _local_paper_meta(paper_id: str) -> dict:
    """本地文献元数据：从工作区 PDF 提取标题/全文并注册到缓存。

    本地文献无网络数据源，元数据来源于 PDF 本身：
    - title：优先 PDF 元数据标题，否则取文件名（去扩展名）
    - fulltext：顺带解析并缓存（后续 RAG/阅读直接命中 DB）
    """
    split = split_local_id(paper_id)
    if not split:
        raise ApiError(tr("api.invalid_local_id"), 404)
    ws_id, rel_path = split

    cached = db.get_paper(paper_id)
    if cached and cached.get("title"):
        return cached

    data = local_pdf_bytes(paper_id)
    if not data:
        raise ApiError(tr("api.local_file_missing"), 404)

    title = _pdf_title(data) or Path(rel_path).stem
    text = get_paper_fulltext(paper_id)  # local 源：读工作区 PDF 解析并缓存全文
    db.upsert_paper(
        paper_id=paper_id, title=title, authors=[], year=None,
        abstract="", source="local", external_id=paper_id,
        url="", pdf_url=None, doi=None, citation_count=None,
        fulltext=text or None,
    )
    return db.get_paper(paper_id) or {"id": paper_id, "title": title}


def _paper_meta(paper_id: str) -> dict:
    """获取论文元数据（DB 缓存优先，否则从数据源拉取并缓存）。"""
    if paper_id.startswith("local:"):
        return _local_paper_meta(paper_id)
    cached = db.get_paper(paper_id)
    if cached and cached.get("title"):
        return cached
    source, external_id = _split_id(paper_id)
    provider = get_provider(source)
    paper = provider.get_paper(external_id)
    db.upsert_paper(
        paper_id=paper.id, title=paper.title, authors=paper.authors, year=paper.year,
        abstract=paper.abstract, source=paper.source, external_id=paper.external_id,
        url=paper.url, pdf_url=paper.pdf_url, doi=paper.doi,
        citation_count=paper.citation_count,
    )
    return paper.to_dict()


def _paper_pdf_cache_path(paper_id: str) -> Path:
    """磁盘 PDF 缓存路径（与 /paper/{id}/pdf 路由的命名规则一致）。"""
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", paper_id)
    return PDF_DIR / f"{safe_name}.pdf"


def _paper_fulltext(paper_id: str) -> str:
    """获取论文全文（三级缓存：DB → 磁盘 PDF → 远程下载）。

    统一收敛到 services.fulltext.get_paper_fulltext，供 RAG、read_paper 工具、
    /paper/{id}/fulltext 等共用，保证全文最多只下载一次。
    """
    return get_paper_fulltext(paper_id)


def _ensure_fulltext_once(paper_id: str) -> tuple[bool, str | None]:
    """自动尝试**一次**全文获取，并把结果写入 paper_pdf_status 标记。

    供「加入上下文」与「手动刷新」共用：三级缓存命中时无网络请求；
    未命中才发起唯一一次远程下载。返回 ``(是否可用, 失败原因)``。
    成功（含 DB 全文/磁盘缓存命中）置 available；失败置 unavailable 并记录原因，
    前端据此不再自动重试，只允许用户手动刷新。
    """
    text, reason = get_paper_fulltext_checked(paper_id)
    if text:
        db.set_pdf_status(paper_id, "available")
        return True, None
    db.set_pdf_status(paper_id, "unavailable", reason)
    return False, reason


def _serialize_context_item(item: dict) -> dict:
    """序列化单个 context 项：paper 类型附加 PDF/全文可打开性标记。

    - pdf_status：``available`` / ``unavailable`` / ``unknown``（从未探测）
    - pdf_error：最近一次失败原因（unavailable 时可能为空）
    url 类型两项恒为 None。
    """
    out = dict(item)
    if item.get("type") == "paper" and item.get("ref_id"):
        marker = db.get_pdf_status(item["ref_id"])
        out["pdf_status"] = marker["status"] if marker else "unknown"
        out["pdf_error"] = (marker or {}).get("error")
    else:
        out["pdf_status"] = None
        out["pdf_error"] = None
    return out


def _serialize_context_items(items: list[dict]) -> list[dict]:
    """批量序列化 context 项（标记批量查询，避免 N+1）。"""
    paper_ids = [i.get("ref_id") for i in items
                 if i.get("type") == "paper" and i.get("ref_id")]
    markers = db.get_pdf_status_map(paper_ids)
    result = []
    for item in items:
        out = dict(item)
        marker = markers.get(item.get("ref_id")) if item.get("type") == "paper" else None
        if item.get("type") == "paper":
            out["pdf_status"] = marker["status"] if marker else "unknown"
            out["pdf_error"] = (marker or {}).get("error")
        else:
            out["pdf_status"] = None
            out["pdf_error"] = None
        result.append(out)
    return result


def _context_fulltext_checked(item: dict) -> tuple[str, str]:
    """取 context 项的全文用于 RAG；读取失败时返回面向用户的具体原因：
    - paper：论文全文（取不到全文时回退 abstract，仍为空则说明论文侧原因）
    - url：缓存的网页正文
    """
    if item["type"] == "paper":
        ref_id = item.get("ref_id")
        if not ref_id:
            return "", tr("api.context_item.no_paper_ref")
        text, reason = get_paper_fulltext_checked(ref_id)
        if text:
            return text, ""
        content = item.get("content")
        if isinstance(content, dict):
            abstract = content.get("abstract") or ""
            if abstract:
                return abstract, ""
        return "", reason or tr("api.context_item.no_public_fulltext")
    content = item.get("content")
    if isinstance(content, str) and content.strip():
        return content, ""
    return "", tr("api.context_item.no_saved_content")


def _context_fulltext(item: dict) -> str:
    """取 context 项的全文用于 RAG（无原因版，兼容旧调用方）。"""
    text, _ = _context_fulltext_checked(item)
    return text


def _make_summary(text: str, title: str) -> str:
    """生成摘要：LLM 优先，未配置 key 时降级截取。"""
    if not text:
        return ""
    try:
        engine = build_rag_engine()
        return summarize_text(engine.client, text, title)
    except LLMNotConfiguredError:
        return truncate_summary(text)


def _find_existing_context(item_type: str, workspace_id: str, key_col: str, key: str) -> int | None:
    """在同一上下文库作用域内查找已存在的同类条目（幂等加库用）。

    paper 按 ref_id 判重；url 按 url 判重。避免重复询问/重复导入把同一篇
    论文或网页堆成多条上下文。无匹配返回 None。
    """
    for it in db.list_context_items(workspace_id=workspace_id):
        if it["type"] == item_type and it.get(key_col) == key:
            return it["id"]
    return None


# ---------- ReAct 自动工具循环（无逐次确认；思考/动作/结果实时流式输出到聊天） ----------
# 与旧版"交互式工具会话（用户逐工具确认）"不同：改造后工具由 AI 在 ReAct 循环里
# 自主连续执行，系统把每步的 Thought（思考）增量与 Action/Observation（动作/结果）
# 作为 SSE 事件随生成过程实时发给前端，最终合并进聊天记录（toolLog），前端可随时停止。

_TOOL_REGISTRY = default_registry()
register_mindmap_tools(_TOOL_REGISTRY)
_TOOL_LABEL_KEYS = {
    "paper_search": "api.tool_label.paper_search",
    "read_paper": "api.tool_label.read_paper",
    "read_document": "api.tool_label.read_document",
    "list_mindmaps": "api.tool_label.list_mindmaps",
    "create_mindmap": "api.tool_label.create_mindmap",
    "read_mindmap": "api.tool_label.read_mindmap",
    "edit_mindmap": "api.tool_label.edit_mindmap",
    "attach_paper_to_mindmap": "api.tool_label.attach_paper_to_mindmap",
    # 非真实工具：读取"当前论文 + 上下文库"候选材料的内部步骤，用于展示 ReAct 轨迹
    "read_materials": "api.tool_label.read_materials",
}


def _tool_label(name: str) -> str:
    """工具展示名：按当前语言解析（未登记的工具原样回显其 id）。"""
    key = _TOOL_LABEL_KEYS.get(name)
    return tr(key) if key else name
# ReAct 单次问答最多自动执行的工具轮数（防死循环）
_REACT_MAX_TURNS = 8

# run_id -> threading.Event；/rag/stream 注册，/rag/cancel 置位，循环在每步之间检查
_RUN_CANCELS: dict[str, threading.Event] = {}


def _request_cancelled(run_id: str) -> bool:
    ev = _RUN_CANCELS.get(run_id)
    return ev is not None and ev.is_set()


def _register_run(run_id: str) -> None:
    _RUN_CANCELS.pop(run_id, None)  # 幂等：重名覆盖
    _RUN_CANCELS[run_id] = threading.Event()


def _cancel_run(run_id: str) -> None:
    ev = _RUN_CANCELS.get(run_id)
    if ev is not None:
        ev.set()


def _unregister_run(run_id: str) -> None:
    _RUN_CANCELS.pop(run_id, None)


# ---------- RAG 公共流水线（初始问答与工具会话共用） ----------
def _select_materials(question: str, use_context: bool, context_ids: list[int],
                      exclude_ids: list[int], engine, current_candidate: dict,
                      workspace_id: str = "") -> list[int]:
    """AI 依据摘要判定需要阅读哪些候选（当前论文 + 上下文库）。"""
    if use_context:
        summaries = [
            {"id": it["id"], "title": it["title"], "summary": it["summary"]}
            for it in db.list_context_items(workspace_id=workspace_id)
            if it["id"] not in exclude_ids and it.get("status") != "failed"
        ]
        if context_ids:
            # 用户固定 context：仍由 AI 判定是否阅读当前论文
            selected = [cid for cid in context_ids if cid not in exclude_ids]
            if 0 in engine.select_context_items(question, [], current=current_candidate):
                selected.insert(0, 0)
        else:
            selected = engine.select_context_items(
                question, summaries, current=current_candidate
            )
    else:
        # 关闭上下文库：仅由 AI 判定是否阅读当前论文
        selected = engine.select_context_items(question, [], current=current_candidate)
    return selected


def _read_selected_sources(selected_ids: list[int], paper_id: str,
                           paper_title: str, emit, failures: list[str],
                           warnings: list[str] | None = None,
                           paper_abstract: str = "") -> list[dict]:
    """按需读取选中候选的全文（生成器：逐个 emit stage 事件，return 来源列表）。

    未选中的候选完全不读，节约时间与 token。读取失败不静默：把每一项
    失败的具体原因（未开放 PDF / 403 / 404 / 解析失败 / 扫描版等）记入
    failures，供 read_materials 的 observation 准确反馈。

    ``warnings``：读取**降级成功**（如当前论文全文不可得、退用摘要）的说明，
    与 failures 区分——材料仍然进入了检索池，只是完整度打折扣。
    """
    warnings = warnings if warnings is not None else []
    sources: list[dict] = []
    for sid in selected_ids:
        if sid == 0:
            if not paper_id:
                continue
            yield emit("stage", {"label": tr("api.stage.fetch_current_fulltext")})
            fulltext, reason = get_paper_fulltext_checked(paper_id)
            if not fulltext and paper_abstract.strip():
                # 全文不可得（闭源/限流/解析失败）但有摘要：降级用摘要作答，
                # 明确告知用户依据打了折扣——不能让"打开着论文却像没文档"
                fulltext = paper_abstract.strip()
                warnings.append(tr(
                    "api.read_fail.paper_abstract_only",
                    title=paper_title,
                    reason=reason or tr("api.reason.fulltext_missing"),
                ))
            if fulltext:
                sources.append({
                    "label": paper_title,
                    "text": fulltext,
                    "context_id": None,
                    "paper_id": paper_id,
                })
            else:
                failures.append(tr("api.read_fail.paper", title=paper_title,
                                    reason=reason or tr("api.reason.fulltext_missing")))
            continue
        item = db.get_context_item(sid)
        if not item:
            failures.append(tr("api.read_fail.context_gone", sid=sid))
            continue
        yield emit("stage", {"label": tr("api.stage.reading_context", title=item['title'])})
        text, reason = _context_fulltext_checked(item)
        if text:
            sources.append({
                "label": item["title"],
                "text": text,
                "context_id": sid,
                "paper_id": item["type"] == "paper" and item.get("ref_id") or None,
            })
        else:
            failures.append(tr("api.read_fail.context", title=item['title'],
                                reason=reason or tr("api.reason.no_usable_content")))
    return sources


def _join_reasons(reasons: list[str], limit: int = 6) -> str:
    """把若干失败原因拼成一句人类可读的短摘要（避免 observation 消息过长）。"""
    shown = tr("api.separator.reason").join(reasons[:limit])
    if len(reasons) > limit:
        shown += tr("api.more_items", n=len(reasons))
    return shown


def _react_loop_prompt(question: str, summaries: list[dict],
                       current: dict | None, document: str | None,
                       material_note: str | None = None) -> tuple[str, str]:
    """构造 ReAct 工具循环的 system+user（思考引导 + 自动执行 + 已选材料摘要）。

    ReAct 循环由 LLM 全权编排（工具描述与提示词引导先 paper_search 取摘要候选、
    依据摘要筛选后 read_paper 读取全文，不强制顺序）；工具**自动执行、无需用户确认**。
    每步要求 LLM 先输出一段"思考"（content，实时流式展示给用户），再决定是否请求
    一个工具；思考在最终回答前逐条出现，形成可见的 Thought→Action→Observation 轨迹。

    ``material_note``：步骤一（读取当前论文/上下文）的结果摘要，为空时省略；
    让 LLM 知晓候选材料是否已读取成功/失败，据此决定是否需要另找论文或直接作答。
    """
    candidates: list[dict] = []
    if current is not None:
        candidates.append(current)
    candidates.extend(summaries)
    candidates = candidates[:30]

    def _render_candidate(it: dict) -> str:
        head = f"[{it['id']}] {it['title']}"
        summary = f"摘要: {(it.get('summary') or '')[:200]}"
        if it["id"] == 0:
            # 当前论文：选材编号 [0] 仅供系统选材；标准 id 可直接用于 read_paper
            real_id = it.get("paper_id")
            if real_id:
                rule = (
                    f"类型: 当前论文；论文 id: {real_id}"
                    "（read_paper 只能传这个标准 id，不能传选材编号 0）"
                )
            else:
                rule = "类型: 当前论文（无标准论文 id，不能对它调用 read_paper）"
        elif it.get("type") == "paper":
            ref_id = it.get("ref_id")
            if ref_id:
                rule = (
                    f"类型: 论文库材料；论文 id: {ref_id}"
                    "（需要其全文时 read_paper 传这个标准 id；严禁传方括号选材编号）"
                )
            else:
                rule = "类型: 论文库材料（无标准论文 id，不能用 read_paper 读取）"
            return f"{head}\n{rule}\n{summary}"
        else:
            # 网页材料：read_paper 只处理论文 PDF，网页正文不在其能力范围内
            rule = "类型: 网页材料（无论文 id，read_paper 不支持网页）"
        return f"{head}\n{rule}\n{summary}"

    listing = "\n\n".join(_render_candidate(it) for it in candidates) or "（当前无可用材料）"

    focus_parts = []
    if current is not None:
        focus_parts.append("用户当前打开一篇论文（材料清单编号 0，标注'当前论文'）")
    if document:
        focus_parts.append("用户当前正在编辑 LaTeX 文档（写作场景，可用 read_document 读取）")
    focus_parts.append("上下文库中还有以下材料" if summaries else "")
    focus_desc = "、".join(p for p in focus_parts if p) or "当前无任何可用材料"

    system = (
        "你是论文研究助手的工具调度器，采用 ReAct（思考→行动→观察）模式工作。\n"
        f"当前情况：{focus_desc}。\n"
        "每步先输出一小段**思考**文字（会实时展示给用户）：说明这步的意图与依据。"
        "思考结束后，再根据**任务本身的需要**决定动作。工具彼此平行，没有固定的"
        "调用先后，按下列情形选择：\n"
        "- 需要查找库中有哪些相关论文、或当前没有可用的论文标准 id 时，调用 "
        "paper_search（返回候选摘要与每篇的标准论文 id）；\n"
        "- 当问题需要某篇论文的具体细节（方法、实验数据、公式、结论依据等），"
        "而该论文全文不在系统已读取的材料中时，调用 read_paper 读取其全文。"
        "paper_ids 使用**标准论文 id**（source:external_id 或 local:工作区:路径），"
        "可平行地取自两处、无先后要求：①上方材料清单中论文条目的「论文 id」；"
        "②paper_search 返回的 id。若仅靠已有摘要或已读全文即可作答，则不要调用；\n"
        "- 写作任务（改写/续写/检查语法/整理结构/把材料插入论文）调用 read_document；\n"
        "- 当用户希望**梳理、做笔记、构建/更新思维导图**（如「整理成导图」「把这几篇"
        "论文的关系画出来」「在导图里加一个分支」）时，使用导图工具：先 list_mindmaps"
        "（不确定 map_id 时）与 read_mindmap 取得带节点 ID 的结构，再用 edit_mindmap"
        "批量修改，或用 attach_paper_to_mindmap 挂论文；导图是用户思考的延伸，"
        "**编辑必须基于读到的材料与对话意图**，节点文本要简洁、沿用导图既有语言，"
        "**不得删除用户节点，除非用户明确要求**；一次问答里的导图修改应尽量集中在"
        "尽量少的 edit_mindmap 批次中；\n"
        "- 材料已足够且无导图等操作诉求时不要再请求工具，思考结束后回复 READY 即可。\n"
        "硬性规则：\n"
        "- 材料清单中的 [0]、[9] 等方括号数字是**系统内部选材编号**，只能用于系统"
        "选材环节，绝不能作为任何工具的参数（尤其不能传给 read_paper）；\n"
        "- read_paper 只处理论文 PDF：只接受标准论文 id，不接受网页 URL/网页材料"
        "（网页无论文 id），也不接受纯数字编号；\n"
        "- 「内部读取情况」与上方清单中已成功读取的材料可直接用于最终回答，不要"
        "重复读取；读取失败的论文可凭其标准 id 用 read_paper 自行重试；\n"
        "- 一次只请求一个工具；工具会自动执行无需你等待用户确认，执行结果会以 "
        "tool 角色返回，据此继续思考下一步；**禁止在本回合直接撰写最终回答正文**"
        "（最终回答由系统在检索材料后单独生成）。"
    )
    user = f"用户问题：{question}\n\n当前可用材料：\n{listing}"
    if material_note:
        user += (
            f"\n\n（内部读取情况：{material_note}。若某篇论文未能读取成功，可凭其标准"
            "论文 id 用 read_paper 重试；若没有可用 id 或需要另找替代文献，可先 "
            "paper_search 再 read_paper；无法解决时如实告诉用户并给出建议。）"
        )
    return system, user


def _merge_material(materials: list[dict], src: dict) -> None:
    """把一条材料源并入列表：按归属键去重（同论文只保留后写入的，如全文覆盖摘要）。"""
    text = (src.get("text") or "").strip()
    if not text:
        return
    src = {**src, "text": text}
    key = (
        src.get("paper_id")
        or (f"ctx:{src['context_id']}" if src.get("context_id") else None)
        or src.get("label")
    )
    for i, existing in enumerate(materials):
        ekey = (
            existing.get("paper_id")
            or (f"ctx:{existing['context_id']}" if existing.get("context_id") else None)
            or existing.get("label")
        )
        if ekey == key:
            materials[i] = src
            return
    materials.append(src)


def _answer_events(engine, question: str, sources: list[dict],
                   paper_meta: dict, history: list, emit,
                   material_note: str | None = None):
    """检索相关内容 + 流式生成回答（生成器：yield emit 结果）。

    无材料不再硬失败：先发一条 ``notice`` 事件（前端渲染为提示条而非错误），
    随后以 grounded=False 让模型仅凭通用知识作答；材料存在但切不出可用正文
    （ValueError）时走同一条降级路径，并把具体原因写进提示。
    """
    def stream_unguided():
        """无检索段落：空出处 + 通用知识流式回答（生成器，yield SSE 帧）。"""
        yield emit("stage", {"label": tr("api.stage.generating")})
        answer_parts: list[str] = []
        yield emit("sources", {"sources": []})
        for ev in engine.stream_answer(
            question, [], paper_meta, history, grounded=False,
        ):
            if ev["type"] == "sources":
                continue  # 空出处已由本函数发出
            answer_parts.append(ev["delta"])
            yield emit("delta", {"delta": ev["delta"]})
        yield emit("done", {"answer": "".join(answer_parts), "sources": []})

    if not sources:
        if material_note:
            notice = tr("api.answer.no_material_with_note", note=material_note)
        else:
            notice = tr("api.answer.no_material_notice")
        yield emit("notice", {"message": notice})
        yield from stream_unguided()
        return
    yield emit("stage", {"label": tr("api.stage.retrieving")})
    answer_parts: list[str] = []
    final_sources: list[dict] = []
    # 无编号行内引用 [Q]...[/Q]：流式转发时增量解析，半截标签扣留不泄漏，
    # 闭合即以"未决"态随 delta 内联转发（前端先显示核对中的引用标记）；
    # 出处绑定（逐字匹配 / 多命中上下文消歧 / 扩展模糊匹配 / 失败卡）
    # 需要标签之后的上下文句，统一在流末 finalize_inline_answer 完成。
    quote_extractor = InlineQuoteExtractor()
    try:
        for ev in engine.stream_answer(question, sources, paper_meta, history):
            if ev["type"] == "sources":
                final_sources = ev["sources"]
                yield emit("stage", {"label": tr("api.stage.generating")})
                yield emit("sources", {"sources": ev["sources"]})
            else:
                visible = quote_extractor.feed(ev["delta"])
                if not visible:
                    continue
                answer_parts.append(visible)
                yield emit("delta", {"delta": visible})
    except ValueError as exc:
        # 材料存在但完全没有可切分正文（如全是图表/引用列表）：同样降级为
        # 通用知识回答 + 提示，不再以错误中断问答
        yield emit("notice", {"message": tr("api.answer.no_passages_notice", note=str(exc))})
        yield from stream_unguided()
        return
    tail_visible = quote_extractor.finish()
    if tail_visible:
        answer_parts.append(tail_visible)
        yield emit("delta", {"delta": tail_visible})
    # 收口：逐字绑定出处、多命中上下文消歧、零命中扩展模糊匹配、失败卡终态
    final_answer = finalize_inline_answer("".join(answer_parts), final_sources)
    # done 事件必须携带最终正文（含终态引用标签）与 sources，
    # 前端据此把未决标记替换为成功/失败引用卡
    yield emit("done", {"answer": final_answer, "sources": final_sources})


# ---------- 健康检查 ----------
@api.get("/health")
def health():
    return jsonify({"status": "ok"})


# ---------- 搜索 ----------
def _search_sources_param() -> list[str] | None:
    """解析来源筛选参数（支持 ?sources=a,b 或重复 ?sources=a&sources=b）。

    未提供 → None（聚合搜索全部数据源）；提供 → 扁平化去空后的来源列表。
    """
    raw = request.args.getlist("sources") or request.args.getlist("source")
    if not raw:
        return None
    flat: list[str] = []
    for item in raw:
        for part in str(item).split(","):
            part = part.strip()
            if part:
                flat.append(part)
    return flat


@api.get("/search")
def search():
    q = (request.args.get("q") or "").strip()
    # 结构化多字段检索：任一结构化参数（title/abstract/keywords/author/fulltext/年份）出现即走字段化搜索
    title = (request.args.get("title") or "").strip()
    abstract = (request.args.get("abstract") or "").strip()
    keywords = (request.args.get("keywords") or "").strip()
    author = (request.args.get("author") or "").strip()
    fulltext = (request.args.get("fulltext") or "").strip()
    year_from = _parse_year(request.args.get("year_from"))
    year_to = _parse_year(request.args.get("year_to"))
    has_structured = bool(title or abstract or keywords or author or fulltext
                          or year_from is not None or year_to is not None)
    sources = _search_sources_param()

    if not q and not has_structured:
        raise ApiError(tr("api.search.missing_query"))
    try:
        limit = int(request.args.get("limit", "10"))
    except ValueError:
        limit = 10
    limit = max(1, min(limit, 50))

    try:
        if has_structured:
            sq = SearchQuery(
                title=title, abstract=abstract, keywords=keywords,
                author=author, fulltext=fulltext,
                year_from=year_from, year_to=year_to, limit=limit,
            )
            if sq.is_empty:
                raise ApiError(tr("api.search.structured_empty"))
            result = search_papers_structured(sq, sources)
        else:
            result = search_papers_keyword(q, limit, sources)
    except ValueError as exc:
        # 未知来源 / 空检索条件 → 参数错误（400），而非服务内部错误
        raise ApiError(str(exc)) from exc
    except RuntimeError as exc:
        # 单一来源检索失败，或全部来源均失败（如 SS 限流 + 网络异常）→ 上游数据源不可用
        raise ApiError(str(exc), 502) from exc

    return jsonify({
        "provider": result.provider,
        # 各数据源命中状态：让前端如实告知"哪个源没返回、为什么"
        "sources": [o.to_dict() for o in result.outcomes],
        "papers": [p.to_dict() for p in result.papers],
    })


# ---------- 论文详情 ----------
@api.get("/paper/<path:paper_id>")
def get_paper(paper_id: str):
    if paper_id.startswith("local:"):
        return jsonify(_local_paper_meta(paper_id))

    source, external_id = _split_id(paper_id)

    cached = db.get_paper(paper_id)
    if cached and cached.get("title"):
        return jsonify(cached)

    provider = get_provider(source)
    try:
        paper = provider.get_paper(external_id)
    except LookupError as exc:
        raise ApiError(str(exc), 404) from exc

    db.upsert_paper(
        paper_id=paper.id, title=paper.title, authors=paper.authors, year=paper.year,
        abstract=paper.abstract, source=paper.source, external_id=paper.external_id,
        url=paper.url, pdf_url=paper.pdf_url, doi=paper.doi,
        citation_count=paper.citation_count,
    )
    return jsonify(paper.to_dict())


def _list_endpoint(paper_id: str, kind: str):
    # 本地文献无引用/被引数据
    if paper_id.startswith("local:"):
        return jsonify({"papers": []})
    source, external_id = _split_id(paper_id)
    provider = get_provider(source)
    try:
        limit = int(request.args.get("limit", "100"))
    except ValueError:
        limit = 100
    limit = max(1, min(limit, 200))
    if kind == "references":
        papers = provider.get_references(external_id, limit)
    else:
        papers = provider.get_citations(external_id, limit)
    return jsonify({"papers": [p.to_dict() for p in papers]})


@api.get("/paper/<path:paper_id>/references")
def references(paper_id: str):
    return _list_endpoint(paper_id, "references")


@api.get("/paper/<path:paper_id>/citations")
def citations(paper_id: str):
    return _list_endpoint(paper_id, "citations")


# ---------- 全文 ----------
@api.get("/paper/<path:paper_id>/fulltext")
def fulltext(paper_id: str):
    if paper_id.startswith("local:"):
        text = get_paper_fulltext(paper_id)
        if not text:
            raise ApiError(tr("api.fulltext.local_parse_failed"), 404)
        _local_paper_meta(paper_id)  # 确保元数据已注册
        return jsonify({"paper_id": paper_id, "fulltext": text})

    source, external_id = _split_id(paper_id)

    cached_text = db.get_fulltext(paper_id)
    if cached_text:
        return jsonify({"paper_id": paper_id, "fulltext": cached_text})

    provider = get_provider(source)
    paper = provider.get_paper(external_id)
    text = provider.get_fulltext(paper)
    if not text:
        raise ApiError(tr("api.fulltext.unavailable"), 404)

    db.upsert_paper(
        paper_id=paper.id, title=paper.title, authors=paper.authors, year=paper.year,
        abstract=paper.abstract, source=paper.source, external_id=paper.external_id,
        url=paper.url, pdf_url=paper.pdf_url, doi=paper.doi,
        citation_count=paper.citation_count,
    )
    # 全文入库门禁：仅上下文库 paper 成员持久化全文（其余论文只返回不落库）
    if db.is_curated_paper(paper_id):
        db.save_fulltext(paper_id, text)
    return jsonify({"paper_id": paper_id, "fulltext": text})


# ---------- PDF 二进制（阅读器用） ----------
@api.get("/paper/<path:paper_id>/pdf")
def paper_pdf(paper_id: str):
    """返回论文 PDF 二进制流，供前端 PDF.js 渲染。

    - 磁盘缓存命中 → 直接返回（支持 Range 请求）
    - 未命中 → 从数据源下载并缓存后返回
    """
    # 本地文献：直接从工作区读取 PDF（不经磁盘缓存，源文件即权威副本）
    if paper_id.startswith("local:"):
        data = local_pdf_bytes(paper_id)
        if not data:
            db.set_pdf_status(paper_id, "unavailable", tr("api.local_file_missing"))
            raise ApiError(tr("api.local_file_missing"), 404)
        split = split_local_id(paper_id)
        assert split is not None  # 已确认 local 前缀
        return send_file(
            ws.resolve(*split),
            mimetype="application/pdf",
            as_attachment=False,
            conditional=True,  # 启用 Range 支持，PDF.js 分段加载
            max_age=3600,
        )

    source, external_id = _split_id(paper_id)
    # 磁盘缓存文件名：把 id 中的 ':' 替换为安全字符
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", paper_id)
    cache_path = PDF_DIR / f"{safe_name}.pdf"

    if not cache_path.exists():
        provider = get_provider(source)
        paper = provider.get_paper(external_id)
        if not paper.pdf_url:
            db.set_pdf_status(paper_id, "unavailable", tr("api.pdf.not_available"))
            raise ApiError(tr("api.pdf.not_available"), 404)
        try:
            content = download_pdf(paper.pdf_url)
        except PdfDownloadError as exc:
            # 区分 403/404/网络失败等具体原因，避免笼统报"无法下载"
            # 同时落"不可打开"标记：前端自动探测只试一次，失败后仅手动刷新，避免反复限流
            db.set_pdf_status(
                paper_id, "unavailable",
                tr("api.pdf.download_failed", reason=exc.reason),
            )
            status = 404 if exc.status_code == 404 else 502
            raise ApiError(tr("api.pdf.download_failed", reason=exc.reason), status) from exc
        # 原子写入缓存，避免并发半文件
        tmp_path = cache_path.with_suffix(".pdf.tmp")
        tmp_path.write_bytes(content)
        tmp_path.replace(cache_path)
        # 下载成功：清除可能存在的历史不可打开标记
        db.set_pdf_status(paper_id, "available")

    return send_file(
        cache_path,
        mimetype="application/pdf",
        as_attachment=False,
        conditional=True,  # 启用 Range 支持，PDF.js 分段加载
        max_age=3600,
    )


# ---------- RAG 问答 ----------
@api.post("/rag")
def rag():
    body = request.get_json(silent=True) or {}
    paper_id = (body.get("paper_id") or "").strip()
    question = (body.get("question") or "").strip()
    use_context = bool(body.get("use_context", True))
    context_ids = body.get("context_ids") or []
    exclude_ids = body.get("exclude_ids") or []
    history = body.get("history") or []
    workspace_id = _ws_scope(body.get("workspace_id") or "")
    if not paper_id:
        raise ApiError(tr("api.rag.missing_paper_id"))
    if not question:
        raise ApiError(tr("api.rag.missing_question"))

    # 规整 id 列表
    context_ids = [int(x) for x in context_ids if str(x).lstrip("-").isdigit()]
    exclude_ids = [int(x) for x in exclude_ids if str(x).lstrip("-").isdigit()]

    # 当前论文元数据（作为候选 id=0，由 AI 依据问题决定是否阅读全文）
    paper_meta = _paper_meta(paper_id)
    paper_title = paper_meta.get("title") or paper_id
    current_candidate = {
        "id": 0,
        "title": paper_title,
        "summary": paper_meta.get("abstract") or "（无摘要，标题见上）",
    }

    try:
        engine = build_rag_engine()
    except LLMNotConfiguredError as exc:
        raise ApiError(str(exc), 503) from exc

    # 混合模式：AI 依据摘要判定读哪些候选（当前论文 + 当前工作区上下文库）
    selected_ids = _select_materials(
        question, use_context, context_ids, exclude_ids,
        engine, current_candidate, workspace_id,
    )

    # 按需读取选中候选的全文（未选中的完全不读，节约时间与 token）
    sources: list[dict] = []
    for sid in selected_ids:
        if sid == 0:
            fulltext = _paper_fulltext(paper_id)
            if fulltext:
                sources.append({
                    "label": paper_title,
                    "text": fulltext,
                    "context_id": None,
                    "paper_id": paper_id,
                })
            continue
        item = db.get_context_item(sid)
        if not item:
            continue
        text = _context_fulltext(item)
        if text:
            sources.append({
                "label": item["title"],
                "text": text,
                "context_id": sid,
                "paper_id": item["type"] == "paper" and item.get("ref_id") or None,
            })

    if not sources:
        raise ApiError(tr("api.rag.no_evidence"), 404)

    result = engine.answer_multi(question, sources, paper_meta, history)
    return jsonify(result)


@api.post("/rag/stream")
def rag_stream():
    """SSE 流式 RAG：自动 ReAct 循环，把思考/动作/观察实时写进聊天记录。

    事件序列：
      stage（阶段进度）→ [thought 思考增量 → react_action 动作（自动执行，无需确认）
      → mindmap_diff（仅导图编辑：增量差异实时落图）? → observation 观察结果]×N
      → sources（出处分块）→ delta（回答增量，其中内联经校验的
      [Q:N]...[/Q:N] 引用块标签）→ done（answer 含最终引用块标签、
      sources 含 quote）/error。
    材料充足时不会出现工具动作，直接 sources → delta → done/error。
    前端把 thought/react_action/observation 实时渲染为 ReAct 步骤，完成后折叠进 toolLog
    持久化；生成过程中可随时 POST /rag/cancel（body: run_id）停止。
    """
    body = request.get_json(silent=True) or {}
    paper_id = (body.get("paper_id") or "").strip()
    question = (body.get("question") or "").strip()
    use_context = bool(body.get("use_context", True))
    enable_tool = bool(body.get("enable_tool", True))
    context_ids = body.get("context_ids") or []
    exclude_ids = body.get("exclude_ids") or []
    history = body.get("history") or []
    workspace_id = _ws_scope(body.get("workspace_id") or "")
    # 当前正在编辑的文档（LaTeX，写作场景）：仅作为 read_document 工具的读取资源，
    # 不随提问无条件注入，由 LLM 在写作任务中主动请求读取
    document = (body.get("document") or "").strip()
    run_id = (body.get("run_id") or "").strip() or uuid.uuid4().hex
    # paper_id 可选：无论文时仅基于上下文库/当前文档/外部检索作答（如写作、通用问答）
    if not question:
        raise ApiError(tr("api.rag.missing_question"))
    context_ids = [int(x) for x in context_ids if str(x).lstrip("-").isdigit()]
    exclude_ids = [int(x) for x in exclude_ids if str(x).lstrip("-").isdigit()]

    def generate():
        def emit(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        _register_run(run_id)
        try:
            # 当前论文作为候选 id=0（AI 依据问题决定是否阅读全文）；无 paper 时不纳入
            paper_meta: dict = {}
            paper_title = ""
            current_candidate: dict | None = None
            if paper_id:
                paper_meta = _paper_meta(paper_id)
                paper_title = paper_meta.get("title") or paper_id
                current_candidate = {
                    "id": 0,
                    "title": paper_title,
                    "summary": paper_meta.get("abstract") or "（无摘要，标题见上）",
                    # 真实论文 id 仅用于 ReAct 提示：步骤一自动读取失败时，
                    # 允许 LLM 用该 id 经 read_paper 显式重试（编号 0 本身不可传）
                    "paper_id": paper_id,
                }

            try:
                engine = build_rag_engine()
            except LLMNotConfiguredError as exc:
                yield emit("error", {"message": str(exc)})
                return

            # ---- 候选材料（当前论文 + 当前工作区上下文库）----
            # 保留 type/ref_id：ReAct 工具循环的提示需据此给出真实论文 id，
            # 避免 LLM 把内部选材编号（[0]/[9]）误当 read_paper 的 paper_id
            summaries = [
                {
                    "id": it["id"], "title": it["title"], "summary": it["summary"],
                    "type": it.get("type"), "ref_id": it.get("ref_id"),
                }
                for it in db.list_context_items(workspace_id=workspace_id)
                if it["id"] not in exclude_ids and it.get("status") != "failed"
            ] if use_context else []
            # 用户"固定"的上下文无条件进入候选读取
            forced_ids = [cid for cid in context_ids if cid not in exclude_ids]

            materials: list[dict] = []
            # 步骤一读取候选材料的结果摘要：供 ReAct 工具循环的 LLM 决策（成功/部分失败/全失败）
            material_note: str | None = None

            # ---- ReAct 步骤一：判断并读取候选材料（思考流式输出 → 自动读取） ----
            if current_candidate or summaries:
                yield emit("stage", {"label": tr("api.stage.selecting_materials")})
                selected: list[int] = []
                try:
                    for ev in engine.select_materials_reasoning(
                        question, summaries, current=current_candidate,
                    ):
                        if ev["type"] == "thought":
                            yield emit("thought", {"delta": ev["delta"]})
                        else:
                            selected = ev["ids"]
                except Exception as exc:
                    yield emit("observation", {
                        "tool_name": "read_materials",
                        "tool_label": _tool_label("read_materials"),
                        "status": "error", "provider": None, "papers": [],
                        "tool_message": tr("api.read_materials.select_failed", exc=exc),
                    })
                    selected = []
                selected_ids = list(dict.fromkeys([*selected, *forced_ids]))
                if selected_ids and not _request_cancelled(run_id):
                    yield emit("react_action", {
                        "tool_name": "read_materials",
                        "tool_label": _tool_label("read_materials"),
                        "arguments": {}, "thought": "",
                    })
                    read_failures: list[str] = []
                    read_warnings: list[str] = []
                    sources = yield from _read_selected_sources(
                        selected_ids, paper_id, paper_title, emit, read_failures,
                        warnings=read_warnings,
                        paper_abstract=paper_meta.get("abstract") or "",
                    )
                    for src in sources:
                        _merge_material(materials, src)
                    # 只要发出了读取动作（selected_ids 非空），就必然给出 observation：
                    # 全部成功/部分成功/全部失败都如实反馈，避免前端步骤悬停在"执行中"
                    if not _request_cancelled(run_id):
                        if materials:
                            labels = [m.get("label") for m in materials if m.get("label")]
                            shown = tr("api.separator.list").join(str(x) for x in labels[:6])
                            if len(labels) > 6:
                                shown += tr("api.more_items", n=len(labels))
                            detail = tr("api.read_materials.read_ok", n=len(materials),
                                         shown=shown or tr("api.read_materials.empty"))
                            if read_warnings:
                                # 降级成功（如仅有摘要）：材料可用但依据打折扣
                                detail += tr("api.read_materials.some_degraded",
                                             n=len(read_warnings),
                                             reasons=_join_reasons(read_warnings))
                            if read_failures:
                                detail += tr("api.read_materials.some_failed",
                                             n=len(read_failures), reasons=_join_reasons(read_failures))
                            material_note = detail
                            yield emit("observation", {
                                "tool_name": "read_materials",
                                "tool_label": _tool_label("read_materials"),
                                "status": "done", "provider": None, "papers": [],
                                "tool_message": detail,
                            })
                        else:
                            reasons = _join_reasons(read_failures) or tr("api.read_materials.none_usable")
                            material_note = tr("api.read_materials.all_failed", reasons=reasons)
                            yield emit("observation", {
                                "tool_name": "read_materials",
                                "tool_label": _tool_label("read_materials"),
                                "status": "error", "provider": None, "papers": [],
                                "tool_message": material_note,
                            })

            # ---- ReAct 步骤二：自动工具循环（AI 自主思考 → 执行工具 → 观察结果） ----
            if enable_tool and not _request_cancelled(run_id):
                # 本次问答的 AI 导图编辑事务：同一会话的全部导图写共享一个 ID，
                # 用户可按"一问一事务"整体撤销（修订表持久化，离会也可撤最近一次）
                mindmap_txn_id = "mmtx_" + uuid.uuid4().hex[:12]
                mindmap_events: list[dict] = []
                tool_system, tool_user = _react_loop_prompt(
                    question, summaries, current_candidate, document or None,
                    material_note=material_note,
                )
                messages = [
                    {"role": "system", "content": tool_system},
                    {"role": "user", "content": tool_user},
                ]
                last_sig: str | None = None
                for _ in range(_REACT_MAX_TURNS):
                    if _request_cancelled(run_id):
                        yield emit("error", {"message": tr("api.stopped")})
                        return
                    yield emit("stage", {"label": tr("api.stage.thinking_next")})
                    tool: dict | None = None
                    thought = ""
                    try:
                        for ev in engine.client.chat_stream_tool_call(
                            messages, tools=_TOOL_REGISTRY.schemas(), temperature=0,
                        ):
                            if ev["type"] == "thought":
                                thought += ev["delta"]
                                yield emit("thought", {"delta": ev["delta"]})
                            else:
                                tool = ev["tool"]
                    except Exception as exc:
                        yield emit("stage", {"label": tr("api.stage.thought_failed", exc=exc)})
                        break
                    if _request_cancelled(run_id):
                        yield emit("error", {"message": tr("api.stopped")})
                        return
                    if not tool:
                        break  # AI 判定材料已足够（READY）→ 进入回答
                    name = tool.get("name") or ""
                    try:
                        _TOOL_REGISTRY.get(name)
                    except KeyError:
                        # LLM 幻觉出未注册工具：停止循环，避免死循环
                        yield emit("stage", {"label": tr("api.stage.unknown_tool", name=name)})
                        break
                    arguments = tool.get("arguments") or {}
                    sig = name + json.dumps(arguments, sort_keys=True, ensure_ascii=False)
                    if sig == last_sig:
                        # 同一工具同一参数连续两次 → 判定无进展，停止循环
                        yield emit("stage", {"label": tr("api.stage.no_progress")})
                        break
                    last_sig = sig
                    if _request_cancelled(run_id):
                        yield emit("error", {"message": tr("api.stopped")})
                        return
                    tool_label = _tool_label(name)
                    yield emit("react_action", {
                        "tool_name": name, "tool_label": tool_label,
                        "arguments": arguments, "thought": thought,
                    })
                    try:
                        result = _TOOL_REGISTRY.execute(
                            name, arguments,
                            context={
                                "document": document or None,
                                # 导图工具：作用域隔离 + 一问一事务 + SSE 事件收集
                                "scope": workspace_id,
                                "transaction_id": mindmap_txn_id,
                                "mindmap_events": mindmap_events,
                            },
                        )
                    except Exception as exc:
                        yield emit("observation", {
                            "tool_name": name, "tool_label": tool_label,
                            "status": "error", "provider": None, "papers": [],
                            "tool_message": tr("api.tool_exec_failed", tool_label=tool_label, exc=exc),
                        })
                        break
                    # 导图编辑先以增量差异实时落图，再给 observation 文本
                    for mm_event in mindmap_events:
                        yield emit("mindmap_diff", mm_event)
                    mindmap_events.clear()
                    data = result.data or {}
                    papers = data.get("papers") or []
                    yield emit("observation", {
                        "tool_name": name, "tool_label": tool_label,
                        "status": "done", "provider": data.get("provider"),
                        "papers": papers, "tool_message": result.content[:6000],
                    })
                    # 工具读到的全文 / 当前文档 → 进入最终检索的材料池
                    for ft in data.get("fulltexts") or []:
                        if (ft.get("text") or "").strip():
                            _merge_material(materials, {
                                "label": ft.get("title") or ft.get("id") or tr("api.material_label.paper"),
                                "text": ft["text"],
                                "context_id": None,
                                "paper_id": ft.get("id"),
                            })
                    if (data.get("document") or "").strip() and document:
                        _merge_material(materials, {
                            "label": tr("api.material_label.document"), "text": document,
                            "context_id": None, "paper_id": None,
                        })
                    # paper_search 返回的候选摘要 → 兜底来源（全文读出后被 merge 覆盖）
                    for p in papers[:5]:
                        abstract = (p.get("abstract") or "").strip()
                        if not abstract:
                            continue
                        _merge_material(materials, {
                            "label": p.get("title") or p.get("id") or tr("api.material_label.candidate"),
                            "text": abstract,
                            "context_id": None,
                            "paper_id": p.get("id"),
                        })
                    # 把"assistant 思考+工具调用"与"tool 观察结果"追加进对话，供下一步决策
                    tid = tool.get("call_id") or f"call_{int(time.time() * 1000)}"
                    messages.append({
                        "role": "assistant",
                        "content": (thought or "").strip()[:1000] or f"（思考省略）准备调用 {tool_label}。",
                        "tool_calls": [{
                            "id": tid,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments, ensure_ascii=False),
                            },
                        }],
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tid,
                        "content": result.content[:6000],
                    })

            # ---- ReAct 步骤三：检索材料并流式生成最终回答 ----
            yield from _answer_events(
                engine, question, materials, paper_meta, history, emit,
                material_note=material_note,
            )
        except ApiError as exc:
            yield emit("error", {"message": exc.message})
        except Exception as exc:
            yield emit("error", {"message": tr("api.rag.failed", exc=exc)})
        finally:
            _unregister_run(run_id)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------- 停止正在运行的 ReAct 生成 ----------
@api.post("/rag/cancel")
def rag_cancel():
    body = request.get_json(silent=True) or {}
    run_id = (body.get("run_id") or "").strip()
    if run_id:
        _cancel_run(run_id)
    return jsonify({"ok": True})



# ---------- 全局工作区快照 ----------
# project_id 区分状态归属：'default'=未选择工作区（全局）；
# 'ws:<workspace_id>'=对应工作区独立状态（各工作区页面状态互相隔离）。
_DEFAULT_PROJECT = "default"
_STATE_KEY = "workspace"


def _project_id_from_ws(workspace_id: str) -> str:
    """把工作区 id 映射为状态 project_id（空串/未提供 → 全局 default）。"""
    ws_id = (workspace_id or "").strip()
    return f"ws:{ws_id}" if ws_id else _DEFAULT_PROJECT


@api.get("/state")
def state_get():
    project = _project_id_from_ws(request.args.get("project") or "")
    snapshots = db.load_app_state(project)
    return jsonify({"project_id": project, "state": snapshots.get(_STATE_KEY, {})})


@api.put("/state")
def state_put():
    body = request.get_json(silent=True) or {}
    state = body.get("state")
    if not isinstance(state, dict):
        raise ApiError(tr("api.state.invalid"))
    project = _project_id_from_ws((body.get("project") or "").strip())
    db.save_app_state(project, _STATE_KEY, state)
    return jsonify({"ok": True})


# ---------- 问答会话标题（首条提问 → AI 短标题） ----------
_TITLE_MAX_CHARS = 40
_TITLE_QUERY_MAX_CHARS = 1000


@api.post("/chat/title")
def chat_title():
    body = request.get_json(silent=True) or {}
    query = (body.get("query") or "").strip()
    if not query:
        raise ApiError(tr("api.chat_title.empty"))
    query = re.sub(r"\s+", " ", query)[:_TITLE_QUERY_MAX_CHARS]
    try:
        client = LLMClient()
    except LLMNotConfiguredError as err:
        # 前端会静默保留本地占位标题，400 仅用于表达"标题服务不可用"
        raise ApiError(str(err), 400) from err
    system = (
        "You generate a very short title for a research-assistant chat conversation, "
        "based ONLY on the user's first message.\n"
        "Rules:\n"
        "1. Use the SAME language as the user's message "
        "(a Chinese question must produce a Chinese title).\n"
        "2. At most 20 CJK characters, or at most 8 English words; "
        "capture the core topic, not the full sentence.\n"
        "3. Output the title ONLY: no quotation marks, brackets, numbering, "
        "a prefix such as \"Title:\" / \"标题：\", Markdown, explanation, "
        "or trailing sentence punctuation."
    )
    resp = client.chat(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": query},
        ],
        temperature=0.2,
    )
    title = (resp.get("content") or "").strip()
    # 清洗模型偶发的包装：标题前缀、引号/书名号、首尾句读与多余空白
    title = re.sub(r"^\s*(?:标题|Title)\s*[:：]\s*", "", title, flags=re.IGNORECASE)
    title = title.strip(" \t\r\n\"'“”‘’「」『』《》【】#*`")
    title = re.sub(r"[。！？!?.,，：:；;…\s]+$", "", title).strip()
    title = re.sub(r"\s+", " ", title)[:_TITLE_MAX_CHARS].strip()
    return jsonify({"title": title})


# ---------- 笔记 ----------
@api.get("/papers")
def papers_history():
    return jsonify({"papers": db.list_papers()})


@api.get("/papers/<paper_id>/notes")
def notes_list(paper_id: str):
    return jsonify({"notes": db.list_notes(paper_id)})


@api.post("/papers/<paper_id>/notes")
def notes_create(paper_id: str):
    body = request.get_json(silent=True) or {}
    content = (body.get("content") or "").strip()
    if not content:
        raise ApiError(tr("api.note.empty"))
    note_id = db.add_note(paper_id, content)
    return jsonify({"id": note_id}), 201


@api.delete("/notes/<int:note_id>")
def notes_delete(note_id: int):
    db.delete_note(note_id)
    return jsonify({"ok": True})


# ---------- 上下文库 ----------
@api.get("/context")
def context_list():
    """列表（不含 content 全文，保持轻量）。``?workspace_id=`` 按工作区过滤
    （缺省为全局库）。paper 项附带 pdf_status/pdf_error 可打开性标记。"""
    ws_id = _ws_scope(request.args.get("workspace_id"))
    items = db.list_context_items(include_content=False, workspace_id=ws_id)
    return jsonify({"items": _serialize_context_items(items)})


@api.post("/context")
def context_create():
    body = request.get_json(silent=True) or {}
    item_type = (body.get("type") or "").strip()
    if item_type == "paper":
        return _create_paper_context(body)
    if item_type == "url":
        return _create_url_context(body)
    raise ApiError(tr("api.context.invalid_type"))


def _create_paper_context(body: dict):
    """paper 类型：从论文实例导入，摘要取 abstract（无则 LLM 生成）。

    支持 ``summary_override``：PDF 选中文本存为摘录时，以选中文本为摘要。

    全文策略（2026-09-11）：加入上下文即**自动尝试一次**获取全文——条目先落库
    成为"受管收藏"（db.is_curated_paper），随后三级缓存未命中才发起一次远程
    下载，成功的全文可持久化进 papers.fulltext；失败只落 unavailable 标记，
    不再自动重试，由用户在界面手动刷新，避免触发数据源限流。
    """
    paper_id = (body.get("paper_id") or "").strip()
    if not paper_id:
        raise ApiError(tr("api.context.paper_requires_id"))
    workspace_id = _ws_scope(body.get("workspace_id") or "")
    summary_override = (body.get("summary_override") or "").strip()
    # 幂等：同作用域已收录过该论文（纯元数据导入，无选中摘录）→ 直接返回现有，
    # 避免"阅读焦点自动加库"等重复调用把同一篇论文堆成多条。
    if not summary_override:
        existing_id = _find_existing_context("paper", workspace_id, "ref_id", paper_id)
        if existing_id is not None:
            # 历史条目可能从未探测过全文：仅在无标记时补一次自动尝试
            if db.get_pdf_status(paper_id) is None:
                _ensure_fulltext_once(paper_id)
            return jsonify(_serialize_context_item(db.get_context_item(existing_id)))
    meta = _paper_meta(paper_id)
    title = meta.get("title") or paper_id
    abstract = (meta.get("abstract") or "").strip()
    # 先插入条目（自此成为受管收藏，全文获取命中入库门禁），再取全文与生成摘要
    item_id = db.add_context_item(
        item_type="paper", title=title, summary=summary_override or abstract,
        ref_id=paper_id, tags=[], status="ready",
        content=json.dumps(meta, ensure_ascii=False),
        workspace_id=workspace_id,
    )
    # 选中摘录不额外触发全文探测（同一论文通常已随主条目探测过）
    if not summary_override:
        text, _reason = _ensure_fulltext_once(paper_id)
        # 无摘要 → 用刚取到的全文生成；取不到则摘要留空（卡片展示标记与原因）
        if not abstract:
            summary = _make_summary(text, title)
            if summary:
                db.update_context_item(item_id, summary=summary)
    return jsonify(_serialize_context_item(db.get_context_item(item_id))), 201


def _create_url_context(body: dict):
    """url 类型：抓取网页正文 → LLM 摘要（无 key 降级截取）。"""
    url = (body.get("url") or "").strip()
    if not url:
        raise ApiError(tr("api.context.url_requires_url"))
    workspace_id = _ws_scope(body.get("workspace_id") or "")
    # 幂等：同作用域已收录过该网页 → 直接返回现有，避免重复抓取与堆叠
    existing_id = _find_existing_context("url", workspace_id, "url", url)
    if existing_id is not None:
        return jsonify(db.get_context_item(existing_id))
    try:
        page = fetch_webpage(url)
    except ValueError as exc:
        raise ApiError(str(exc), 400) from exc
    except Exception as exc:
        raise ApiError(tr("api.context.fetch_failed", exc=exc), 502) from exc
    summary = _make_summary(page["text"], page["title"])
    item_id = db.add_context_item(
        item_type="url", title=page["title"], summary=summary,
        url=url, tags=[], status="ready",
        content=json.dumps(page["text"], ensure_ascii=False),
        workspace_id=workspace_id,
    )
    return jsonify(_serialize_context_item(db.get_context_item(item_id))), 201


@api.get("/context/<int:item_id>/content")
def context_content(item_id: int):
    """按需取 context 项的全文内容（RAG 或前端展开用）。"""
    item = db.get_context_item(item_id)
    if not item:
        raise ApiError(tr("api.context.not_found"), 404)
    text = _context_fulltext(item)
    return jsonify({
        "id": item_id,
        "type": item["type"],
        "title": item["title"],
        "text": text,
    })


@api.put("/context/<int:item_id>")
def context_update(item_id: int):
    """更新 title / summary / tags（用户手动编辑摘要与分组）。"""
    item = db.get_context_item(item_id)
    if not item:
        raise ApiError(tr("api.context.not_found"), 404)
    body = request.get_json(silent=True) or {}
    title = body.get("title")
    summary = body.get("summary")
    tags = body.get("tags")
    if title is not None and not str(title).strip():
        raise ApiError(tr("api.title_required"))
    if tags is not None and not isinstance(tags, list):
        raise ApiError(tr("api.context.tags_must_be_array"))
    db.update_context_item(
        item_id,
        title=str(title).strip() if title is not None else None,
        summary=str(summary).strip() if summary is not None else None,
        tags=[str(t).strip() for t in tags if str(t).strip()] if tags is not None else None,
    )
    return jsonify(_serialize_context_item(db.get_context_item(item_id)))


@api.post("/context/<int:item_id>/retry-pdf")
def context_retry_pdf(item_id: int):
    """手动重新尝试获取某条 paper 上下文的全文/PDF（唯一允许的失败后重试入口）。

    自动探测只在「打开」与「加入上下文」时发生一次；失败后只落 unavailable
    标记，前端展示「无法打开」与刷新按钮，由用户点按钮显式触发本路由，
    避免自动重试反复打到数据源触发限流。无论这次成功与否都返回 200 与最新标记，
    前端据 pdf_status 更新徽标；仅条目缺失等请求级错误才报错。
    """
    item = db.get_context_item(item_id)
    if not item:
        raise ApiError(tr("api.context.not_found"), 404)
    if item["type"] != "paper":
        raise ApiError(tr("api.context.invalid_type"))
    ref_id = (item.get("ref_id") or "").strip()
    if not ref_id:
        raise ApiError(tr("api.context.paper_requires_id"))
    _ensure_fulltext_once(ref_id)
    return jsonify(_serialize_context_item(db.get_context_item(item_id)))


@api.post("/context/<int:item_id>/refresh")
def context_refresh(item_id: int):
    """重新生成摘要 / 重新抓取网页，更新内容缓存。"""
    item = db.get_context_item(item_id)
    if not item:
        raise ApiError(tr("api.context.not_found"), 404)
    if item["type"] == "paper":
        meta = _paper_meta(item.get("ref_id") or "")
        abstract = meta.get("abstract") or ""
        # 重新生成摘要同样只经三级缓存取一次全文，并刷新可打开性标记
        text, _reason = _ensure_fulltext_once(item["ref_id"])
        summary = abstract or _make_summary(text, meta.get("title") or "")
        db.update_context_item(item_id, summary=summary, status="ready")
    else:
        url = item.get("url") or ""
        try:
            page = fetch_webpage(url)
        except Exception as exc:
            raise ApiError(tr("api.context.refetch_failed", exc=exc), 502) from exc
        summary = _make_summary(page["text"], page["title"])
        db.update_context_item(item_id, title=page["title"], summary=summary, status="ready")
        db.set_context_content(item_id, json.dumps(page["text"], ensure_ascii=False))
    return jsonify(_serialize_context_item(db.get_context_item(item_id)))


@api.delete("/context/<int:item_id>")
def context_delete(item_id: int):
    db.delete_context_item(item_id)
    return jsonify({"ok": True})


# ---------- 数据块 ----------
@api.get("/data-blocks")
def data_blocks_list():
    paper_id = request.args.get("paper_id")
    blocks = db.list_data_blocks(paper_id)
    for b in blocks:
        import json
        try:
            b["content"] = json.loads(b["content"])
        except json.JSONDecodeError:
            pass
    return jsonify({"blocks": blocks})


@api.post("/data-blocks")
def data_blocks_create():
    body = request.get_json(silent=True) or {}
    paper_id = (body.get("paper_id") or "").strip()
    block_type = (body.get("type") or "").strip()
    title = (body.get("title") or "").strip()
    content = body.get("content") or {}
    if block_type not in ("chart", "table", "equation", "text"):
        raise ApiError(tr("api.data_block.invalid_type"))
    if not title:
        raise ApiError(tr("api.title_required"))
    block_id = db.add_data_block(paper_id, block_type, title, content)
    return jsonify({"id": block_id}), 201


@api.delete("/data-blocks/<int:block_id>")
def data_blocks_delete(block_id: int):
    db.delete_data_block(block_id)
    return jsonify({"ok": True})
