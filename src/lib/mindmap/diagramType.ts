/**
 * Mermaid 图类型检测（前端一份，后端 backend/services/mindmap_diagram.py 同规则）。
 *
 * 设计原则：
 * - 画布只区分两类：``mindmap``（可编辑树）与其他一切 mermaid 图（只读源码渲染）。
 *   具体类型名取源码首声明 token 原样存储（``flowchart`` / ``sequenceDiagram`` /
 *   ``C4Context`` / 各类 ``*-beta``），不在前端维护会随 mermaid 版本漂移的语法表；
 * - 跳行规则与 mmdParser 定位图头一致：空行、``%%`` 注释（含 ``%%{init}%%``
 *   directive 行）以及 mermaid 11 的 ``---`` YAML front-matter 块都不是图头；
 * - 语法是否合法交给 mermaid 引擎（parse/render），本模块只做结构识别。
 */

/** 可编辑思维导图类型常量（后端 services.mindmap_diagram.MINDMAP_TYPE 对等） */
export const MINDMAP_TYPE = 'mindmap' as const;

/** 导图的存储/渲染类型：mindmap=树画布；其他值=原始声明 token（只读 mermaid 视图） */
export type DiagramType = typeof MINDMAP_TYPE | (string & {});

export interface DiagramHeader {
  /** mindmap=可编辑思维导图；other=其他 mermaid 图 */
  kind: 'mindmap' | 'other';
  /** 规范类型名：mindmap；其他为首声明 token（如 flowchart/sequenceDiagram） */
  type: string;
  /** 图头所在行（1-based） */
  line: number;
}

/** front-matter 边界行（mermaid 11：源码以 --- 包裹的 YAML 块开头） */
const FRONT_MATTER = '---';

/**
 * 定位首个有效声明行。
 * 与后端 detect_diagram_header 逐分支一致；改动必须双端同步。
 * 阶段：leading（前导空行/front-matter 起始）→ frontMatter（整块跳过至闭合）
 *       → body（跳过空行/%%注释，首个 token 即图类型声明）。
 */
export function detectDiagramHeader(text: unknown): DiagramHeader | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r\n|\r|\n/);

  // 1) 前导空行
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;

  // 2) mermaid 11 YAML front-matter：源码以 --- 行开始时，整块跳到闭合 ---
  if (i < lines.length && lines[i].trim() === FRONT_MATTER) {
    i++;
    while (i < lines.length && lines[i].trim() !== FRONT_MATTER) i++;
    i++; // 跳过闭合行（未闭合则直接到 EOF，返回 null）
  }

  // 3) 正文：跳过空行与 %% 注释行
  for (; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith('%%')) continue;
    const token = stripped.split(/\s+/, 1)[0];
    if (!token) continue;
    return {
      kind: token === 'mindmap' ? 'mindmap' : 'other',
      type: token,
      line: i + 1,
    };
  }
  return null;
}

/** 便捷判定：源码是否为 mermaid mindmap 声明 */
export function isMindmapSource(text: unknown): boolean {
  return detectDiagramHeader(text)?.kind === 'mindmap';
}

/**
 * 经典类型的展示标签 i18n 键后缀（``mindmap.diagram.kind.<key>``）。
 * 仅收录长期稳定的官方类型；未列出的（含各 *-beta）直接显示原始 token，
 * 不为未知版本语法编造名称。别名（graph→flowchart）仅用于标签。
 */
export const DIAGRAM_LABEL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['flowchart', 'flowchart'],
  ['graph', 'flowchart'],
  ['sequenceDiagram', 'sequence'],
  ['classDiagram', 'class'],
  ['stateDiagram-v2', 'state'],
  ['stateDiagram', 'state'],
  ['erDiagram', 'er'],
  ['journey', 'journey'],
  ['gantt', 'gantt'],
  ['pie', 'pie'],
  ['timeline', 'timeline'],
  ['gitGraph', 'gitGraph'],
  ['quadrantChart', 'quadrant'],
  ['requirementDiagram', 'requirement'],
  ['architecture-beta', 'architecture'],
];

const LABEL_MAP: ReadonlyMap<string, string> = new Map(
  DIAGRAM_LABEL_KEYS.map(([token, key]) => [token, key])
);

/** 类型 → 标签 i18n 键后缀；未知类型返回 null（UI 回退显示原始 token） */
export function diagramLabelKey(type: string): string | null {
  return LABEL_MAP.get(type) ?? null;
}

/**
 * 经典类型的最小可渲染骨架（新建对话框「选类型」时生成）。
 * {title} 占位由 UI 替换；只收录 DIAGRAM_LABEL_KEYS 内的稳定类型，
 * 刻意保持语法最小——用户随后在源码面板里扩展。
 */
export const DIAGRAM_STARTERS: Readonly<Record<string, string>> = {
  flowchart: 'flowchart TD\n  A[{title}]',
  sequence: 'sequenceDiagram\n  participant A\n  participant B\n  A->>B: hello',
  class: 'classDiagram\n  class {title}',
  state: 'stateDiagram-v2\n  [*] --> A\n  A --> [*]',
  er: 'erDiagram\n  ENTITY {\n    string id\n  }',
  journey: 'journey\n  title {title}\n  section Start\n    Step 1: 5: Me',
  gantt: 'gantt\n  title {title}\n  dateFormat YYYY-MM-DD\n  section A\n  Task 1 :a, 2025-01-01, 7d',
  pie: 'pie title {title}\n  "A" : 60\n  "B" : 40',
  timeline: 'timeline\n  title {title}\n  section Phase 1\n    Event : 2024',
  gitGraph: 'gitGraph\n  commit\n  commit',
  quadrant: 'quadrantChart\n  title {title}\n  x-axis Low --> High\n  quadrant-1 Q1\n  quadrant-2 Q2\n  quadrant-3 Q3\n  quadrant-4 Q4',
  requirement: 'requirementDiagram\n  requirement req {\n    id: 1\n    text: {title}\n    risk: medium\n  }',
  architecture: 'architecture-beta\n  service api(server)[{title}]\n  group cloud(cloud)[Cloud]\n  service db(database)[DB] in cloud\n  api:R --> L:db',
};

/** 新建对话框类型选项（去重后的 label key → 规范声明 token） */
export const DIAGRAM_TYPE_CHOICES: ReadonlyArray<readonly [string, string]> =
  DIAGRAM_LABEL_KEYS.reduce<Array<[string, string]>>((acc, [token, key]) => {
    if (!acc.some(([, k]) => k === key)) acc.push([key, token]);
    return acc;
  }, []);

/** 生成指定类型的骨架源码（未知类型返回 null） */
export function diagramStarter(key: string, title: string): string | null {
  const tpl = DIAGRAM_STARTERS[key];
  if (!tpl) return null;
  return tpl.replace(/\{title\}/g, title || 'Untitled');
}
