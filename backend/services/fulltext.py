"""论文全文获取服务：三级缓存（DB → 磁盘 PDF 本地解析 → 远程下载）。

供 RAG 问答与 ``read_paper`` 工具共用，保证同一篇论文的全文最多只下载一次，
避免重复网络请求。抽离自 routes/papers.py（原 _paper_fulltext），使工具层
可直接复用而无需依赖路由模块（避免循环导入）。
"""
from __future__ import annotations

import re
from pathlib import Path

import storage.db as db
import storage.workspace as ws
from config import PDF_DIR
from i18n import tr
from providers import get_provider
from providers.download import PdfDownloadError, download_pdf, parse_pdf_to_text


def split_paper_id(paper_id: str) -> tuple[str, str] | None:
    """拆解 ``source:external_id``；格式非法返回 None。"""
    if ":" not in paper_id:
        return None
    source, external_id = paper_id.split(":", 1)
    return source, external_id


def split_local_id(paper_id: str) -> tuple[str, str] | None:
    """解析本地文献 id ``local:<ws_id>:<rel_path>``；非 local 源返回 None。"""
    if not paper_id.startswith("local:"):
        return None
    rest = paper_id[len("local:"):]
    if ":" not in rest:
        return None
    ws_id, rel_path = rest.split(":", 1)
    return ws_id, rel_path


_KNOWN_SOURCES = ("semantic_scholar", "arxiv", "openalex", "local")
_ARXIV_ID_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$")
_OPENALEX_ID_RE = re.compile(r"^W\d+$", re.IGNORECASE)
_SS_CORPUS_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
_SS_CORPUSPREFIX_RE = re.compile(r"^CorpusId:\d+$", re.IGNORECASE)
_DOI_RE = re.compile(r"^10\.\d{4,9}/[^\s]+$", re.IGNORECASE)


def resolve_paper_identifier(raw: str) -> tuple[str | None, str]:
    """把用户/LLM 给的论文"实例唯一标识符"归一化为 canonical id。

    canonical id 统一为 ``source:external_id``（语义与搜索/DB/RAG 的 paper_id 一致），
    使 read_paper 不必依赖"本次会话 paper_search 返回的 id 列表"，DOI / arXiv 号 /
    已带前缀的 id 等任何稳定标识都能直接阅读。识别不了返回 ``(None, 原因)``。

    支持的形态：
    - 已带前缀的 canonical id：``arxiv:2103.03404``、``semantic_scholar:<paperId>``、
      ``openalex:W...``、``local:<ws_id>:<path>``
    - arXiv：``2103.03404``、``2103.03404v2``、``arXiv:2103.03404``、
      ``https://arxiv.org/abs/2103.03404``（或 /pdf/ 链接）
    - DOI：``10.48550/arXiv.2103.03404``、``doi:10.xxxx/xxx``、
      ``https://doi.org/10.xxxx/xxx``（会先映射回 arXiv）
    - Semantic Scholar：40 位十六进制 paperId、``CorpusId:<数字>``
    - OpenAlex：``W<数字>``
    """
    text = (raw or "").strip()
    if not text:
        return None, tr("pdf.identifier_empty")

    # 1) 已带数据源前缀的 canonical id：直接放行（后续 get_paper_fulltext_checked 校验）
    if ":" in text:
        source, external = text.split(":", 1)
        if source in _KNOWN_SOURCES and external.strip():
            return text, ""
        if source.lower() == "doi":
            return _resolve_doi(external)
        if source.lower() == "arxiv":
            return f"arxiv:{external.strip()}", ""
        if source.lower() in ("http", "https"):
            # https://arxiv.org/abs/... 或 https://doi.org/... 的完整链接
            return resolve_paper_identifier(text.split("://", 1)[1])

    # 2) arXiv 纯数字号（含版本）
    if _ARXIV_ID_RE.match(text):
        return f"arxiv:{text}", ""
    # 3) arXiv / DOI 的完整链接
    lower = text.lower()
    if "arxiv.org" in lower:
        seg = text.split("arxiv.org/")[-1]  # abs/<id> 或 pdf/<id> 或 <id>
        parts = [p for p in seg.replace(".pdf", "").split("/") if p]
        cand = parts[-1] if parts else ""
        if _ARXIV_ID_RE.match(cand) or cand.startswith("arXiv:"):
            return f"arxiv:{cand.replace('arXiv:', '')}", ""
    if lower.startswith("doi.org/") or lower.startswith("doi.org%2f"):
        return _resolve_doi(text.split("doi.org/")[-1].replace("%2F", "/"))
    if lower.startswith("dx.doi.org/"):
        return _resolve_doi(text.split("dx.doi.org/")[-1])

    # 4) 裸 DOI
    if _DOI_RE.match(text):
        return _resolve_doi(text)

    # 5) Semantic Scholar：40 位 paperId / CorpusId:数字
    if _SS_CORPUS_RE.match(text):
        return f"semantic_scholar:{text}", ""
    if _SS_CORPUSPREFIX_RE.match(text):
        return f"semantic_scholar:{text}", ""

    # 6) OpenAlex work id
    if _OPENALEX_ID_RE.match(text):
        return f"openalex:{text.upper()}", ""

    return None, tr("pdf.identifier_unrecognized", text=text)


