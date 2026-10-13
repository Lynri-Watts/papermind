"""BibTeX 生成与接线（纯函数层）。

职责：
- 把 papers 表的论文元数据转成**合法** BibTeX 条目（特殊字符转义、cite key
  生成、arXiv → @misc、其余 → @article）；
- 与已有 .bib 正文去重（DOI / arXiv eprint / cite key 三重判定）；
- 探测 main.tex 的文献方案（biblatex / 经典 bibtex），给出把 .bib 文件接入
  文档所需的编辑动作（动作格式直接喂 :func:`writing_edit.apply_actions`）。

不做的事：不猜期刊/会议名（元数据里没有就不写该字段，宁缺毋伪）；不重写
用户已有的手工条目。
"""
from __future__ import annotations

import re

#: cite key 只允许 BibTeX 安全字符
_KEY_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")
#: 标题中不进入 key 的噪声词（英文）
_STOP_WORDS = {
    "a", "an", "the", "of", "on", "in", "for", "and", "or", "to", "with",
    "via", "using", "from", "by", "is", "are", "be", "based",
}
#: 已有条目里取 cite key
_ENTRY_KEY_RE = re.compile(r"@\w+\s*\{\s*([^,\s]+)\s*,", re.IGNORECASE)
_DOI_RE = re.compile(r"doi\s*=\s*[{\"\s]*(10\.\d{4,9}/[^\s}\"]+)", re.IGNORECASE)
_EPRINT_RE = re.compile(r"eprint\s*=\s*[{\"\s]*([0-9]{4}\.[0-9]{4,5}|[^\s}\"]+/[^\s}\"]+)",
                        re.IGNORECASE)
_BIBLATEX_RE = re.compile(r"\\usepackage(?:\[[^\]]*\])?\{[^}]*biblatex[^}]*\}")
_ADDBIB_RE = re.compile(r"\\addbibresource(?:\[[^\]]*\])?\{([^}]+)\}")
_BIBLIOGRAPHY_RE = re.compile(r"\\bibliography\{([^}]+)\}")
_PRINTBIB_RE = re.compile(r"\\printbibliography(?:\[[^\]]*\])?")
_END_DOC_RE = re.compile(r"\\end\{document\}")


def escape_value(value: str) -> str:
    """转义 BibTeX 字段值特殊字符。

    必须对**原始字符**单遍处理：若先全局把 ``\\`` 替换成
    ``\\textbackslash{}`` 再转义花括号，会把该命令自带的平衡括号
    二次转义成 ``\\{\\}``，排版时多出字面花括号。
    """
    out: list[str] = []
    for ch in value:
        if ch == "\\":
            out.append(r"\textbackslash{}")
        elif ch in "&%$#_{}":
            out.append("\\" + ch)
        elif ch == "~":
            out.append(r"\textasciitilde{}")
        elif ch == "^":
            out.append(r"\textasciicircum{}")
        else:
            out.append(ch)
    return "".join(out)


def _ascii_slug(text: str) -> str:
    slug = _KEY_SAFE.sub("", text)
    return slug


def make_cite_key(paper: dict, used: set[str]) -> str:
    """生成 作者姓+年份+标题首实词 形式的 key，冲突时追加 a/b/c。"""
    authors = paper.get("authors") or []
    surname = ""
    if authors and isinstance(authors[0], str):
        # 元数据作者形如 "Jane Doe" / "Doe, Jane"：取姓氏段
        first = authors[0].strip()
        surname = first.split(",")[0].strip() if "," in first else first.split()[-1]
    surname = _ascii_slug(surname).lower() or "anon"

    year = str(paper.get("year") or "n.d.")
    word = ""
    for token in re.findall(r"[A-Za-z0-9]+", paper.get("title") or ""):
        candidate = token.lower()
        if candidate not in _STOP_WORDS and len(candidate) > 2:
            word = candidate
            break
    base = _KEY_SAFE.sub("", f"{surname}{year}{word}").lower() or "ref"

    key = base
    suffix = ord("a")
    while key in used:
        key = f"{base}{chr(suffix)}"
        suffix += 1
    used.add(key)
    return key


def _format_authors(authors) -> str:
    names = [a.strip() for a in authors if isinstance(a, str) and a.strip()]
    return " and ".join(escape_value(n) for n in names)


def _eprint_id(external_id: str) -> str:
    """外部 ID → BibTeX eprint 值。

    兼容：裸新版 ``2401.01234``（可带 ``v2`` 版本尾缀）、
    ``arXiv:2401.01234`` 前缀写法、旧版分类 ID ``hep-ph/0304186v1``
    （必须保留分类前缀，仅去末尾版本号，不能按 ``/`` 截断）。
    """
    raw = (external_id or "").strip()
    if raw.lower().startswith("arxiv:"):
        raw = raw[len("arxiv:"):]
    return re.sub(r"v\d+$", "", raw)


