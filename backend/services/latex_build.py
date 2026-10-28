"""LaTeX 编译服务：在工作区目录内以 ``main.tex`` 为入口编译。

- 入口固定为工作区根目录下的 ``main.tex``（与前端写作模块的约定一致）；
- 直接驱动 xelatex（不依赖 latexmk/Perl）：
  1) 第一趟 xelatex；
  2) 检测到参考文献时自动插入 bibtex（经典 ``\\bibliography``）或
     biber（biblatex 的 ``\\addbibresource``）一趟；
  3) 再跑 xelatex，并根据 main.log 中的 "Rerun" 提示最多补到第三趟，
     以收敛目录/交叉引用；
- 编译进程的 cwd 锁定在对应工作区目录（经安全层解析，禁止越界），
  禁用 shell、设置超时，绝不接受用户传入的可执行命令或文件名；
- MiKTeX 缺宏包时默认会弹确认框导致无人值守挂死，探测到 MiKTeX 时
  统一追加 ``--enable-installer``（TeX Live 会拒绝未知选项，故不追加）；
- 每趟 xelatex 带 ``-synctex=1``，成功后保留 ``main.synctex.gz``，
  供阅读器双击 PDF 反向定位源码（synctex_inverse）；
- 成功后清理其余辅助文件（保留 PDF 与 SyncTeX 数据）；失败保留现场并
  回传 main.log 尾部。
"""
from __future__ import annotations

import locale
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

import storage.workspace as ws
from i18n import tr

# 写作入口与产物的固定文件名（默认入口，向后兼容）
MAIN_TEX = "main.tex"
MAIN_PDF = "main.pdf"
MAIN_LOG = "main.log"
JOB_BASENAME = "main"


def _compile_names(entry: str) -> dict:
    """从编译入口路径派生全套产物/作业名。

    xelatex 始终在工作区根目录（root）运行，entry 是相对 root 的 POSIX 路径
    （如 ``chapters/ch1.tex``）。TeX 的辅助文件（.aux/.log/.synctex.gz）与
    最终 PDF 都输出在 root 下，**作业名=入口的文件名（去目录去扩展名）**，
    路径里的目录段被忽略——这是 TeX 标准行为（cwd 决定输出位置）。

    :return: dict ``{entry, jobname, pdf, log, synctex}``
    """
    # 反斜杠统一成正斜杠（Windows 兼容）
    posix = entry.replace("\\", "/")
    # 取纯文件名（去目录）、再去扩展名得到 jobname
    stem = Path(posix).stem or JOB_BASENAME
    return {
        "entry": posix,          # 标准化后的相对路径
        "jobname": stem,         # 如 "ch1"
        "pdf": f"{stem}.pdf",
        "log": f"{stem}.log",
        "synctex": f"{stem}.synctex.gz",
    }

# 单次 xelatex 超时（秒）：首次运行可能触发 MiKTeX 宏包按需安装，给较宽的预算
PASS_TIMEOUT = 180
# 整个编译（多趟 + bib）的总超时保护
TOTAL_TIMEOUT = 360
# 失败时回传给前端的日志尾部字符数（main.log 可能极大）
LOG_TAIL_CHARS = 6000
# xelatex 最多趟数（首趟 + 两次 rerun 收敛）
MAX_PASSES = 3
# synctex 反向定位单次超时（秒）：纯本地解析，理应秒回
SYNCTEX_TIMEOUT = 30

# 成功后清理的辅助文件后缀/名称（PDF 与 main.synctex.gz 保留——后者供
# 双击 PDF 反向定位源码；失败时不清理，便于排查）
AUX_SUFFIXES = (
    ".aux", ".out", ".toc", ".lof", ".lot", ".fls", ".fdb_latexmk",
    ".bbl", ".blg", ".bcf", ".run.xml", ".nav",
    ".snm", ".vrb", ".idx", ".ilg", ".ind", ".xdv",
)
AUX_NAMES = ("texput.log",)