def _resolve_doi(doi: str) -> tuple[str | None, str]:
    """归一化 DOI → canonical id。arXiv DOI（10.48550/arXiv.x）优先映射回 arxiv。"""
    doi = (doi or "").strip().lower()
    if doi.startswith("doi:"):
        doi = doi[4:].strip()
    if not _DOI_RE.match(doi):
        return None, tr("pdf.invalid_doi", doi=doi)
    # 10.48550/arXiv.2103.03404 → arXiv 源（保证可下载，避免经 SS 中转）
    if doi.startswith("10.48550/arxiv."):
        arxiv_id = doi[len("10.48550/arxiv."):]
        if _ARXIV_ID_RE.match(arxiv_id):
            return f"arxiv:{arxiv_id}", ""
    return f"semantic_scholar:DOI:{doi}", ""


def local_pdf_bytes(paper_id: str) -> bytes | None:
    """读取本地文献的 PDF 字节；文件缺失或非 PDF 返回 None。"""
    split = split_local_id(paper_id)
    if not split:
        return None
    try:
        data = ws.read_file(*split)
    except ws.WorkspaceError:
        return None
    return data if data.startswith(b"%PDF") else None


def pdf_cache_path(paper_id: str) -> Path:
    """磁盘 PDF 缓存路径（与 /paper/{id}/pdf 路由的命名规则一致）。"""
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", paper_id)
    return PDF_DIR / f"{safe_name}.pdf"


def get_paper_fulltext(paper_id: str) -> str:
    """获取论文全文（三级缓存，尽量只做一次网络请求）。兼容旧调用方。

    :returns: 取到返回全文；取不到返回空字符串（原因见 get_paper_fulltext_checked）
    """
    text, _ = get_paper_fulltext_checked(paper_id)
    return text


def get_paper_fulltext_checked(paper_id: str) -> tuple[str, str | None]:
    """获取论文全文（三级缓存：DB → 磁盘 PDF → 远程下载），并给出准确原因。

    区别于 :func:`get_paper_fulltext`：不再吞掉失败原因。返回 ``(全文, 原因)``：
    全文非空时原因恒为 None；全文为空时原因说明为什么拿不到——未开放 PDF /
    HTTP 403/404 / 网络失败 / PDF 无法解析 / 扫描版无文字层 等，供 read_paper
    工具、read_materials 步骤与 /paper/{id}/pdf 路由准确反馈给用户与 LLM。
    """
    cached = db.get_fulltext(paper_id)
    if cached:
        return cached, None

    # 本地文献（local:<ws_id>:<rel_path>）：直接从工作区读 PDF 解析，无网络
    if paper_id.startswith("local:"):
        data = local_pdf_bytes(paper_id)
        if not data:
            return "", tr("pdf.local_pdf_missing")
        try:
            text = parse_pdf_to_text(data)
        except Exception:
            return "", tr("pdf.parse_failed")
        if not text:
            return "", tr("pdf.no_text_layer")
        # local: 属用户自持上传文献 → 全文入库
        db.save_fulltext(paper_id, text)
        return text, None

    # 全文入库门禁：仅"受管收藏论文"（已加入上下文库的 paper 成员）允许把全文
    # 写进 papers.fulltext；其余论文读取后只保留磁盘 PDF 缓存，不落库（见
    # db.is_curated_paper）。已存在的历史 DB 缓存仍可正常命中读取。
    persist = db.is_curated_paper(paper_id)

    # 2) 磁盘 PDF 缓存：本地解析，跳过网络
    cache_path = pdf_cache_path(paper_id)
    if cache_path.exists():
        try:
            text = parse_pdf_to_text(cache_path.read_bytes())
        except Exception:
            text = ""
        if text:
            if persist:
                db.save_fulltext(paper_id, text)
            return text, None
        # 磁盘缓存损坏 → 尝试重新下载并覆盖（修复"每次都要解析坏文件再下载"的回路）
        text, reason = _download_and_parse(paper_id, cache_path, persist)
        if text:
            return text, None
        return "", tr("pdf.cache_corrupt_redownload_failed",
                      reason=reason or tr("pdf.unknown_reason"))

    # 3) 远程下载 + 解析，并回填磁盘缓存（全文入库与否取决于 persist）
    return _download_and_parse(paper_id, cache_path, persist)


def _download_and_parse(paper_id: str, cache_path: Path,
                        persist: bool) -> tuple[str, str | None]:
    """远程下载 + 解析 + 回填缓存；失败时返回面向用户的具体原因。"""
    split = split_paper_id(paper_id)
    if not split:
        return "", tr("pdf.invalid_paper_id_format")
    source, external_id = split
    try:
        paper = get_provider(source).get_paper(external_id)
    except Exception as exc:
        return "", tr("pdf.metadata_fetch_failed", exc=exc)
    if not paper.pdf_url:
        return "", tr("pdf.no_pdf_available", source=source)
    try:
        content = download_pdf(paper.pdf_url)
    except PdfDownloadError as exc:
        return "", str(exc)
    except Exception as exc:
        return "", tr("pdf.download_failed", exc=exc)
    try:
        text = parse_pdf_to_text(content)
    except Exception:
        return "", tr("pdf.downloaded_parse_failed")
    if not text:
        return "", tr("pdf.downloaded_no_text_layer")
    # 回填磁盘缓存（无论是否存在均原子覆盖，可修复损坏的旧缓存）
    try:
        tmp_path = cache_path.with_suffix(".pdf.tmp")
        tmp_path.write_bytes(content)
        tmp_path.replace(cache_path)
    except OSError:
        pass  # 磁盘写入失败不阻断（受管论文仍会把全文写入 DB）
    if persist:
        db.save_fulltext(paper_id, text)
    return text, None
