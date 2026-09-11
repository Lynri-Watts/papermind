"""SQLite 存储层：论文缓存、阅读历史、笔记、上下文库、数据块。

所有函数每次操作新建连接（SQLite 连接不可跨线程复用，Flask 默认多线程）。
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import DB_PATH

# data_blocks.content 中的 JSON 结构由前端约定：
# {
#   "type": "chart" | "table" | "equation" | "text",
#   "title": str,
#   "description": str,
#   "data": {...},   # 与类型相关的具体数据
#   "source": {"paper_title": str, "paper_id": str}
# }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source_from_id(paper_id: str) -> str:
    """从内部 id（source:external_id）解析出 source 段。"""
    return paper_id.split(":", 1)[0] if ":" in paper_id else ""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db(db_path: Path = DB_PATH) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS papers (
            id            TEXT PRIMARY KEY,   -- 内部 id: source:external_id
            title         TEXT NOT NULL,
            authors       TEXT NOT NULL DEFAULT '[]',  -- JSON list[str]
            year          INTEGER,
            abstract      TEXT NOT NULL DEFAULT '',
            source        TEXT NOT NULL,
            external_id   TEXT NOT NULL,
            url           TEXT NOT NULL DEFAULT '',
            pdf_url       TEXT,
            doi           TEXT,
            citation_count INTEGER,
            fulltext      TEXT,               -- 缓存全文
            created_at    TEXT NOT NULL
        );

        -- notes / data_blocks 的 paper_id 是逻辑引用（论文可能尚未写入
        -- papers 缓存），因此不设外键约束，仅作普通字段。
        CREATE TABLE IF NOT EXISTS notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id   TEXT NOT NULL,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS context_items (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            type         TEXT NOT NULL,          -- paper | url
            title        TEXT NOT NULL,
            summary      TEXT DEFAULT '',        -- 摘要：paper→abstract；url→网页摘要
            ref_id       TEXT,                   -- paper 时存内部 id (source:external_id)
            url          TEXT,
            tags         TEXT DEFAULT '[]',      -- JSON list[str]
            status       TEXT DEFAULT 'ready',   -- ready | pending | failed
            content      TEXT DEFAULT '',        -- JSON：paper→元数据快照；url→正文全文
            workspace_id TEXT NOT NULL DEFAULT '',  -- ''=全局；否则 ws:<workspace_id>（按工作区隔离上下文库）
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS data_blocks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id   TEXT NOT NULL,
            type       TEXT NOT NULL,          -- chart | table | equation | text
            title      TEXT NOT NULL,
            content    TEXT NOT NULL,          -- JSON
            created_at TEXT NOT NULL
        );

        -- 全局工作区快照：整份前端工作状态持久化。
        -- project_id 预留用于未来"每项目独立状态"（当前仅 default）。
        -- key 区分不同快照域；value 为 JSON。
        CREATE TABLE IF NOT EXISTS app_state (
            project_id TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      TEXT NOT NULL,          -- JSON
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, key)
        );

        -- 工作区：服务器端受控文件夹（config.WORKSPACES_ROOT/<id>/），
        -- 存放用户上传的文件与正在写作的文件。文件操作经 storage.workspace 安全层。
        CREATE TABLE IF NOT EXISTS workspaces (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT DEFAULT '',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        -- 论文 PDF/全文可打开性标记（与 papers 行解耦：仅探测过的论文才有记录）。
        -- 前端据此做"自动只试一次、失败后仅手动刷新"，避免反复触发数据源限流。
        CREATE TABLE IF NOT EXISTS paper_pdf_status (
            paper_id   TEXT PRIMARY KEY,
            status     TEXT NOT NULL,             -- available | unavailable
            error      TEXT,                      -- 最近一次失败原因（面向用户）
            checked_at TEXT NOT NULL
        );
        """
    )
    _migrate(conn)
    conn.commit()
    conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """轻量迁移：为已存在的表补充新列（旧版库无这些列）。"""
    # context_items：workspace_id 区分上下文库归属（''=全局，否则存 ws:<workspace_id>）
    ctx_cols = {r[1] for r in conn.execute("PRAGMA table_info(context_items)")}
    additions = {
        "summary": "TEXT DEFAULT ''",
        "tags": "TEXT DEFAULT '[]'",
        "status": "TEXT DEFAULT 'ready'",
        "content": "TEXT DEFAULT ''",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
        "workspace_id": "TEXT NOT NULL DEFAULT ''",
    }
    for name, ddl in additions.items():
        if name not in ctx_cols:
            conn.execute(f"ALTER TABLE context_items ADD COLUMN {name} {ddl}")