def build_entry(paper: dict, key: str) -> str:
    """单篇论文 → BibTeX 条目文本（含尾换行）。"""
    title = escape_value((paper.get("title") or "").strip())
    year = paper.get("year")
    doi = (paper.get("doi") or "").strip()
    url = (paper.get("url") or "").strip()
    external_id = (paper.get("external_id") or "").strip()
    authors_field = _format_authors(paper.get("authors") or [])

    fields: list[tuple[str, str]] = []
    if title:
        fields.append(("title", f"{{{title}}}"))
    if authors_field:
        fields.append(("author", f"{{{authors_field}}}"))
    if year:
        fields.append(("year", f"{{{year}}}"))

    if (paper.get("source") or "") == "arxiv":
        entry_type = "misc"
        eprint = _eprint_id(external_id)
        if eprint:
            fields.append(("eprint", f"{{{eprint}}}"))
            fields.append(("archivePrefix", "{arXiv}"))
    else:
        entry_type = "article"

    if doi:
        fields.append(("doi", f"{{{escape_value(doi)}}}"))
    if url:
        fields.append(("url", f"{{{escape_value(url)}}}"))

    body = ",\n".join(f"  {name} = {value}" for name, value in fields)
    return f"@{entry_type}{{{key},\n{body}\n}}\n"


def existing_index(existing_text: str) -> tuple[set[str], set[str], set[str]]:
    """从已有 .bib 正文提取 (cite keys, DOI 集合, arXiv eprint 集合)。"""
    keys = {m.group(1).lower() for m in _ENTRY_KEY_RE.finditer(existing_text)}
    dois = {m.group(1).rstrip(".,").lower() for m in _DOI_RE.finditer(existing_text)}
    eprints = {m.group(1).lower() for m in _EPRINT_RE.finditer(existing_text)}
    return keys, dois, eprints


def build_entries(papers: list[dict], existing_text: str = "") -> list[dict]:
    """批量生成；逐篇标注 added / duplicate（重复原因带回）。

    返回 ``[{paper_id, key, entry, status, reason?}]``，保持入参顺序。
    """
    used_keys, existing_dois, existing_eprints = existing_index(existing_text)
    results: list[dict] = []
    for paper in papers:
        pid = paper.get("id") or paper.get("paper_id") or ""
        doi = (paper.get("doi") or "").strip().lower()
        eprint = ""
        if (paper.get("source") or "") == "arxiv":
            eprint = _eprint_id(paper.get("external_id") or "").lower()
        if doi and doi in existing_dois:
            results.append({"paper_id": pid, "key": "", "entry": "",
                            "status": "duplicate", "reason": "doi"})
            continue
        if eprint and eprint in existing_eprints:
            results.append({"paper_id": pid, "key": "", "entry": "",
                            "status": "duplicate", "reason": "eprint"})
            continue
        key = make_cite_key(paper, used_keys)
        results.append({"paper_id": pid, "key": key,
                        "entry": build_entry(paper, key), "status": "added"})
    return results


def detect_bib_scheme(main_tex: str) -> str | None:
    """探测文档文献方案：'biblatex' / 'classic' / None。"""
    if _BIBLATEX_RE.search(main_tex):
        return "biblatex"
    if _BIBLIOGRAPHY_RE.search(main_tex):
        return "classic"
    return None


def resource_edits(main_tex: str, scheme: str | None,
                   bib_path: str) -> list[dict]:
    """生成"把 bib_path 接入 main.tex"所需的锚点编辑动作。

    :param bib_path: 相对路径，可能带 .bib 后缀（命令中用不带后缀的名字）
    :return: writing_edit 动作列表（可能为空=已接好）；无法定位锚点时抛
             :class:`ValueError`，由调用方转可预期失败
    """
    name = bib_path[:-4] if bib_path.endswith(".bib") else bib_path
    actions: list[dict] = []

    if scheme == "biblatex":
        referenced = {m.group(1) for m in _ADDBIB_RE.finditer(main_tex)}
        if bib_path not in referenced:
            m = _BIBLATEX_RE.search(main_tex)
            if not m:
                raise ValueError("biblatex usepackage anchor not found")
            actions.append({
                "kind": "insert_after",
                "anchor": m.group(0),
                "text": f"\n\\addbibresource{{{bib_path}}}",
            })
        if not _PRINTBIB_RE.search(main_tex):
            if not _END_DOC_RE.search(main_tex):
                raise ValueError(r"\end{document} anchor not found")
            actions.append({
                "kind": "insert_before",
                "anchor": r"\end{document}",
                "text": f"\\printbibliography\n",
            })
        return actions

    # classic（或尚未使用任何文献方案）：\bibliography{...} 放文末
    m = _BIBLIOGRAPHY_RE.search(main_tex)
    if m:
        names = [n.strip() for n in m.group(1).split(",") if n.strip()]
        if name not in names:
            new_cmd = r"\bibliography{" + ",".join(names + [name]) + "}"
            actions.append({"kind": "replace", "old": m.group(0), "new": new_cmd})
    else:
        if not _END_DOC_RE.search(main_tex):
            raise ValueError(r"\end{document} anchor not found")
        actions.append({
            "kind": "insert_before",
            "anchor": r"\end{document}",
            "text": f"\\bibliography{{{name}}}\n",
        })
    return actions
