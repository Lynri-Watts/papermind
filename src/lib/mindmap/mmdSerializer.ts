/**
 * MindmapDoc → mermaid mindmap 文本序列化器（前端一份）。
 *
 * 与后端 ``backend/services/mindmap_mmd.py`` 的 doc_to_mermaid 逐字节一致：
 * - 首行 ``mindmap``；两空格缩进；根用 ``((文本))``；
 * - paper 节点输出 ``[文本](paper:<paperId>)``；其余输出纯文本；
 * - 每行带 ``  %%id:<稳定ID>`` 注解（空文本行只有缩进 + 注解）；
 * - 文本中的 CR/LF/%% 替换为空格（避免破坏行结构/注释）；
 * - 末尾恰好一个换行。
 */
import type { MindmapDoc, MindmapNode } from '../../types';
import { MindmapError, orderedChildren, validateDoc } from './model';

function safeText(value: string | undefined | null): string {
  return (value ?? '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/%%/g, ' ');
}

/** 序列化为合法 mermaid mindmap 文本（非法文档先抛 MindmapError）。 */
export function docToMermaid(doc: MindmapDoc): string {
  validateDoc(doc);
  const nodes = doc.nodes;
  const root = nodes.find((n) => n.parentId === null);
  if (!root) throw new MindmapError('mindmap.root_missing');

  const lines: string[] = ['mindmap'];

  const emit = (node: MindmapNode, depth: number): void => {
    const indent = '  '.repeat(depth + 1);
    const annotation = `%%id:${node.id}`;
    const text = safeText(node.text);
    let body: string;
    if (depth === 0) {
      body = `((${text}))`;
    } else if (node.kind === 'paper' && node.paperId) {
      body = `[${text}](paper:${node.paperId})`;
    } else {
      body = text;
    }
    if (body) {
      lines.push(`${indent}${body}  ${annotation}`);
    } else {
      // 空文本：整行只有缩进与 ID 注解
      lines.push(`${indent}${annotation}`);
    }
    for (const child of orderedChildren(nodes, node.id)) {
      emit(child, depth + 1);
    }
  };

  emit(root, 0);
  return `${lines.join('\n')}\n`;
}