# ---------- papers ----------
def upsert_paper(paper_id: str, title: str, authors: list[str], year: int | None,
                 abstract: str, source: str, external_id: str, url: str = "",
                 pdf_url: str | None = None, doi: str | None = None,
                 citation_count: int | None = None,
                 fulltext: str | None = None) -> None:
    conn = _connect()
    conn.execute(
        """
        INSERT INTO papers
            (id, title, authors, year, abstract, source, external_id,
             url, pdf_url, doi, citation_count, fulltext, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, authors=excluded.authors, year=excluded.year,
            abstract=excluded.abstract, url=excluded.url, pdf_url=excluded.pdf_url,
            doi=excluded.doi, citation_count=excluded.citation_count,
            fulltext=COALESCE(excluded.fulltext, papers.fulltext)
        """,
        (paper_id, title, json.dumps(authors, ensure_ascii=False), year, abstract,
         source, external_id, url, pdf_url, doi, citation_count, fulltext, _now()),
    )
    conn.commit()
    conn.close()


def get_paper(paper_id: str) -> dict | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    return _parse_paper(dict(row))


def _parse_paper(row: dict) -> dict:
    """将 DB 行反序列化：authors 列存的是 JSON list[str]，读回时还原为数组。"""
    if isinstance(row.get("authors"), str):
        try:
            row["authors"] = json.loads(row["authors"])
        except (json.JSONDecodeError, TypeError):
            row["authors"] = []
    return row


def list_papers(limit: int = 50) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM papers ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [_parse_paper(dict(r)) for r in rows]


def save_fulltext(paper_id: str, fulltext: str) -> None:
    """将论文全文写入缓存。

    论文行可能尚不存在（如全文在元数据落库前就绪），故用 UPSERT 而非
    纯 UPDATE，避免 '0 rows affected' 导致缓存静默丢失、每次问答都重新解析。
    """
    conn = _connect()
    conn.execute(
        """
        INSERT INTO papers (id, title, authors, year, abstract, source,
                            external_id, url, pdf_url, doi, citation_count,
                            fulltext, created_at)
        VALUES (?, '', '[]', NULL, '', '', ?, '', NULL, NULL, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET fulltext = excluded.fulltext
        """,
        (paper_id, _source_from_id(paper_id), fulltext, _now()),
    )
    conn.commit()
    conn.close()


def get_fulltext(paper_id: str) -> str | None:
    conn = _connect()
    row = conn.execute(
        "SELECT fulltext FROM papers WHERE id = ?", (paper_id,)
    ).fetchone()
    conn.close()
    return row["fulltext"] if row else None


def is_curated_paper(paper_id: str) -> bool:
    """论文是否属于"受管收藏内容"，决定其全文可否持久化到 papers.fulltext。

    受管内容仅两类：
    - ``local:`` 本地文献：用户上传到工作区自持的 PDF（源文件即权威副本）；
    - 已被加入任一工作区/全局上下文库的 paper 成员（ref_id 命中 context_items）。

    其余论文（仅被检索/阅读、尚未收藏）的全文**不落库**：元数据照常入库，
    全文只保留磁盘 PDF 等临时缓存；远程原文一旦丢失需重新下载。
    """
    if paper_id.startswith("local:"):
        return True
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT 1 FROM context_items WHERE type = 'paper' AND ref_id = ? LIMIT 1",
            (paper_id,),
        ).fetchone()
    finally:
        conn.close()
    return row is not None


