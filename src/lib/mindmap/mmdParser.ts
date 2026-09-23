/**
 * mermaid ``mindmap`` 缩进语法子集解析器（前端一份）。
 *
 * **格式约定与后端 ``backend/services/mindmap_mmd.py`` 逐字节一致；
 * 改此文件必须同步改后端。**
 *
 *   mindmap
 *     ((根文本))                                          <- 根，circle 形状
 *       普通分支文本                                      <- topic 节点
 *         [论文标题](paper:arxiv:2401.00001)             <- paper 节点
 *       %%id:n_aaaaaaaa                                  <- 文本为空的节点
 *
 * - 缩进表层级：首个节点列号=根列，第一次「父→子」列差确定统一步长（通常 2 空格），
 *   之后每层列号必须精确匹配，否则报缩进跳跃；
 * - ``%%`` 到行尾是注释；其中 ``id:n_xxxxxxxx`` 是节点稳定 ID 注解
 *   （真实 mermaid 当普通注释忽略；序列化始终带注解，导出再导入不丢几何）；
 * - 无注解的手写节点按「索引路径」（根到它的同级序号序列）做 sha1[:8] 确定性 ID；
 * - 形状 ((x))/{{x}}/[x]/(x) 归一为 topic（v1 丢弃形状）；允许 root((x)) 式前置名；
 * - 论文节点整行为 [文本](paper:<paperId>)；
 * - ::icon() 类指令行直接跳过。
 *
 * 解析失败抛 MindmapError，params.line 为 1-based 行号。
 */
import type { MindmapDoc, MindmapNodeKind } from '../../types';
import { sha1Hex } from './sha1';
import {
  MindmapError,
  makeNode,
  normalizeOrders,
  validateDoc,
  validatePaperId,
} from './model';

/** 论文链接整行：[文本](paper:<paperId>)；paperId 内不允许空白/右括号。 */
const PAPER_LINK_RE = /^\[([^\]]*)\]\(paper:([^\s)]+)\)\s*$/;
/** 注释中的稳定 ID 注解。 */
const ID_ANNOTATION_RE = /(?:^|\s)id:(n_[0-9a-fA-F]{8})\b/;
/** 支持的形状包裹（长前缀优先）。 */
const SHAPE_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['((', '))'],
  ['{{', '}}'],
  ['[', ']'],
  ['(', ')'],
];
/** root((mindmap)) 式前置节点名（解析后丢弃，仅兼容官方语法）。 */
const PREFIX_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*/;

/** 占位布局（与后端线性初值一致；前端画布可再 tidy-tree）。 */
export const LEVEL_X = 240;
export const ROW_Y = 72;

function lineError(key: string, line: number, params: Record<string, unknown> = {}): MindmapError {
  return new MindmapError(key, { line, ...params });
}

/** 剥离形状包裹与可选前置节点名，返回纯文本。 */
function stripShape(content: string): string {
  const text = content.trim();
  for (const [left, right] of SHAPE_WRAPPERS) {
    if (text.startsWith(left) && text.endsWith(right) && text.length >= left.length + right.length) {
      return text.slice(left.length, text.length - right.length).trim();
    }
  }
  const match = PREFIX_NAME_RE.exec(text);
  if (match) {
    const rest = text.slice(match[0].length).trimStart();
    for (const [left, right] of SHAPE_WRAPPERS) {
      if (rest.startsWith(left) && rest.endsWith(right) && rest.length >= left.length + right.length) {
        return rest.slice(left.length, rest.length - right.length).trim();
      }
    }
  }
  return text;
}

/** 索引路径 → 确定性 ID：sha1(序号以 / 连接) 前 8 位。与 Python _path_id 一致。 */
function pathId(path: number[]): string {
  return `n_${sha1Hex(path.map(String).join('/')).slice(0, 8)}`;
}

/** 解析一行正文，返回 (kind, text, paperId)。 */
function parseContent(
  content: string,
  lineNo: number
): { kind: MindmapNodeKind; text: string; paperId: string | null } {
  const m = PAPER_LINK_RE.exec(content);
  if (m) {
    const text = m[1].trim();
    const paperId = m[2].trim();
    try {
      validatePaperId(paperId);
    } catch {
      throw lineError('mindmap.invalid_paper_id', lineNo, { paper_id: paperId });
    }
    return { kind: 'paper', text, paperId };
  }
  return { kind: 'topic', text: stripShape(content), paperId: null };
}

interface StackItem {
  column: number;
  nodeId: string;
  siblingIndex: number;
}

