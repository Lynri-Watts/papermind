"""应用配置：目录与进程级常量。

注意：**LLM 与数据源的凭据**不在此处固化，而是由 :mod:`settings_store`
在请求时读取 ``.env``（支持界面在线修改后立即生效）。本模块只负责
路径、服务监听与超时等启动期常量。
"""
import os
from pathlib import Path

from dotenv import load_dotenv

# 加载 backend/.env（若存在）；key 由用户手动填写，绝不提交到仓库
_env_path = Path(__file__).resolve().parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "papermind.db"
PDF_DIR = DATA_DIR / "pdfs"          # PDF 二进制磁盘缓存
PDF_DIR.mkdir(exist_ok=True)
# 工作区根目录：所有工作区文件夹位于此根之下。为在线部署做准备，
# 工作区文件统一存储在服务器端受控目录，并由 storage.workspace 层做严格路径校验。
WORKSPACES_ROOT = DATA_DIR / "workspaces"
WORKSPACES_ROOT.mkdir(exist_ok=True)

# --- 服务 ---
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "5001"))
DEBUG = os.getenv("DEBUG", "1") == "1"

# 对外请求超时
HTTP_TIMEOUT = 15
