/**
 * mermaid 同源布局：用项目自身依赖的同一个 mermaid 引擎离屏渲染官方 mindmap SVG，
 * 提取每个节点的真实中心坐标/尺寸/填充色与每条边的 path/配色/线宽，换算成
 * React Flow 坐标系。画布「初始排布 / 重新布局」因此与代码面板里的 mermaid 预览
 * 出自同一引擎、同一初始化（见 mermaidLoader，theme:'dark'）。
 *
 * 经验事实（mermaid@11.17 mindmap classic look，2025-07 实测，探针已验证）：
 * - SVG ``viewBox="minX minY W H"``；``g.nodes`` / ``g.edgePaths`` 均无 transform，
 *   节点 ``translate(cx,cy)`` 中心坐标与边 path d 同处一个用户坐标系（仅差统一偏移）；
 * - 节点：``g.nodes > g.node``，id=``<renderId>-node_<seq>``，class 含
 *   ``section-root`` 或 ``section-N``；seq 为先序 DFS（与本文档可见节点先序一一对应）；
 * - 形状元素：circle=``circle.basic``、rect=``rect.basic``（无 rx）、
 *   rounded=``rect.basic`` 且 rx=5、hexagon=``polygon.label-container``、
 *   default=``path.node-bkg``（带圆角的底色块）；
 * - 边：``g.edgePaths > path``，``data-id="edge_<srcSeq>_<dstSeq>"``，
 *   class 含 ``section-edge-N edge-depth-D``；d 全部为绝对坐标 M/L/C，无箭头；
 * - 节点标签 16px/24px；root 填充灰、深色文字，section 填充暗化色、#d3d3d3 文字；
 * - 同输入多次渲染坐标完全一致（cose-bilkent proof 质量确定性）；
 * - ``[文本](url)`` Markdown 链接在 mindmap 中是语法错误 → paper 节点渲染用纯 [文本]；
 * - 空文本的无包裹行被 mermaid 丢弃 → 空节点用 ``[ ]`` 最小矩形占位。
 */
import type { MindmapDoc, MindmapNode } from '../../types';
import { findRoot, orderedChildren, descendantIds } from './model';
import { loadMermaid } from './mermaidLoader';

/** 实测自 mermaid@11.17 dark 主题的 11 个 section 节点底色（index = 一级分支序 % 11）。 */
export const SECTION_FILLS: readonly string[] = [
  '#0B0000', '#4D1037', '#3F5258', '#4F2F1B', '#6E0A0A',
  '#3B0048', '#995A01', '#154706', '#161722', '#00296F', '#01629C',
];
/** root 圆底 / root 文字 / section 节点文字（实测）。 */
export const ROOT_FILL = '#797D7D';
export const ROOT_TEXT = '#2C2C2C';
export const SECTION_TEXT = '#D3D3D3';
/**
 * 边宽随树层级（实测：level1=11, level2=5, level>=3=3）。
 * 仅用于 mermaid path 缺失时（用户拖拽/增补后）的降级贝塞尔边。
 */
export function edgeWidthForLevel(level: number): number {
  if (level <= 1) return 11;
  if (level === 2) return 5;
  return 3;
}
/** mermaid 分配 section：一级分支按同级序 % 11，后代继承；root 为 null。 */
export const SECTION_MOD = 11;

export interface MermaidNodeGeom {
  id: string;
  /** mermaid 节点序号（先序） */
  seq: number;
  /** root 为 null，其余 0..10 */
  section: number | null;
  /** 归一化后的 RF 左上角 */
  x: number;
  y: number;
  /** 归一化后的中心 */
  cx: number;
  cy: number;
  /** mermaid 实测形状包围盒尺寸 */
  width: number;
  height: number;
  /** 实测填充与文字色 */
  fill: string;
  textColor: string;
}

export interface MermaidEdgeGeom {
  source: string;
  target: string;
  section: number | null;
  /** 边的目标节点树层级（1=根到一级分支…），用于线宽 */
  level: number;
  /** 已换算到 RF 坐标系的 SVG path d（绝对坐标） */
  d: string;
  stroke: string;
  strokeWidth: number;
}

