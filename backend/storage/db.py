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

        -- 应用设置（LLM 服务配置、数据源凭据、数据源启用顺序）。
        -- 由前端「设置」页维护；密钥仅存本表（随被忽略的 data/ 目录留在本机），
        -- backend/.env 只保留 HOST/PORT/DEBUG 等非敏感服务配置。
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- 思维导图：scope 沿用 context_items 约定（''=全局，'ws:<id>'=工作区）。
        -- doc 为 MindmapDoc 内容 JSON（节点树带稳定 ID/父子/order/手动坐标）；
        -- title 以本表列为准（避免与 doc 内标题双重真源）。
        CREATE TABLE IF NOT EXISTS mindmaps (
            id         TEXT PRIMARY KEY,
            scope      TEXT NOT NULL DEFAULT '',
            title      TEXT NOT NULL,
            doc        TEXT NOT NULL,          -- JSON {"nodes": [...]}
            version    INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mindmaps_scope ON mindmaps(scope);

        -- 导图修订：每次成功写入（含创建）留一行。doc 为该 version 写入后的全量
        -- 快照；actions 为产生该版本的动作 JSON；actor=user|ai|system；
        -- transaction_id 标记同一次问答内的 AI 编辑事务；undo_of 标记本版本是对
        -- 哪个 AI 事务的逆向恢复（防止同一事务被撤销两次）。仅保留最近 20 版。
        CREATE TABLE IF NOT EXISTS mindmap_revisions (
            map_id         TEXT NOT NULL,
            version        INTEGER NOT NULL,
            doc            TEXT NOT NULL,
            actions        TEXT NOT NULL DEFAULT '[]',
            actor          TEXT NOT NULL DEFAULT 'user',
            transaction_id TEXT,
            undo_of        TEXT,
            created_at     TEXT NOT NULL,
            PRIMARY KEY (map_id, version)
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


# ---------- app_settings：LLM/数据源等界面可维护设置 ----------
def get_settings() -> dict[str, str]:
    """全部应用设置 ``{key: value}``；从未保存过时返回空 dict（首次启动迁移判据）。"""
    conn = _connect()
    rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}


def set_settings(updates: dict[str, str]) -> None:
    """批量 UPSERT 应用设置（界面保存时调用）。空值也写入（语义=清除）。"""
    if not updates:
        return
    conn = _connect()
    now = _now()
    conn.executemany(
        """
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        """,
        [(key, str(value), now) for key, value in updates.items()],
    )
    conn.commit()
    conn.close()


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


def _delete_local_paper_refs(conn: sqlite3.Connection, paper_id: str) -> None:
    """在给定连接上删除一篇本地文献的全部 DB 关联数据（不含磁盘文件）。

    清理 papers 缓存（含全文）、PDF 可打开性标记、笔记、数据块，以及引用该
    论文的上下文库条目。思维导图节点 JSON 内的 paperId 引用不在此清理
    （遵循"不删除/改写用户导图节点"原则，悬空引用由前端按论文缺失容错）。
    """
    conn.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
    conn.execute("DELETE FROM paper_pdf_status WHERE paper_id = ?", (paper_id,))
    conn.execute("DELETE FROM notes WHERE paper_id = ?", (paper_id,))
    conn.execute("DELETE FROM data_blocks WHERE paper_id = ?", (paper_id,))
    conn.execute(
        "DELETE FROM context_items WHERE type = 'paper' AND ref_id = ?",
        (paper_id,),
    )


def delete_local_paper_data(paper_id: str) -> None:
    """删除一篇本地文献（local:<ws>:<path>）在 DB 中的全部关联数据。

    工作区磁盘上的对应 PDF 被删除后调用（权威副本在磁盘，本函数只清 DB）。
    """
    conn = _connect()
    try:
        _delete_local_paper_refs(conn, paper_id)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def delete_workspace(ws_id: str) -> None:
    """删除工作区的全部 DB 数据（磁盘目录由 storage.workspace 层先行删除）。

    单事务级联清理，避免删除工作区后留下孤儿行：
    - workspaces 元数据行；
    - app_state 中 project_id='ws:<id>' 的工作区状态快照；
    - context_items 中 workspace_id='ws:<id>' 的上下文条目；
    - mindmaps/mindmap_revisions 中 scope='ws:<id>' 的工作区导图；
    - id/paper_id 以 'local:<ws_id>:' 开头的本地文献数据（papers 全文缓存、
      paper_pdf_status、notes、data_blocks）及引用它们的上下文条目
      （含跨库引用的防御性清理）。
    思维导图节点 JSON 内指向这些论文的 paperId 不做改写（保留用户节点）。
    """
    scope = f"ws:{ws_id}"
    prefix = f"local:{ws_id}:"
    conn = _connect()
    try:
        conn.execute("DELETE FROM app_state WHERE project_id = ?", (scope,))
        conn.execute("DELETE FROM context_items WHERE workspace_id = ?", (scope,))
        conn.execute(
            "DELETE FROM mindmap_revisions WHERE map_id IN "
            "(SELECT id FROM mindmaps WHERE scope = ?)",
            (scope,),
        )
        conn.execute("DELETE FROM mindmaps WHERE scope = ?", (scope,))
        # 本地文献按前缀精确匹配：用 substr 而非 LIKE——ws_id 允许下划线，
        # 而 '_' 在 LIKE 中是单字符通配，会误删同名前缀的其它工作区数据
        for table, col in (
            ("papers", "id"),
            ("paper_pdf_status", "paper_id"),
            ("notes", "paper_id"),
            ("data_blocks", "paper_id"),
        ):
            conn.execute(
                f"DELETE FROM {table} WHERE substr({col}, 1, ?) = ?",
                (len(prefix), prefix),
            )
        # 防御性清理：引用本工作区本地论文的上下文条目（通常已随 workspace_id
        # 条件删除，此句覆盖跨库/历史数据的悬空引用）
        conn.execute(
            "DELETE FROM context_items WHERE type = 'paper' "
            "AND substr(ref_id, 1, ?) = ?",
            (len(prefix), prefix),
        )
        conn.execute("DELETE FROM workspaces WHERE id = ?", (ws_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------- mindmaps / mindmap_revisions：思维导图 ----------
MINDMAP_REVISION_LIMIT = 20


def _decode_mindmap(row: sqlite3.Row | dict) -> dict:
    """DB 行 → API 用 dict：doc 列 JSON 解析为对象。"""
    item = dict(row)
    raw = item.get("doc")
    if isinstance(raw, str):
        try:
            item["doc"] = json.loads(raw)
        except json.JSONDecodeError:
            item["doc"] = {"nodes": []}
    return item


def create_mindmap(map_id: str, scope: str, title: str, doc: dict) -> dict:
    """创建导图并写入 version=1 的首版快照。返回完整行。"""
    now = _now()
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO mindmaps (id, scope, title, doc, version, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 1, ?, ?)",
            (map_id, scope, title, json.dumps(doc, ensure_ascii=False), now, now),
        )
        conn.execute(
            "INSERT INTO mindmap_revisions "
            "(map_id, version, doc, actions, actor, transaction_id, undo_of, created_at) "
            "VALUES (?, 1, ?, '[]', 'user', NULL, NULL, ?)",
            (map_id, json.dumps(doc, ensure_ascii=False), now),
        )
        conn.commit()
    finally:
        conn.close()
    row = get_mindmap(map_id)
    assert row is not None
    return row


def get_mindmap(map_id: str) -> dict | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM mindmaps WHERE id = ?", (map_id,)).fetchone()
    conn.close()
    return _decode_mindmap(row) if row else None


def list_mindmaps(scope: str = "", include_doc: bool = False) -> list[dict]:
    """列出某作用域导图（''=全局库）。默认不含 doc，保持轻量。"""
    conn = _connect()
    cols = "id, scope, title, version, created_at, updated_at"
    if include_doc:
        cols += ", doc"
    rows = conn.execute(
        f"SELECT {cols} FROM mindmaps WHERE scope = ? ORDER BY updated_at DESC",
        (scope,),
    ).fetchall()
    conn.close()
    items = []
    for r in rows:
        item = dict(r)
        if include_doc:
            item = _decode_mindmap(item)
        items.append(item)
    return items


def rename_mindmap(map_id: str, title: str) -> None:
    conn = _connect()
    conn.execute(
        "UPDATE mindmaps SET title = ?, updated_at = ? WHERE id = ?",
        (title, _now(), map_id),
    )
    conn.commit()
    conn.close()


def delete_mindmap(map_id: str) -> None:
    """删除导图及其全部修订。"""
    conn = _connect()
    conn.execute("DELETE FROM mindmap_revisions WHERE map_id = ?", (map_id,))
    conn.execute("DELETE FROM mindmaps WHERE id = ?", (map_id,))
    conn.commit()
    conn.close()


def commit_mindmap_doc(map_id: str, doc: dict, actions: list, *,
                       actor: str = "user", transaction_id: str | None = None,
                       undo_of: str | None = None) -> int | None:
    """乐观锁提交一次文档写入，原子完成：版本自增 + 修订快照 + 裁剪。

    调用方须先基于读到的当前版本应用 actions（services.mindmap_doc）。
    返回新版本号；导图不存在或版本已被他人推进（条件 UPDATE 0 行）时返回 None。
    """
    now = _now()
    doc_json = json.dumps(doc, ensure_ascii=False)
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT version FROM mindmaps WHERE id = ?", (map_id,)
        ).fetchone()
        if row is None:
            return None
        cur = conn.execute(
            "UPDATE mindmaps SET doc = ?, version = version + 1, updated_at = ? "
            "WHERE id = ? AND version = ?",
            (doc_json, now, map_id, row["version"]),
        )
        if cur.rowcount == 0:
            conn.rollback()
            return None
        new_version = row["version"] + 1
        conn.execute(
            "INSERT INTO mindmap_revisions "
            "(map_id, version, doc, actions, actor, transaction_id, undo_of, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (map_id, new_version, doc_json,
             json.dumps(actions, ensure_ascii=False), actor, transaction_id, undo_of, now),
        )
        conn.execute(
            "DELETE FROM mindmap_revisions WHERE map_id = ? AND version NOT IN "
            "(SELECT version FROM mindmap_revisions WHERE map_id = ? "
            " ORDER BY version DESC LIMIT ?)",
            (map_id, map_id, MINDMAP_REVISION_LIMIT),
        )
        conn.commit()
        return new_version
    finally:
        conn.close()


