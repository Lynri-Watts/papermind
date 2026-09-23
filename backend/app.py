"""PaperMind 后端入口。

启动方式（在 backend/ 目录下）：
    conda activate papermind
    python app.py
"""
from __future__ import annotations

import logging

from flask import Flask
from flask_cors import CORS

import config
from routes.mindmaps import mindmaps_api
from routes.papers import api
from routes.settings import settings_api
from routes.workspaces import workspaces_api
from storage.db import init_db

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
    return app


app = create_app()


if __name__ == "__main__":
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
