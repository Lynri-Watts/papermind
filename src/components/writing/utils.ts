/**
 * 写作模块（多文件 LaTeX 工作区）公共工具：
 * 文件类型判定、文件名/路径校验、编辑器语言选择等。
 * 供 FileTree / EditorTabs / CodeEditor / WritingWorkspace 复用，
 * 与后端 routes/workspaces.py 的扩展名白名单保持一致。
 */
import type { WorkspaceFile } from '../../types';

/** 固定编译入口（与 store.MAIN_TEX_PATH、后端 latex_build.MAIN_TEX 一致） */
export const MAIN_TEX = 'main.tex';
/** 编译产物：不允许在文件树中打开/删除（由编译器生成与清理） */
export const COMPILE_ARTIFACTS = new Set(['main.pdf', 'main.log']);

/** 可在线编辑/新建的文本扩展名（后端 _EDITABLE_TEXT_EXTS） */
export const EDITABLE_EXTS = new Set(['.tex', '.bib', '.txt', '.md']);
/** 新建文件时可选的扩展名（与上传白名单中的文本类型一致） */
export const CREATABLE_EXTS = ['.tex', '.bib', '.md', '.txt'] as const;
/** 允许上传/在线预览的图片扩展名（xelatex 原生支持 png/jpeg） */
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
/** 上传 accept 属性（写作目录不含 PDF；文献 PDF 走阅读页的文献库上传） */
export const UPLOAD_ACCEPT = '.tex,.bib,.txt,.md,.png,.jpg,.jpeg,.gif,.svg';

/** POSIX 风格相对路径取文件名 */
export function baseName(path: string): string {
  const idx = path.replace(/\\/g, '/').lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** 取目录部分（无目录返回 ''） */
export function dirName(path: string): string {
  const idx = path.replace(/\\/g, '/').lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

export function extOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function isTextFile(path: string): boolean {
  return EDITABLE_EXTS.has(extOf(path));
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extOf(path));
}

/** 可在标签页中查看的二进制（仅图片；PDF 属于独立文献库，不进入写作标签） */
export function isViewableBinary(path: string): boolean {
  return isImageFile(path);
}

/** 文件树应隐藏的编译中间产物/产物 */
export function isHiddenArtifact(path: string): boolean {
  return COMPILE_ARTIFACTS.has(path)
    || ['.aux', '.out', '.toc', '.fls', '.fdb_latexmk', '.synctex.gz', '.bbl', '.blg']
      .some((suf) => path.endsWith(suf));
}

/**
 * 校验新建文件的相对路径：
 * - 非空、长度受限、仅允许 POSIX 分隔符
 * - 禁止绝对路径、盘符、`.`/`..` 段
 * - 必须带可编辑扩展名
 * 返回错误文案键（i18n: writing.files.*），null 表示合法
 */
export function validateRelPath(path: string): string | null {
  const p = path.trim().replace(/\\/g, '/');
  if (!p) return 'files.errEmpty';
  if (p.length > 255 || p.startsWith('/') || p.includes(':')) return 'files.errInvalid';
  const parts = p.split('/');
  if (parts.some((seg) => !seg || seg === '.' || seg === '..')) return 'files.errInvalid';
  if (!EDITABLE_EXTS.has(extOf(p))) return 'files.errExt';
  return null;
}

/** 按目录对文件排序：目录在前、同级按名称，返回可供文件树渲染的列表（扁平、已排序） */
export function sortFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return [...files].sort((a, b) => {
    const da = dirName(a.path);
    const db = dirName(b.path);
    if (da !== db) return da < db ? -1 : 1;
    return baseName(a.path) < baseName(b.path) ? -1 : 1;
  });
}

/** CodeMirror 语言模式选择 */
export type EditorMode = 'latex' | 'markdown' | 'plain';

export function modeForPath(path: string): EditorMode {
  const ext = extOf(path);
  if (ext === '.tex' || ext === '.bib') return 'latex';
  if (ext === '.md') return 'markdown';
  return 'plain';
}

/** \includegraphics 引用路径：子目录图片原样保留 POSIX 相对路径 */
export function graphicxRef(path: string): string {
  return path.replace(/\\/g, '/');
}