# ---------- paper_pdf_status：PDF/全文可打开性标记 ----------
def set_pdf_status(paper_id: str, status: str, error: str | None = None) -> None:
    """记录某篇论文的 PDF/全文探测结果（available/unavailable）。UPSERT。"""
    conn = _connect()
    conn.execute(
        """
        INSERT INTO paper_pdf_status (paper_id, status, error, checked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(paper_id) DO UPDATE SET
            status=excluded.status, error=excluded.error, checked_at=excluded.checked_at
        """,
        (paper_id, status, error, _now()),
    )
    conn.commit()
    conn.close()


def get_pdf_status(paper_id: str) -> dict | None:
    """取单篇标记；从未探测返回 None（语义为 unknown）。"""
    conn = _connect()
    row = conn.execute(
        "SELECT paper_id, status, error, checked_at FROM paper_pdf_status WHERE paper_id = ?",
        (paper_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_pdf_status_map(paper_ids) -> dict[str, dict]:
    """批量取标记：``{paper_id: {status,error,checked_at}}``，未探测的不在字典中。"""
    ids = [pid for pid in dict.fromkeys(paper_ids) if pid]
    if not ids:
        return {}
    conn = _connect()
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT paper_id, status, error, checked_at FROM paper_pdf_status "
        f"WHERE paper_id IN ({placeholders})",
        ids,
    ).fetchall()
    conn.close()
    return {r["paper_id"]: dict(r) for r in rows}


# ---------- notes ----------
def add_note(paper_id: str, content: str) -> int:
    conn = _connect()
    cur = conn.execute(
        "INSERT INTO notes (paper_id, content, created_at) VALUES (?, ?, ?)",
        (paper_id, content, _now()),
    )
    conn.commit()
    note_id = cur.lastrowid
    conn.close()
    return note_id


def list_notes(paper_id: str) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM notes WHERE paper_id = ? ORDER BY created_at DESC",
        (paper_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_note(note_id: int) -> None:
    conn = _connect()
    conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    conn.commit()
    conn.close()


# ---------- context_items ----------
def add_context_item(item_type: str, title: str, summary: str = "",
                     ref_id: str | None = None, url: str | None = None,
                     tags: list[str] | None = None, status: str = "ready",
                     content: str = "", workspace_id: str = "") -> int:
    now = _now()
    conn = _connect()
    cur = conn.execute(
        "INSERT INTO context_items (type, title, summary, ref_id, url, tags, status, content, workspace_id, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (item_type, title, summary, ref_id, url, json.dumps(tags or []),
         status, content, workspace_id, now, now),
    )
    conn.commit()
    item_id = cur.lastrowid
    conn.close()
    return item_id


def get_context_item(item_id: int) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM context_items WHERE id = ?", (item_id,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    item = dict(row)
    _decode_context(item)
    return item


def list_context_items(include_content: bool = False, workspace_id: str = "") -> list[dict]:
    """列出上下文项（默认不含 content 全文，保持轻量）。

    workspace_id：''=全局库；'ws:<id>'=指定工作区库。
    """
    conn = _connect()
    cols = "id, type, title, summary, ref_id, url, tags, status, created_at, updated_at"
    if include_content:
        cols += ", content"
    rows = conn.execute(
        f"SELECT {cols} FROM context_items WHERE workspace_id = ? ORDER BY id DESC",
        (workspace_id,),
    ).fetchall()
    conn.close()
    items = [dict(r) for r in rows]
    for item in items:
        _decode_context(item)
    return items


def _decode_context(item: dict) -> None:
    for key in ("tags", "content"):
        if isinstance(item.get(key), str):
            try:
                item[key] = json.loads(item[key])
            except json.JSONDecodeError:
                if key == "tags":
                    item[key] = []
                # content 解析失败则保留原始字符串（早期版本存的纯文本网页正文）


def update_context_item(item_id: int, *, title: str | None = None,
                        summary: str | None = None, tags: list[str] | None = None,
                        status: str | None = None) -> None:
    now = _now()
    updates = []
    values: list = []
    if title is not None:
        updates.append("title = ?")
        values.append(title)
    if summary is not None:
        updates.append("summary = ?")
        values.append(summary)
    if tags is not None:
        updates.append("tags = ?")
        values.append(json.dumps(tags))
    if status is not None:
        updates.append("status = ?")
        values.append(status)
    if not updates:
        return
    updates.append("updated_at = ?")
    values.append(now)
    values.append(item_id)
    conn = _connect()
    conn.execute(f"UPDATE context_items SET {', '.join(updates)} WHERE id = ?", values)
    conn.commit()
    conn.close()


def set_context_content(item_id: int, content: str) -> None:
    conn = _connect()
    conn.execute(
        "UPDATE context_items SET content = ?, updated_at = ? WHERE id = ?",
        (content, _now(), item_id),
    )
    conn.commit()
    conn.close()


def delete_context_item(item_id: int) -> None:
    conn = _connect()
    conn.execute("DELETE FROM context_items WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()


# ---------- data_blocks ----------
def add_data_block(paper_id: str, block_type: str, title: str, content: dict) -> int:
    conn = _connect()
    cur = conn.execute(
        "INSERT INTO data_blocks (paper_id, type, title, content, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (paper_id, block_type, title, json.dumps(content, ensure_ascii=False), _now()),
    )
    conn.commit()
    block_id = cur.lastrowid
    conn.close()
    return block_id


def list_data_blocks(paper_id: str | None = None) -> list[dict]:
    conn = _connect()
    if paper_id:
        rows = conn.execute(
            "SELECT * FROM data_blocks WHERE paper_id = ? ORDER BY created_at DESC",
            (paper_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM data_blocks ORDER BY created_at DESC"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_data_block(block_id: int) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM data_blocks WHERE id = ?", (block_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_data_block(block_id: int) -> None:
    conn = _connect()
    conn.execute("DELETE FROM data_blocks WHERE id = ?", (block_id,))
    conn.commit()
    conn.close()


# ---------- app_state（全局工作区快照） ----------
def save_app_state(project_id: str, key: str, value: dict) -> None:
    """保存单域快照。value 为可 JSON 序列化的对象。"""
    conn = _connect()
    conn.execute(
        """
        INSERT INTO app_state (project_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, key) DO UPDATE SET
            value=excluded.value, updated_at=excluded.updated_at
        """,
        (project_id, key, json.dumps(value, ensure_ascii=False), _now()),
    )
    conn.commit()
    conn.close()


def load_app_state(project_id: str) -> dict[str, dict]:
    """读取某项目全部快照域，返回 {key: dict}。无快照时返回空 dict。"""
    conn = _connect()
    rows = conn.execute(
        "SELECT key, value FROM app_state WHERE project_id = ?",
        (project_id,),
    ).fetchall()
    conn.close()
    result: dict[str, dict] = {}
    for row in rows:
        try:
            result[row["key"]] = json.loads(row["value"])
        except json.JSONDecodeError:
            continue
    return result


# ---------- workspaces ----------
def create_workspace(ws_id: str, name: str, description: str = "") -> None:
    now = _now()
    conn = _connect()
    conn.execute(
        "INSERT INTO workspaces (id, name, description, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (ws_id, name, description, now, now),
    )
    conn.commit()
    conn.close()


def get_workspace(ws_id: str) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM workspaces WHERE id = ?", (ws_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def list_workspaces() -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM workspaces ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_workspace(ws_id: str, *, name: str | None = None,
                     description: str | None = None) -> None:
    updates = []
    values: list = []
    if name is not None:
        updates.append("name = ?")
        values.append(name)
    if description is not None:
        updates.append("description = ?")
        values.append(description)
    if not updates:
        return
    updates.append("updated_at = ?")
    values.append(_now())
    values.append(ws_id)
    conn = _connect()
    conn.execute(f"UPDATE workspaces SET {', '.join(updates)} WHERE id = ?", values)
    conn.commit()
    conn.close()


def delete_workspace(ws_id: str) -> None:
    conn = _connect()
    conn.execute("DELETE FROM workspaces WHERE id = ?", (ws_id,))
    conn.commit()
    conn.close()
