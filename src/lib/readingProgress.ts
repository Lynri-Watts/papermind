/**
 * 论文阅读进度的本地持久化。
 *
 * 进度按论文 id 分别记忆，与工作区无关（同一篇论文在任何工作区打开都回到同一位置）。
 * 存储于浏览器 localStorage，关闭/重开应用、刷新页面后仍然有效；不依赖后端。
 *
 * 位置表示与 PdfViewer 的滚动锚点一致：视口顶部所在页 + 页内纵向比例（同文档
 * 不同缩放可精确映射），并附全局滚动比例兜底（旋转或几何不可对应时使用）。
 */

export interface ReadingAnchor {
  /** 视口顶部所在页（1 基） */
  page: number;
  /** 视口顶部在该页 wrapper 内的纵向比例 [0,1] */
  ratioInPage: number;
  /** 全局滚动比例 [0,1]（兜底） */
  globalRatio: number;
  /** 捕获时的旋转角（0/90/180/270），与当前不一致时只能用全局比例 */
  rotation: number;
}

interface StoredEntry extends ReadingAnchor {
  /** 最近一次更新时间（LRU 淘汰用） */
  updatedAt: number;
}

const STORAGE_KEY = 'papermind:reading-progress:v1';
/** 最多记忆的论文条数，超出后淘汰最久未读的 */
const MAX_ENTRIES = 300;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 读取并校验全部记录；存储损坏/不可用时返回空表，绝不抛出 */
function readAll(): Record<string, StoredEntry> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, StoredEntry> = {};
    for (const [id, e] of Object.entries(parsed as Record<string, unknown>)) {
      if (!e || typeof e !== 'object') continue;
      const entry = e as Record<string, unknown>;
      if (
        isFiniteNumber(entry.page) && entry.page >= 1
        && isFiniteNumber(entry.ratioInPage)
        && isFiniteNumber(entry.globalRatio)
        && isFiniteNumber(entry.rotation)
        && isFiniteNumber(entry.updatedAt)
      ) {
        out[id] = {
          page: Math.floor(entry.page),
          ratioInPage: Math.min(1, Math.max(0, entry.ratioInPage)),
          globalRatio: Math.min(1, Math.max(0, entry.globalRatio)),
          rotation: entry.rotation,
          updatedAt: entry.updatedAt,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(record: Record<string, StoredEntry>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // 隐私模式/配额不足等：静默放弃，阅读进度不影响核心功能
  }
}

/** 读取某篇论文的阅读进度；无记录或已损坏时返回 null */
export function loadReadingProgress(paperId: string): ReadingAnchor | null {
  if (!paperId) return null;
  const entry = readAll()[paperId];
  if (!entry) return null;
  return {
    page: entry.page,
    ratioInPage: entry.ratioInPage,
    globalRatio: entry.globalRatio,
    rotation: entry.rotation,
  };
}

/** 保存某篇论文的阅读进度（按 updatedAt LRU 淘汰超量旧记录） */
export function saveReadingProgress(paperId: string, anchor: ReadingAnchor): void {
  if (!paperId) return;
  if (
    !isFiniteNumber(anchor.page) || anchor.page < 1
    || !isFiniteNumber(anchor.ratioInPage)
    || !isFiniteNumber(anchor.globalRatio)
    || !isFiniteNumber(anchor.rotation)
  ) {
    return;
  }
  const record = readAll();
  record[paperId] = {
    page: Math.floor(anchor.page),
    ratioInPage: Math.min(1, Math.max(0, anchor.ratioInPage)),
    globalRatio: Math.min(1, Math.max(0, anchor.globalRatio)),
    rotation: anchor.rotation,
    updatedAt: Date.now(),
  };

  const ids = Object.keys(record);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => record[a].updatedAt - record[b].updatedAt)
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => { delete record[id]; });
  }
  writeAll(record);
}
