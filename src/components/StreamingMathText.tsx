/**
 * 流式生成中的 AI 正文（纯文本，无 Markdown 管线）内的公式渲染：
 * - 定界符已闭合的 $...$ / $$...$$（含归一化后的 \(...\) / \[...\]）
 *   立即用 KaTeX 排版；
 * - 尚未闭合或 TeX 暂时非法（模型还在输入）时回退为原始文本，
 *   下一个流式增量到来后自动重新切分、自动升级为公式；
 * - 外层容器保持 whitespace-pre-wrap，普通文本的换行/空格行为不变。
 */
import React, { useMemo } from 'react';
import {
  normalizeMathDelimiters,
  renderKatexHtml,
  splitMathSegments,
} from '../utils/latexMath';

interface StreamingMathTextProps {
  text: string;
}

const StreamingMathText: React.FC<StreamingMathTextProps> = ({ text }) => {
  const segments = useMemo(
    () => splitMathSegments(normalizeMathDelimiters(text)),
    [text],
  );

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <React.Fragment key={i}>{seg.text}</React.Fragment>;
        }
        const html = renderKatexHtml(seg.tex, seg.display);
        if (html === null) {
          // TeX 未完成/非法：保留原始定界符文本，避免流式中闪烁式报错
          return <React.Fragment key={i}>{seg.raw}</React.Fragment>;
        }
        if (seg.display) {
          return (
            <span
              key={i}
              className="block my-1.5 overflow-x-auto overflow-y-hidden text-center"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        }
        return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </>
  );
};

export default React.memo(StreamingMathText);