# 新建工作区/首次进入写作页时写入的 main.tex 骨架。
# 保持纯 ASCII + 最常见宏包，确保任何 TeX 发行版开箱即可编译；
# 需要中文的用户可自行改用 ctex 文档类或 \usepackage{ctex}。
MAIN_TEX_TEMPLATE = """\\documentclass[11pt]{article}
\\usepackage{geometry}
\\geometry{a4paper, margin=2.5cm}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{hyperref}

\\title{Paper Title}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}


\\end{document}
"""

# 日志中出现即表示需要再跑一趟（交叉引用/目录未收敛）
_RERUN_PATTERNS = (
    "Rerun to get",
    "Please rerun",
    "Label(s) may have changed",
    "There were undefined references",
    "Citation(s) may have changed",
)


def ensure_main_tex(ws_id: str) -> bool:
    """确保工作区存在写作入口 main.tex；不存在则写入骨架。

    :return: True 表示本次新建了文件
    """
    if ws.exists(ws_id, MAIN_TEX):
        return False
    ws.write_text(ws_id, MAIN_TEX, MAIN_TEX_TEMPLATE)
    return True


# -file-line-error 模式下 TeX 错误的标准定位行： ./sub/intro.tex:12: ...
_FILE_LINE_RE = re.compile(r"^\.?[\\/]?(.+?\.tex)\s*:\s*(\d+)\s*:\s*(.*)$", re.IGNORECASE)
# 传统错误行： ! Undefined control sequence.
_BANG_RE = re.compile(r"^!\s+(.*\S)\s*$")
# 错误随后的源码指示行： l.42 \badcmd
_LLINE_RE = re.compile(r"^l\.(\d+)\b")
# 解析错误条数上限（main.log 可能刷屏）
PARSE_ERROR_LIMIT = 30


def parse_log_errors(log: str, default_file: str = MAIN_TEX) -> list[dict]:
    """解析 xelatex 日志为结构化错误清单（纯函数，供 AI 与前端面板共用）。

    识别两类形态（编译已带 ``-file-line-error``，第一类是主力）：

    1. ``./sub/intro.tex:12: Undefined control sequence.`` →
       ``{file:"sub/intro.tex", line:12, kind:"error", text:"..."}``；
    2. 传统 ``! <消息>`` 行 + 随后 ``l.<n>`` 源码指示行（文件归 default_file，
       实际多为主文件内的命令错误）。

    :param default_file: 孤立 bang（没有 l. 配对的 ``! <消息>``）归属文件，
        通常是当前编译入口。
    路径统一为相对工作区的 POSIX 风格；去重、按出现顺序、上限
    :data:`PARSE_ERROR_LIMIT` 条。警告（LaTeX Warning）不在此列。
    """
    if not log:
        return []
    errors: list[dict] = []
    seen: set[tuple] = set()
    pending_bang: str | None = None

    def _norm_file(raw: str) -> str:
        return raw.replace("\\", "/").lstrip("./").lstrip("/")

    def _add(file: str, line: int | None, text: str) -> None:
        text = text.strip().rstrip(".").strip()
        if not text:
            return
        key = (file, line, text)
        if key not in seen:
            seen.add(key)
            errors.append({"file": file, "line": line, "kind": "error", "text": text})

    for raw_line in log.splitlines():
        line = raw_line.rstrip()
        m = _FILE_LINE_RE.match(line)
        if m:
            _add(_norm_file(m.group(1)), int(m.group(2)), m.group(3))
            pending_bang = None
            continue
        m = _BANG_RE.match(line)
        if m:
            pending_bang = m.group(1)
            continue
        if pending_bang is not None:
            m = _LLINE_RE.match(line.strip())
            if m:
                _add(default_file, int(m.group(1)), pending_bang)
                pending_bang = None
        if len(errors) >= PARSE_ERROR_LIMIT:
            break
    # 孤立的 ! 消息（没有 l. 行配对，如缺宏包）也保留
    if pending_bang is not None and len(errors) < PARSE_ERROR_LIMIT:
        _add(default_file, None, pending_bang)
    return errors[:PARSE_ERROR_LIMIT]