/** 把 mermaid mindmap 文本解析为 MindmapDoc。 */
export function parseMermaid(text: unknown): MindmapDoc {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new MindmapError('mindmap.mmd_empty');
  }
  const lines = text.split(/\r\n|\r|\n/);

  // 1) 定位 mindmap 头（允许空行/注释先行）
  let headerLine: number | null = null;
  for (let idx = 1; idx <= lines.length; idx++) {
    const stripped = lines[idx - 1].trim();
    if (!stripped || stripped.startsWith('%%')) continue;
    if (stripped.split('%%', 1)[0].trim() === 'mindmap') {
      headerLine = idx;
      break;
    }
    throw lineError('mindmap.mmd_missing_header', idx);
  }
  if (headerLine === null) {
    throw new MindmapError('mindmap.mmd_missing_header', { line: 1 });
  }

  // 栈项：(列号, 节点 ID, 该节点在兄弟中的序号)
  const stack: StackItem[] = [];
  const levelColumns = new Map<number, number>();
  const nodes: MindmapDoc['nodes'] = [];
  let rowCursor = 0;

  for (let lineNo = headerLine + 1; lineNo <= lines.length; lineNo++) {
    const raw = lines[lineNo - 1];
    if (raw.trim() === '') continue;
    const trimmedStart = raw.trimStart();
    const leadingWs = raw.slice(0, raw.length - trimmedStart.length);
    if (leadingWs.includes('\t')) {
      throw lineError('mindmap.mmd_indent_char', lineNo);
    }
    const column = leadingWs.length;
    const bodyRaw = trimmedStart.trim();
    if (bodyRaw.startsWith('::')) continue; // ::icon()/类指令行，v1 忽略

    // 拆注释与 ID 注解
    let body = bodyRaw;
    let annotation: string | null = null;
    const commentIdx = body.indexOf('%%');
    if (commentIdx >= 0) {
      const comment = body.slice(commentIdx + 2);
      body = body.slice(0, commentIdx).trimEnd();
      const m = ID_ANNOTATION_RE.exec(comment);
      if (m) annotation = m[1];
    }
    const content = body.trim();
    if (!content && !annotation) continue; // 普通注释行

    // 2) 由列号确定父节点与深度
    let parentId: string | null;
    let depth: number;
    let siblingIndex: number;
    let path: number[];
    if (stack.length === 0) {
      // 第一个节点 = 根
      levelColumns.set(0, column);
      parentId = null;
      depth = 0;
      siblingIndex = 0;
      path = [];
    } else {
      const rootColumn = levelColumns.get(0) as number;
      if (column === rootColumn) throw lineError('mindmap.mmd_multiple_roots', lineNo);
      if (column < rootColumn) throw lineError('mindmap.mmd_indent_outside_root', lineNo);

      if (column > stack[stack.length - 1].column) {
        // 孩子：新一层
        depth = stack.length;
        let expected: number | null = null;
        if (levelColumns.has(depth)) {
          expected = levelColumns.get(depth) as number;
        } else if (depth >= 2) {
          // 步长已由前两层确定，新层列号必须可推出
          const step = (levelColumns.get(1) as number) - rootColumn;
          expected = (levelColumns.get(depth - 1) as number) + step;
        }
        if (expected !== null && column !== expected) {
          throw lineError('mindmap.mmd_indent_jump', lineNo);
        }
        if (!levelColumns.has(depth)) levelColumns.set(depth, column);
        parentId = stack[stack.length - 1].nodeId;
      } else {
        // 同级或回退到祖先层：弹栈直到列号匹配
        while (stack.length && stack[stack.length - 1].column > column) stack.pop();
        // column > root_column（根列已在上面拦截），匹配后栈深至少为 2，父为栈顶上一层。
        if (stack.length < 2 || stack[stack.length - 1].column !== column) {
          throw lineError('mindmap.mmd_indent_jump', lineNo);
        }
        depth = stack.length;
        parentId = stack[stack.length - 2].nodeId;
      }
      siblingIndex = nodes.filter((n) => n.parentId === parentId).length;
      path = [...stack.map((item) => item.siblingIndex), siblingIndex];
    }

    const parsed = parseContent(content, lineNo);
    const nodeId = annotation ?? pathId(path);
    nodes.push(
      makeNode(nodeId, parentId, siblingIndex, parsed.text, {
        kind: parsed.kind,
        paperId: parsed.paperId,
        x: depth * LEVEL_X,
        y: rowCursor * ROW_Y,
      })
    );
    rowCursor += 1;

    // 3) 入栈：新层压入；同层替换栈顶
    const top = stack[stack.length - 1];
    if (!top) {
      stack.push({ column, nodeId, siblingIndex });
    } else if (column > top.column) {
      stack.push({ column, nodeId, siblingIndex });
    } else {
      while (stack.length && stack[stack.length - 1].column > column) stack.pop();
      if (stack.length && stack[stack.length - 1].column === column) {
        stack[stack.length - 1] = { column, nodeId, siblingIndex };
      } else {
        stack.push({ column, nodeId, siblingIndex });
      }
    }
  }

  if (nodes.length === 0) throw new MindmapError('mindmap.mmd_no_nodes');

  const doc: MindmapDoc = { nodes };
  normalizeOrders(doc);
  validateDoc(doc);
  return doc;
}