export interface MermaidLayoutResult {
  nodes: Map<string, MermaidNodeGeom>;
  edges: MermaidEdgeGeom[];
  /** 归一化后内容总尺寸（含留白） */
  width: number;
  height: number;
}

/** 可见节点先序（折叠节点当叶子，后代排除）。 */
export function visiblePreorder(
  doc: MindmapDoc,
  honorCollapsed = true
): { node: MindmapNode; depth: number }[] {
  const root = findRoot(doc.nodes);
  if (!root) throw new Error('mindmap.root_missing');
  const hidden = new Set<string>();
  if (honorCollapsed) {
    for (const n of doc.nodes) {
      if (n.collapsed === true) {
        for (const id of descendantIds(doc.nodes, n.id)) {
          if (id !== n.id) hidden.add(id);
        }
      }
    }
  }
  const out: { node: MindmapNode; depth: number }[] = [];
  const walk = (node: MindmapNode, depth: number): void => {
    out.push({ node, depth });
    for (const child of orderedChildren(doc.nodes, node.id)) {
      if (!hidden.has(child.id)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** 结构推导 section（不依赖 mermaid；供新增/拖拽后的降级着色）。返回 id → section。 */
export function sectionOfNodes(doc: MindmapDoc): Map<string, number | null> {
  const root = findRoot(doc.nodes);
  const map = new Map<string, number | null>();
  if (!root) return map;
  map.set(root.id, null);
  orderedChildren(doc.nodes, null).forEach((branch, i) => {
    const section = i % SECTION_MOD;
    const walk = (node: MindmapNode): void => {
      map.set(node.id, section);
      for (const child of orderedChildren(doc.nodes, node.id)) walk(child);
    };
    walk(branch);
  });
  return map;
}

/** section 填充色（root 用 ROOT_FILL）。 */
export function fillForSection(section: number | null): string {
  return section === null ? ROOT_FILL : SECTION_FILLS[((section % SECTION_MOD) + SECTION_MOD) % SECTION_MOD];
}

/** 渲染用标签净化：换行/注释符/形状括号都会破坏 mermaid 形状解析（仅影响测宽文本）。 */
function sanitizeLabel(text: string): string {
  return text
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/%%/g, ' ')
    .replace(/[[\](){}]/g, ' ')
    .trim();
}

const SHAPE_OPEN: Record<string, string> = {
  circle: '((',
  rect: '[',
  rounded: '(',
  hexagon: '{{',
};
const SHAPE_CLOSE: Record<string, string> = {
  circle: '))',
  rect: ']',
  rounded: ')',
  hexagon: '}}',
};

/** 构造「渲染专用」mermaid 文本（无 ID 注解；paper 去伪链接；空节点最小占位）。 */
function buildRenderText(doc: MindmapDoc, honorCollapsed: boolean): string {
  const lines = ['mindmap'];
  for (const { node, depth } of visiblePreorder(doc, honorCollapsed)) {
    const indent = '  '.repeat(depth + 1);
    const label = sanitizeLabel(node.text ?? '');
    let body: string;
    if (depth === 0) {
      body = `((${label || ' '}))`;
    } else if (!label) {
      // 空文本无包裹行被 mermaid 丢弃：统一用最小矩形占位（空圆 r=10 亦可，矩形更接近卡片）
      body = '[ ]';
    } else if (node.kind === 'paper') {
      // paper 伪链接是 mindmap 语法错误，按矩形纯文本渲染（形状语义不变）
      body = `[${label}]`;
    } else {
      const shape = node.shape ?? 'default';
      if (shape === 'default') {
        body = label;
      } else {
        body = `${SHAPE_OPEN[shape]}${label}${SHAPE_CLOSE[shape]}`;
      }
    }
    lines.push(`${indent}${body}`);
  }
  return `${lines.join('\n')}\n`;
}

let renderSeq = 0;

function createOffscreenHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:-100000px;top:0;width:200px;height:200px;overflow:hidden;visibility:hidden;pointer-events:none;';
  document.body.appendChild(host);
  return host;
}

const TRANSLATE_RE = /translate\(\s*([-\d.eE+]+)[ ,]+([-\d.eE+]+)\s*\)/;
const NODE_SEQ_RE = /node_(\d+)$/;
const SECTION_RE = /(?:section-root|section-(\d+))/;
const EDGE_ID_RE = /edge_(\d+)_(\d+)/;
const EDGE_SECTION_RE = /section-edge-(\d+)/;
const EDGE_DEPTH_RE = /edge-depth-(\d+)/;

interface RawNode {
  seq: number;
  section: number | null;
  cx: number;
  cy: number;
  width: number;
  height: number;
  fill: string;
  textColor: string;
}

/**
 * 平移绝对坐标 path：把每个坐标对减 (dx,dy)。
 * 仅支持 mermaid mindmap 实际产出的绝对命令（M/L/C/H/V/Z 等大写）；
 * 遇相对命令（小写）抛错，由调用方降级到 tidy-tree（不静默猜测）。
 */
export function shiftPath(d: string, dx: number, dy: number): string {
  const clamp = (n: number): number => {
    const v = Math.round(n * 1000) / 1000;
    return Object.is(-0, v) ? 0 : v;
  };
  // 每个命令消费的数字坐标形态：成对/单x/单y/弧线(末对才是坐标)
  let cmd: string | null = null;
  let idx = 0;
  return d.replace(/([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)/g, (m, letter: string | undefined) => {
    if (letter !== undefined) {
      cmd = letter;
      idx = 0;
      return letter;
    }
    const num = Number(m);
    if (cmd === null) return m;
    if (cmd >= 'a' && cmd <= 'z') {
      // 相对坐标：mermaid mindmap 不产出；平移语义不安全，直接拒绝
      throw new Error(`mermaidLayout.relative_path_command:${cmd}`);
    }
    let shifted = num;
    switch (cmd) {
      case 'M': case 'L': case 'T': {
        if (idx % 2 === 0) shifted = num - dx;
        else shifted = num - dy;
        break;
      }
      case 'H':
        shifted = num - dx;
        break;
      case 'V':
        shifted = num - dy;
        break;
      case 'C': case 'S': case 'Q':
        if (idx % 2 === 0) shifted = num - dx;
        else shifted = num - dy;
        break;
      case 'A': {
        // rx,ry,xRot,large,sweep,x,y —— 仅末两位平移
        if (idx === 5) shifted = num - dx;
        else if (idx === 6) shifted = num - dy;
        break;
      }
      default:
        return m;
    }
    idx += 1;
    return String(clamp(shifted));
  });
}

/**
 * 用 mermaid 离屏渲染计算整棵可见树的几何。任何 mermaid 错误（语法/环境/结构不匹配）
 * 原样抛出，调用方负责降级到自研 tidy-tree 并给出非阻断提示。
 */
export async function layoutByMermaid(
  doc: MindmapDoc,
  opts: { honorCollapsed?: boolean } = {}
): Promise<MermaidLayoutResult> {
  const honorCollapsed = opts.honorCollapsed ?? true;
  const visible = visiblePreorder(doc, honorCollapsed);
  const renderText = buildRenderText(doc, honorCollapsed);

  const mermaid = await loadMermaid();
  const renderId = `papermind-mm-${++renderSeq}-${Date.now()}`;
  const host = createOffscreenHost();
  let rawNodes: RawNode[];
  let rawEdges: Array<{ src: number; dst: number; d: string; stroke: string; strokeWidth: number; section: number | null; depth: number }>;
  try {
    const { svg } = await mermaid.render(renderId, renderText);
    host.innerHTML = svg;
    const svgEl = host.querySelector('svg');
    if (!svgEl) throw new Error('mermaidLayout.no_svg');

    const nodeEls = Array.from(svgEl.querySelectorAll('.nodes > g.node'));
    if (nodeEls.length !== visible.length) {
      throw new Error(
        `mermaidLayout.node_count_mismatch:rendered=${nodeEls.length},expected=${visible.length}`
      );
    }
    rawNodes = nodeEls.map((g) => {
      const idAttr = g.getAttribute('id') ?? '';
      const seqM = NODE_SEQ_RE.exec(idAttr);
      const trM = TRANSLATE_RE.exec(g.getAttribute('transform') ?? '');
      const cls = g.getAttribute('class') ?? '';
      const shape = g.querySelector('circle,path.node-bkg,polygon,rect.basic');
      const label = g.querySelector('.nodeLabel');
      if (!seqM || !trM || !shape) {
        throw new Error(`mermaidLayout.node_parse_failed:${idAttr}`);
      }
      const bbox = (shape as SVGGraphicsElement).getBBox();
      const sectionM = SECTION_RE.exec(cls);
      return {
        seq: Number(seqM[1]),
        section: cls.includes('section-root') || !sectionM ? null : Number(sectionM[1]),
        cx: Number(trM[1]),
        cy: Number(trM[2]),
        width: bbox.width,
        height: bbox.height,
        fill: getComputedStyle(shape).fill,
        textColor: label ? getComputedStyle(label).color : SECTION_TEXT,
      };
    });
    // seq 必须恰好覆盖 0..n-1（先序对齐的硬前提）
    const seqs = new Set(rawNodes.map((n) => n.seq));
    if (rawNodes.some((n) => n.seq < 0 || n.seq >= visible.length) || seqs.size !== visible.length) {
      throw new Error('mermaidLayout.seq_mismatch');
    }

    rawEdges = Array.from(svgEl.querySelectorAll('.edgePaths > path')).map((p) => {
      const idM = EDGE_ID_RE.exec(p.getAttribute('data-id') ?? p.getAttribute('id') ?? '');
      const cls = p.getAttribute('class') ?? '';
      const secM = EDGE_SECTION_RE.exec(cls);
      const depthM = EDGE_DEPTH_RE.exec(cls);
      const d = p.getAttribute('d');
      if (!idM || !d) throw new Error('mermaidLayout.edge_parse_failed');
      const stroke = getComputedStyle(p).stroke;
      const strokeWidth = parseFloat(getComputedStyle(p).strokeWidth) || edgeWidthForLevel(Number(depthM?.[1] ?? 1));
      return {
        src: Number(idM[1]),
        dst: Number(idM[2]),
        d,
        stroke,
        strokeWidth,
        section: secM ? Number(secM[1]) : null,
        depth: depthM ? Number(depthM[1]) : 1,
      };
    });
  } finally {
    host.remove();
  }

  // seq → 我方节点（先序索引即 seq）
  const bySeq = new Map<number, RawNode>();
  rawNodes.forEach((n) => bySeq.set(n.seq, n));

  // 归一化原点：以全部节点包围盒左上为基准留 PAD 像素；边与节点共用同一用户坐标。
  const PAD = 40;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of rawNodes) {
    minX = Math.min(minX, n.cx - n.width / 2);
    minY = Math.min(minY, n.cy - n.height / 2);
    maxX = Math.max(maxX, n.cx + n.width / 2);
    maxY = Math.max(maxY, n.cy + n.height / 2);
  }
  const ox = minX - PAD;
  const oy = minY - PAD;

  const nodes = new Map<string, MermaidNodeGeom>();
  visible.forEach(({ node }, i) => {
    const n = bySeq.get(i);
    if (!n) throw new Error(`mermaidLayout.seq_missing:${i}`);
    nodes.set(node.id, {
      id: node.id,
      seq: i,
      section: n.section,
      x: n.cx - n.width / 2 - ox,
      y: n.cy - n.height / 2 - oy,
      cx: n.cx - ox,
      cy: n.cy - oy,
      width: n.width,
      height: n.height,
      fill: n.fill,
      textColor: n.textColor,
    });
  });

  const depthById = new Map<string, number>();
  visible.forEach(({ node, depth }) => depthById.set(node.id, depth));
  const edges: MermaidEdgeGeom[] = rawEdges.map((e) => {
    const srcNode = visible[e.src]?.node;
    const dstNode = visible[e.dst]?.node;
    if (!srcNode || !dstNode) throw new Error(`mermaidLayout.edge_endpoint_missing:${e.src}_${e.dst}`);
    return {
      source: srcNode.id,
      target: dstNode.id,
      section: e.section,
      level: Math.max(1, depthById.get(dstNode.id) ?? e.depth),
      d: shiftPath(e.d, ox, oy),
      stroke: e.stroke,
      strokeWidth: e.strokeWidth,
    };
  });

  return {
    nodes,
    edges,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  };
}