def _read_log_tail(root, names: dict) -> str:
    log_path = root / names["log"]
    if not log_path.is_file():
        return ""
    # 日志按 UTF-8 容错读取（TeX 日志在不同 locale 下可能含非 UTF-8 字节）
    return log_path.read_text(encoding="utf-8", errors="replace")[-LOG_TAIL_CHARS:]


def _is_miktex(exe: str) -> bool:
    return "miktex" in (exe or "").lower()


def _run_exe(cmd: list[str], root, env: dict, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=str(root),
        env=env,
        shell=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        # Windows 下不弹控制台窗口
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _xelatex_pass(xelatex: str, root, env: dict, names: dict) -> tuple[bool, str]:
    """跑一趟 xelatex；返回 (是否成功, 日志文本)。

    以退出码为准（nonstopmode 下未定义引用只产生警告、退出码仍为 0）；
    超时/启动异常视为失败。
    """
    cmd = [
        xelatex,
        "-interaction=nonstopmode",
        "-file-line-error",
        # 生成 <jobname>.synctex.gz：阅读器双击 PDF 时据此反向定位源码行
        "-synctex=1",
        names["entry"],
    ]
    if _is_miktex(xelatex):
        # 缺宏包时自动安装，避免 MiKTeX 弹框导致无人值守挂死
        cmd.insert(1, "--enable-installer")
    try:
        proc = _run_exe(cmd, root, env, PASS_TIMEOUT)
    except subprocess.TimeoutExpired:
        log = _read_log_tail(root, names)
        return False, log or tr("workspace.compile.pass_timeout", seconds=PASS_TIMEOUT)
    except OSError as exc:
        return False, tr("workspace.compile.launch_failed", err=exc)
    return proc.returncode == 0, _read_log_tail(root, names)


def _run_bibliography(xelatex_exe: str, tex_source: str, root, env: dict, names: dict) -> bool:
    """根据文档用法跑一趟 bibtex 或 biber；无参考文献需求则跳过。

    :return: 是否实际执行了文献处理
    """
    miktex = _is_miktex(xelatex_exe)
    tool: list[str] | None = None
    if re.search(r"\\addbibresource(?:\[[^\]]*\])?\{", tex_source):
        biber = shutil.which("biber")
        if biber:
            tool = [biber]
            if miktex:
                tool.insert(1, "--enable-installer")
            tool.append(names["jobname"])
    elif re.search(r"\\bibliography\{", tex_source):
        bibtex = shutil.which("bibtex")
        if bibtex:
            tool = [bibtex]
            if miktex:
                tool.insert(1, "--enable-installer")
            tool.append(names["jobname"])
    if tool is None:
        return False
    try:
        _run_exe(tool, root, env, PASS_TIMEOUT)
    except (subprocess.TimeoutExpired, OSError):
        # 文献处理失败不立即致命：交给后续 xelatex 在日志中体现 undefined 问题
        return True
    return True


def _cleanup_aux(root, names: dict) -> None:
    jobname = names["jobname"]
    for suffix in AUX_SUFFIXES:
        try:
            (root / f"{jobname}{suffix}").unlink(missing_ok=True)
        except OSError:
            pass
    for name in AUX_NAMES:
        try:
            (root / name).unlink(missing_ok=True)
        except OSError:
            pass
    # <jobname>.log 单独处理（读取完日志后由调用方决定是否删除）
    try:
        (root / names["log"]).unlink(missing_ok=True)
    except OSError:
        pass


def compile_workspace(ws_id: str, entry: str = MAIN_TEX) -> dict:
    """编译工作区的指定入口 .tex 文件。

    xelatex 的 cwd 固定在工作区根，entry 是相对路径（POSIX）。
    产物（pdf/log/synctex/aux）统一输出在根目录，作业名=入口的文件名（去目录去扩展名）。
    如果入口文件不存在且是默认 MAIN_TEX，会自动写入骨架。

    :param entry: 相对工作区根的 .tex 入口路径，缺省 ``main.tex``
    :return: ``{ok, message, log, pdf, entry, errors}``
    :raises storage.workspace.WorkspaceError: 工作区不存在/路径非法
    """
    entry = (entry or MAIN_TEX).replace("\\", "/").strip()
    names = _compile_names(entry)
    root = ws.resolve(ws_id)

    if not (root / names["entry"]).is_file():
        if names["entry"] == MAIN_TEX:
            ensure_main_tex(ws_id)
        else:
            return {
                "ok": False,
                "message": tr("workspace.compile.entry_missing", entry=names["entry"]),
                "log": "",
                "errors": [],
                "pdf": None,
                "entry": names["entry"],
            }

    xelatex = shutil.which("xelatex")
    if not xelatex:
        return {
            "ok": False,
            "message": tr("workspace.compile.missing_engine"),
            "log": "",
            "errors": [],
            "pdf": None,
            "entry": names["entry"],
        }

    env = dict(os.environ)
    # MiKTeX 自动安装宏包的环境开关（与 --enable-installer 双保险；TeX Live 忽略）
    env["MIKTEX_AUTO_INSTALL"] = "1"
    # 让 TeX 日志尽量少折行，便于前端展示错误定位
    env["max_print_line"] = "1000"

    tex_source = (root / names["entry"]).read_text(encoding="utf-8", errors="replace")
    tex_mtime = (root / names["entry"]).stat().st_mtime
    deadline = TOTAL_TIMEOUT

    # 1) 第一趟 xelatex
    t0 = time.monotonic()
    ok, log = _xelatex_pass(xelatex, root, env, names)
    if not ok:
        return {
            "ok": False,
            "message": tr("workspace.compile.failed"),
            "log": log,
            "errors": parse_log_errors(log, default_file=names["entry"]),
            "pdf": None,
            "entry": names["entry"],
        }

    # 2) 参考文献（bibtex/biber）
    _run_bibliography(xelatex, tex_source, root, env, names)

    # 3) 后续趟数：直到日志不再要求 rerun，或达到上限/总超时
    for _ in range(MAX_PASSES - 1):
        if time.monotonic() - t0 > deadline - PASS_TIMEOUT:
            break
        ok, log = _xelatex_pass(xelatex, root, env, names)
        if not ok:
            return {
                "ok": False,
                "message": tr("workspace.compile.failed"),
                "log": log,
                "errors": parse_log_errors(log, default_file=names["entry"]),
                "pdf": None,
                "entry": names["entry"],
            }
        if not any(marker in log for marker in _RERUN_PATTERNS):
            break

    pdf_path = root / names["pdf"]
    ok = ok and pdf_path.is_file() and pdf_path.stat().st_mtime >= tex_mtime
    log = _read_log_tail(root, names)

    if not ok:
        return {
            "ok": False,
            "message": tr("workspace.compile.failed"),
            "log": log,
            "errors": parse_log_errors(log, default_file=names["entry"]),
            "pdf": None,
            "entry": names["entry"],
        }

    # 成功：清理 aux/out 等辅助文件（保留 PDF 与 <jobname>.synctex.gz）
    _cleanup_aux(root, names)
    return {
        "ok": True,
        "message": tr("workspace.compile.ok"),
        "log": log,
        "pdf": names["pdf"],
        "entry": names["entry"],
    }


class SynctexError(Exception):
    """SyncTeX 反向定位业务失败（缺工具/缺数据/输出解析失败/路径越界）。"""


def _decode_console(data: bytes) -> str:
    """解码 TeX 系命令行输出。

    synctex/xelatex 在不同 locale 下输出编码不一（中文 Windows 常为
    cp936），先按 UTF-8 严格解码，失败再退回系统 ANSI 代码页，
    保证含中文的源文件绝对路径不被 replace 成乱码而定位失败。
    """
    encodings = ["utf-8", locale.getpreferredencoding(False), "cp936"]
    for enc in encodings:
        if not enc:
            continue
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def synctex_inverse(ws_id: str, page: int, x: float, y: float,
                    entry: str = MAIN_TEX) -> dict:
    """PDF 坐标 → 源码位置（SyncTeX inverse search，Overleaf 同款机制）。

    :param page: PDF 页码（1 基）
    :param x/y: PDF 点坐标（72dpi，页面左上角为原点；与 synctex 约定一致）
    :param entry: 编译入口 .tex 相对路径（决定用哪个 jobname 的 synctex 数据）
    :return: ``{file, line, column}``，file 为相对工作区根的 POSIX 路径，
             line 为 1 基行号，column 为 1 基列号或 None
    :raises SynctexError: 未编译/无 synctex 数据/未安装 synctex/解析失败/路径越界
    :raises storage.workspace.WorkspaceError: 工作区不存在/路径非法
    """
    names = _compile_names(entry or MAIN_TEX)
    root = ws.resolve(ws_id).resolve()
    pdf_path = root / names["pdf"]
    synctex_data = root / names["synctex"]
    if not pdf_path.is_file() or not synctex_data.is_file():
        raise SynctexError(tr("workspace.synctex.no_data"))

    synctex = shutil.which("synctex")
    if not synctex:
        raise SynctexError(tr("workspace.synctex.missing_tool"))

    # 坐标规格：page:x:y:file（整数页码 + 定点浮点；数字已在路由层校验，
    # 这里仅做无注入的 list 传参，绝不经过 shell）
    spec = f"{int(page)}:{float(x):.4f}:{float(y):.4f}:{names['pdf']}"
    try:
        proc = subprocess.run(
            [synctex, "edit", "-o", spec, "-x", "", names["entry"]],
            cwd=str(root),
            shell=False,
            capture_output=True,
            timeout=SYNCTEX_TIMEOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise SynctexError(tr("workspace.synctex.timeout", seconds=SYNCTEX_TIMEOUT)) from exc
    except OSError as exc:
        raise SynctexError(tr("workspace.synctex.launch_failed", err=exc)) from exc

    # rc==0 但未命中任何源锚点时输出里不会有 Input 段；统一按解析失败处理
    output = _decode_console(proc.stdout or b"")
    m_input = re.search(r"^Input:(.+?)\s*$", output, re.MULTILINE)
    m_line = re.search(r"^Line:(\d+)\s*$", output, re.MULTILINE)
    m_col = re.search(r"^Column:(-?\d+)\s*$", output, re.MULTILINE)
    if proc.returncode != 0 or not m_input or not m_line:
        raise SynctexError(tr("workspace.synctex.no_match"))

    # synctex 报告的源文件可能是 \input/\include 的子文件（绝对路径）；
    # 必须落在工作区根之内，映射回相对路径后才允许返回给前端
    raw_path = Path(m_input.group(1).strip())
    source = raw_path if raw_path.is_absolute() else root / raw_path
    source = source.resolve()
    try:
        rel = source.relative_to(root)
    except ValueError as exc:
        raise SynctexError(tr("workspace.synctex.outside")) from exc
    if not source.is_file():
        raise SynctexError(tr("workspace.synctex.source_missing", path=rel.as_posix()))

    column = int(m_col.group(1)) + 1 if m_col and int(m_col.group(1)) >= 0 else None
    return {
        "file": rel.as_posix(),
        "line": int(m_line.group(1)),
        "column": column,
    }
