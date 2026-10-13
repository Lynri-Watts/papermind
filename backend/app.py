"""PaperMind 后端入口。

启动方式（在 backend/ 目录下）：
    conda activate papermind
    python app.py
"""
from __future__ import annotations

import logging
import os

from flask import Flask
from flask_cors import CORS

import config
from routes.mindmaps import mindmaps_api
from routes.papers import api
from routes.settings import settings_api
from routes.workspaces import workspaces_api
from storage.db import init_db
from storage.library import migrate_legacy_literature

logger = logging.getLogger(__name__)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def create_app() -> Flask:
    app = Flask(__name__)
    # 允许前端开发服务器跨域访问
    CORS(app, resources={r"/api/*": {"origins": "*"}})
    app.register_blueprint(api, url_prefix="/api")
    app.register_blueprint(workspaces_api, url_prefix="/api")
    app.register_blueprint(settings_api, url_prefix="/api")
    app.register_blueprint(mindmaps_api, url_prefix="/api")

    init_db()
    _run_startup_migration()
    return app


def _run_startup_migration() -> None:
    """一次性迁移：旧版本混放在写作目录中的文献 PDF 搬到独立文献库。

    debug 开启时 Werkzeug reloader 会让本模块在父进程也执行一遍；仅在真正
    服务进程（子进程带 WERKZEUG_RUN_MAIN）或未开 reloader 时执行，避免重复。
    迁移本身幂等，重复执行也安全。
    """
    if config.DEBUG and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return
    try:
        moved = migrate_legacy_literature()
    except Exception:
        logger.exception("本地文献库迁移失败（不影响启动）")
        return
    if moved:
        for ws_id, old_rel, new_rel in moved:
            logger.info("迁移本地文献 %s: %s -> libraries/%s/%s", ws_id, old_rel, ws_id, new_rel)
        logger.info("本地文献库迁移完成，共 %d 个文件", len(moved))


app = create_app()


if __name__ == "__main__":
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