def list_mindmap_revisions(map_id: str, limit: int = MINDMAP_REVISION_LIMIT) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT map_id, version, actions, actor, transaction_id, undo_of, created_at "
        "FROM mindmap_revisions WHERE map_id = ? ORDER BY version DESC LIMIT ?",
        (map_id, limit),
    ).fetchall()
    conn.close()
    items = []
    for r in rows:
        item = dict(r)
        try:
            item["actions"] = json.loads(item.get("actions") or "[]")
        except json.JSONDecodeError:
            item["actions"] = []
        items.append(item)
    return items


def get_mindmap_revision(map_id: str, version: int) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM mindmap_revisions WHERE map_id = ? AND version = ?",
        (map_id, version),
    ).fetchone()
    conn.close()
    if row is None:
        return None
    item = dict(row)
    item["doc"] = json.loads(item["doc"]) if isinstance(item.get("doc"), str) else None
    try:
        item["actions"] = json.loads(item.get("actions") or "[]")
    except json.JSONDecodeError:
        item["actions"] = []
    return item


def get_latest_ai_transaction(map_id: str) -> dict | None:
    """最近一次 AI 编辑事务（且未被撤销过）。无则 None。

    返回 {transaction_id, version, created_at}（version 为该事务最后一个版本）。
    """
    conn = _connect()
    row = conn.execute(
        """
        SELECT transaction_id, version, created_at FROM mindmap_revisions r
        WHERE map_id = ? AND actor = 'ai' AND transaction_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM mindmap_revisions u
              WHERE u.map_id = r.map_id AND u.undo_of = r.transaction_id
          )
        ORDER BY version DESC LIMIT 1
        """,
        (map_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def is_transaction_undone(map_id: str, transaction_id: str) -> bool:
    conn = _connect()
    row = conn.execute(
        "SELECT 1 FROM mindmap_revisions WHERE map_id = ? AND undo_of = ? LIMIT 1",
        (map_id, transaction_id),
    ).fetchone()
    conn.close()
    return row is not None
