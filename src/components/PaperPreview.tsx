import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, ZoomIn, ZoomOut, Maximize2, Download } from 'lucide-react';
import { usePaperMindStore } from '../store';
import katex from 'katex';

const PaperPreview: React.FC = () => {
  const { t } = useTranslation('writing');
  const { latexContent } = usePaperMindStore();
  const [zoom, setZoom] = React.useState(1);

  const renderedContent = useMemo(() => {
    let content = latexContent;
    
    content = content.replace(/\\documentclass\{[^}]+\}/g, '');
    content = content.replace(/\\usepackage\{[^}]+\}/g, '');
    content = content.replace(/\\title\{([^}]+)\}/g, '<h1>$1</h1>');
    content = content.replace(/\\author\{([^}]+)\}/g, '<p class="text-textSecondary italic">$1</p>');
    content = content.replace(/\\date\{[^}]+\}/g, '');
    content = content.replace(/\\maketitle/g, '');
    content = content.replace(/\\begin\{abstract\}/g, '<blockquote>');
    content = content.replace(/\\end\{abstract\}/g, '</blockquote>');
    content = content.replace(/\\section\{([^}]+)\}/g, '<h2>$1</h2>');
    content = content.replace(/\\subsection\{([^}]+)\}/g, '<h3>$1</h3>');
    content = content.replace(/\\textbf\{([^}]+)\}/g, '<strong>$1</strong>');
    content = content.replace(/\\textit\{([^}]+)\}/g, '<em>$1</em>');
    content = content.replace(/\\texttt\{([^}]+)\}/g, '<code>$1</code>');
    content = content.replace(/\\href\{[^}]+\}\{([^}]+)\}/g, '<a href="#" class="text-primary hover:underline">$1</a>');
    content = content.replace(/\\begin\{equation\}/g, '<div class="math-block">');
    content = content.replace(/\\end\{equation\}/g, '</div>');
    content = content.replace(/\\begin\{itemize\}/g, '<ul>');
    content = content.replace(/\\end\{itemize\}/g, '</ul>');
    content = content.replace(/\\item/g, '<li>');
    content = content.replace(/\\begin\{document\}/g, '');
    content = content.replace(/\\end\{document\}/g, '');
    content = content.replace(/\\usepackage\{[^}]+\}/g, '');
    
    content = content.replace(/\$([^$]+)\$/g, (_, math) => {
      try {
        return katex.renderToString(math, {
          throwOnError: false,
          displayMode: false,
        });
      } catch {
        return `<span class="text-accent">${math}</span>`;
      }
    });
    
    content = content.replace(/\\\[([^\\]+)\\\]/g, (_, math) => {
      try {
        return `<div class="math-display">${katex.renderToString(math, {
          throwOnError: false,
          displayMode: true,
        })}</div>`;
      } catch {
        return `<div class="text-accent">${math}</div>`;
      }
    });
    
    content = content.replace(/\n/g, '<br/>');
    
    return content;
  }, [latexContent]);

  return (
    <div className="h-full flex flex-col bg-surface rounded-lg overflow-hidden border border-border">
      <div className="flex items-center justify-between px-3 py-2.5 bg-background border-b border-border gap-2">
        <div className="flex items-center gap-2 flex-shrink-0">
          <Eye className="w-4 h-4 text-accent" />
          <span className="font-semibold text-text text-sm">{t('preview.title')}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}
            className="p-1.5 rounded-lg hover:bg-accent/20 text-textSecondary hover:text-accent transition-colors"
            title={t('preview.zoomOut')}
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-textSecondary w-10 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom(Math.min(2, zoom + 0.1))}
            className="p-1.5 rounded-lg hover:bg-accent/20 text-textSecondary hover:text-accent transition-colors"
            title={t('preview.zoomIn')}
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setZoom(1)}
            className="p-1.5 rounded-lg hover:bg-accent/20 text-textSecondary hover:text-accent transition-colors"
            title={t('preview.reset')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          <button
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent hover:bg-accent/80 text-white text-xs font-medium transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>PDF</span>
          </button>
        </div>
      </div>
      <div 
        className="flex-1 overflow-auto p-6"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', minHeight: '100%' }}
      >
        <div 
          className="latex-preview max-w-4xl mx-auto min-h-full"
          dangerouslySetInnerHTML={{ __html: renderedContent }}
        />
      </div>
    </div>
  );
};

export default PaperPreview;
