import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Bold, Italic, List, Link2, Code, Calculator, Undo, Redo, Save, Play, Sparkles, Check, X, RefreshCw, ChevronRight, ChevronDown, Folder, FileText as FileIcon } from 'lucide-react';
import { usePaperMindStore } from '../store';
import { AISuggestion } from '../types';

interface TocItem {
  id: string;
  level: number;
  title: string;
  line: number;
}

const LatexEditor: React.FC = () => {
  const { t } = useTranslation('writing');
  const { latexContent, setLatexContent, aiSuggestions, acceptSuggestion, rejectSuggestion, generateAISuggestions } = usePaperMindStore();
  const [history, setHistory] = useState<string[]>([latexContent]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [isAiProcessing, setIsAiProcessing] = useState(false);
  const [hoveredSuggestion, setHoveredSuggestion] = useState<AISuggestion | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [expandedTocItems, setExpandedTocItems] = useState<Set<string>>(new Set(['toc-1']));
  
  const editorRef = useRef<HTMLDivElement>(null);
  const isUserInputRef = useRef(false);
  const needsUpdateRef = useRef(false);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const handleInput = () => {
      isUserInputRef.current = true;
      const newContent = editor.innerText || '';
      if (newContent !== latexContent) {
        setLatexContent(newContent);
        
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(newContent);
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
      }
      setTimeout(() => {
        isUserInputRef.current = false;
      }, 0);
    };

    editor.addEventListener('input', handleInput);
    return () => editor.removeEventListener('input', handleInput);
  }, [latexContent, setLatexContent, history, historyIndex]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || isUserInputRef.current) return;
    
    const newHtml = generateHighlightedHtml(latexContent, aiSuggestions);
    const currentHtml = editor.innerHTML;
    
    if (newHtml !== currentHtml) {
      needsUpdateRef.current = true;
      
      requestAnimationFrame(() => {
        if (!needsUpdateRef.current) return;
        
        const selection = window.getSelection();
        let startOffset = 0;
        let endOffset = 0;
        
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const tempRange = document.createRange();
          tempRange.selectNodeContents(editor);
          tempRange.setEnd(range.startContainer, range.startOffset);
          startOffset = tempRange.toString().length;
          tempRange.setEnd(range.endContainer, range.endOffset);
          endOffset = tempRange.toString().length;
        }
        
        editor.innerHTML = newHtml;
        
        if (selection && editor.firstChild) {
          const newRange = document.createRange();
          const textLength = editor.innerText.length;
          newRange.setStart(editor.firstChild, Math.min(startOffset, textLength));
          newRange.setEnd(editor.firstChild, Math.min(endOffset, textLength));
          selection.removeAllRanges();
          selection.addRange(newRange);
        }
        
        needsUpdateRef.current = false;
      });
    }
  }, [latexContent, aiSuggestions]);

  const handleUndo = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setLatexContent(history[newIndex]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setLatexContent(history[newIndex]);
    }
  };

  const insertCommand = (command: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    
    const range = selection.getRangeAt(0);
    const selectedText = range.toString();
    
    let newText = '';
    
    switch (command) {
      case 'bold':
        newText = `\\textbf{${selectedText || 'text'}}`;
        break;
      case 'italic':
        newText = `\\textit{${selectedText || 'text'}}`;
        break;
      case 'list':
        newText = '\\begin{itemize}\\n\\item ' + (selectedText || '') + '\\n\\end{itemize}';
        break;
      case 'link':
        newText = `\\href{url}{${selectedText || 'link text'}}`;
        break;
      case 'code':
        newText = `\\texttt{${selectedText || 'code'}}`;
        break;
      case 'math':
        newText = `$${selectedText || 'x^2 + y^2 = z^2'}$`;
        break;
      case 'section':
        newText = `\\section{${selectedText || 'Section Title'}}`;
        break;
      case 'subsection':
        newText = `\\subsection{${selectedText || 'Subsection Title'}}`;
        break;
      case 'equation':
        newText = '\\begin{equation}\\n' + (selectedText || '') + '\\n\\end{equation}';
        break;
      default:
        return;
    }
    
    range.deleteContents();
    range.insertNode(document.createTextNode(newText));
    
    const newContent = editor.innerText;
    setLatexContent(newContent);
    
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newContent);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const generateAISuggestionsLocal = async () => {
    setIsAiProcessing(true);
    await new Promise(resolve => setTimeout(resolve, 1000));
    generateAISuggestions();
    setIsAiProcessing(false);
  };

  const handleAcceptSuggestion = (suggestion: AISuggestion) => {
    acceptSuggestion(suggestion.id);
    
    const newContent = latexContent.substring(0, suggestion.position.start) + 
                      suggestion.suggestedText + 
                      latexContent.substring(suggestion.position.end);
    
    setLatexContent(newContent);
    
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newContent);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    
    setHoveredSuggestion(null);
    setShowTooltip(false);
  };

  const handleRejectSuggestion = (suggestion: AISuggestion) => {
    rejectSuggestion(suggestion.id);
    setHoveredSuggestion(null);
    setShowTooltip(false);
  };

  const handleAcceptAll = () => {
    let content = latexContent;
    const suggestions = [...aiSuggestions].filter(s => s.status === 'pending').sort((a, b) => b.position.start - a.position.start);
    
    suggestions.forEach(suggestion => {
      content = content.substring(0, suggestion.position.start) + 
                suggestion.suggestedText + 
                content.substring(suggestion.position.end);
      acceptSuggestion(suggestion.id);
    });
    
    setLatexContent(content);
    
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(content);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const pendingSuggestions = aiSuggestions.filter(s => s.status === 'pending');

  const lineNumbers = latexContent.split('\n').map((_, i) => i + 1);

  const getTypeColor = (type: AISuggestion['type']) => {
    switch (type) {
      case 'improvement': return 'background-color: rgba(59, 130, 246, 0.3); border-bottom: 2px solid #3b82f6;';
      case 'correction': return 'background-color: rgba(239, 68, 68, 0.3); border-bottom: 2px solid #ef4444;';
      case 'addition': return 'background-color: rgba(34, 197, 94, 0.3); border-bottom: 2px solid #22c55e;';
      case 'refinement': return 'background-color: rgba(168, 85, 247, 0.3); border-bottom: 2px solid #a855f7;';
      default: return 'background-color: rgba(156, 163, 175, 0.3); border-bottom: 2px solid #9ca3af;';
    }
  };

  const getTypeLabel = (type: AISuggestion['type']) => {
    switch (type) {
      case 'improvement': return t('suggestion.improvement');
      case 'correction': return t('suggestion.correction');
      case 'addition': return t('suggestion.addition');
      case 'refinement': return t('suggestion.refinement');
      default: return t('suggestion.fallback');
    }
  };

  const parseToc = (content: string): TocItem[] => {
    const lines = content.split('\n');
    const items: TocItem[] = [];
    let id = 0;
    
    lines.forEach((line, idx) => {
      const sectionMatch = line.match(/\\section\{([^}]+)\}/);
      if (sectionMatch) {
        items.push({ id: `toc-${++id}`, level: 1, title: sectionMatch[1], line: idx + 1 });
      }
      
      const subsectionMatch = line.match(/\\subsection\{([^}]+)\}/);
      if (subsectionMatch) {
        items.push({ id: `toc-${++id}`, level: 2, title: subsectionMatch[1], line: idx + 1 });
      }
      
      const subsubsectionMatch = line.match(/\\subsubsection\{([^}]+)\}/);
      if (subsubsectionMatch) {
        items.push({ id: `toc-${++id}`, level: 3, title: subsubsectionMatch[1], line: idx + 1 });
      }
    });
    
    return items;
  };

  const tocItems = parseToc(latexContent);

  const toggleTocItem = (id: string) => {
    setExpandedTocItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const scrollToLine = (line: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    
    const lines = latexContent.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1; i++) {
      pos += lines[i].length + 1;
    }
    
    const range = document.createRange();
    range.setStart(editor.firstChild || editor, Math.min(pos, latexContent.length));
    range.setEnd(editor.firstChild || editor, Math.min(pos, latexContent.length));
    
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    
    range.startContainer?.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor) return;

    const pending = aiSuggestions.filter(s => s.status === 'pending');
    if (pending.length === 0) {
      setShowTooltip(false);
      setHoveredSuggestion(null);
      return;
    }

    let charIndex = -1;
    try {
      const position = (document as any).caretPositionFromPoint(e.clientX, e.clientY);
      if (position && position.offsetNode) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.setEnd(position.offsetNode, position.offset);
        charIndex = range.toString().length;
      }
    } catch (err) {
      console.log('caretPositionFromPoint failed:', err);
    }

    if (charIndex === -1) {
      setShowTooltip(false);
      setHoveredSuggestion(null);
      return;
    }

    const hovered = pending.find(s => 
      charIndex >= s.position.start && charIndex <= s.position.end
    );

    if (hovered && hovered !== hoveredSuggestion) {
      setHoveredSuggestion(hovered);
      setTooltipPosition({ x: e.clientX, y: e.clientY });
      setShowTooltip(true);
    } else if (!hovered && hoveredSuggestion) {
      setShowTooltip(false);
      setHoveredSuggestion(null);
    } else if (hovered) {
      setTooltipPosition({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseLeave = () => {
    setShowTooltip(false);
    setHoveredSuggestion(null);
  };

  const escapeHtml = (text: string): string => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  const highlightSyntax = (text: string): string => {
    if (!text) return escapeHtml(text);
    
    let result = escapeHtml(text);
    
    result = result.replace(/(\\begin\{[\w]+\})|(\\end\{[\w]+\})/g, '<span style="color: #fb923c; font-weight: 600;">$&</span>');
    result = result.replace(/\\(section|subsection|subsubsection|chapter|paragraph|subparagraph)\{[^\}]+\}/g, '<span style="color: #60a5fa; font-weight: 600;">$&</span>');
    result = result.replace(/\\(textbf|textit|underline|texttt)\{[^\}]+\}/g, '<span style="color: #22d3ee;">$&</span>');
    result = result.replace(/\\(cite|ref|label|href)\{[^\}]+\}/g, '<span style="color: #facc15;">$&</span>');
    result = result.replace(/\\(usepackage|documentclass|begin|end|newcommand|renewcommand|def)\b/g, '<span style="color: #c084fc; font-weight: 600;">$&</span>');
    result = result.replace(/\$[^$]+\$/g, '<span style="color: #4ade80; font-style: italic;">$&</span>');
    result = result.replace(/%.*/g, '<span style="color: #6b7280; font-style: italic;">$&</span>');
    result = result.replace(/\\[a-zA-Z]+\*/g, '<span style="color: #f87171;">$&</span>');
    result = result.replace(/\\[a-zA-Z]+/g, '<span style="color: #c084fc;">$&</span>');
    
    return result;
  };

  const generateHighlightedHtml = (content: string, suggestions: AISuggestion[]): string => {
    const pending = suggestions.filter(s => s.status === 'pending');
    if (pending.length === 0) {
      return content.split('\n').map(line => 
        `<div class="leading-6">${highlightSyntax(line)}</div>`
      ).join('\n');
    }
    
    const sortedSuggestions = [...pending].sort((a, b) => a.position.start - b.position.start);
    const lines = content.split('\n');
    const lineStarts: number[] = [0];
    let pos = 0;
    
    for (let i = 0; i < lines.length; i++) {
      pos += lines[i].length + 1;
      lineStarts.push(pos);
    }
    
    const parts: { start: number; end: number; text: string; isSuggestion: boolean; style?: string }[] = [];
    let lastEnd = 0;
    
    sortedSuggestions.forEach(suggestion => {
      if (suggestion.position.start > lastEnd) {
        parts.push({
          start: lastEnd,
          end: suggestion.position.start,
          text: content.substring(lastEnd, suggestion.position.start),
          isSuggestion: false
        });
      }
      
      parts.push({
        start: suggestion.position.start,
        end: suggestion.position.end,
        text: content.substring(suggestion.position.start, suggestion.position.end),
        isSuggestion: true,
        style: getTypeColor(suggestion.type)
      });
      
      lastEnd = suggestion.position.end;
    });
    
    if (lastEnd < content.length) {
      parts.push({
        start: lastEnd,
        end: content.length,
        text: content.substring(lastEnd),
        isSuggestion: false
      });
    }
    
    let html = '';
    let currentLine = 0;
    
    parts.forEach(part => {
      const partLines = part.text.split('\n');
      partLines.forEach((partLine, idx) => {
        if (idx > 0) {
          html += '</div>\n<div class="leading-6">';
          currentLine++;
        }
        
        if (part.isSuggestion && part.style) {
          html += `<mark style="${part.style} border-radius: 2px; padding: 0 2px; cursor: pointer;">${highlightSyntax(partLine)}</mark>`;
        } else {
          html += highlightSyntax(partLine);
        }
      });
    });
    
    return `<div class="leading-6">${html}</div>`;
  };

  const initialHtml = generateHighlightedHtml(latexContent, aiSuggestions);

  return (
    <div className="h-full flex flex-col bg-surface rounded-lg overflow-hidden border border-border relative">
      <div className="flex items-center px-4 py-3 bg-background border-b border-border gap-4">
        <div className="flex items-center gap-2 flex-shrink-0">
          <FileText className="w-5 h-5 text-primary" />
          <span className="font-semibold text-text">{t('header.title')}</span>
        </div>
        <div className="flex-1 overflow-x-auto whitespace-nowrap scrollbar-hide">
          <div className="flex items-center gap-0.5 inline-flex">
            <button
              onClick={handleUndo}
              disabled={historyIndex === 0}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title={t('toolbar.undo')}
            >
              <Undo className="w-4 h-4" />
            </button>
            <button
              onClick={handleRedo}
              disabled={historyIndex === history.length - 1}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title={t('toolbar.redo')}
            >
              <Redo className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={() => insertCommand('bold')}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('toolbar.bold')}
            >
              <Bold className="w-4 h-4" />
            </button>
            <button
              onClick={() => insertCommand('italic')}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('toolbar.italic')}
            >
              <Italic className="w-4 h-4" />
            </button>
            <button
              onClick={() => insertCommand('list')}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('toolbar.list')}
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => insertCommand('link')}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('toolbar.link')}
            >
              <Link2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => insertCommand('code')}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('toolbar.code')}
            >
              <Code className="w-4 h-4" />
            </button>
            <button
              onClick={() => insertCommand('math')}
              className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
              title={t('toolbar.math')}
            >
              <Calculator className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={() => insertCommand('section')}
              className="px-2.5 py-1.5 rounded-lg hover:bg-secondary/20 text-textSecondary hover:text-secondary text-xs font-medium transition-colors"
            >
              {t('toolbar.section')}
            </button>
            <button
              onClick={() => insertCommand('subsection')}
              className="px-2.5 py-1.5 rounded-lg hover:bg-secondary/20 text-textSecondary hover:text-secondary text-xs font-medium transition-colors"
            >
              {t('toolbar.subsection')}
            </button>
            <button
              onClick={() => insertCommand('equation')}
              className="px-2.5 py-1.5 rounded-lg hover:bg-secondary/20 text-textSecondary hover:text-secondary text-xs font-medium transition-colors"
            >
              {t('toolbar.equation')}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={generateAISuggestionsLocal}
            disabled={isAiProcessing}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isAiProcessing 
                ? 'bg-accent/20 text-accent cursor-wait' 
                : 'bg-accent/20 hover:bg-accent/30 text-accent'
            }`}
          >
            {isAiProcessing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span>{t('toolbar.aiEdit')}</span>
          </button>
          {pendingSuggestions.length > 0 && (
            <button
              onClick={handleAcceptAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent/80 text-white text-sm font-medium transition-colors"
            >
              <Check className="w-4 h-4" />
              <span>{t('toolbar.acceptAll', { count: pendingSuggestions.length })}</span>
            </button>
          )}
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/80 text-white text-sm font-medium transition-colors"
          >
            <Play className="w-4 h-4" />
            <span>{t('toolbar.compile')}</span>
          </button>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent text-sm font-medium transition-colors"
          >
            <Save className="w-4 h-4" />
            <span>{t('toolbar.save')}</span>
          </button>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="w-56 bg-background/30 border-r border-border flex-shrink-0 overflow-hidden">
          <div className="p-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-text">{t('structure.title')}</span>
            </div>
          </div>
          <div className="p-2 overflow-auto" style={{ height: 'calc(100% - 52px)' }}>
            {tocItems.length === 0 ? (
              <div className="text-xs text-textSecondary text-center py-4">
                {t('structure.empty')}
              </div>
            ) : (
              <div className="space-y-0.5">
                {tocItems.map((item) => {
                  const hasChildren = tocItems.some(t => t.level > item.level && 
                    tocItems.indexOf(t) > tocItems.indexOf(item) &&
                    !tocItems.some(t2 => t2.level === item.level && tocItems.indexOf(t2) > tocItems.indexOf(item) && tocItems.indexOf(t2) < tocItems.indexOf(t))
                  );
                  
                  const isExpanded = expandedTocItems.has(item.id);
                  
                  return (
                    <div key={item.id}>
                      <button
                        onClick={() => {
                          toggleTocItem(item.id);
                          scrollToLine(item.line);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                          item.level === 1 ? 'text-text font-medium hover:bg-primary/10' :
                          item.level === 2 ? 'text-textSecondary hover:bg-primary/10' :
                          'text-textSecondary/70 hover:bg-primary/10'
                        }`}
                        style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                      >
                        {hasChildren ? (
                          isExpanded ? (
                            <ChevronDown className="w-3 h-3 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-3 h-3 flex-shrink-0" />
                          )
                        ) : (
                          <FileIcon className="w-3 h-3 flex-shrink-0" />
                        )}
                        <span className="truncate">{item.title}</span>
                        <span className="text-textSecondary/50 text-[10px] ml-auto">{item.line}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        
        <div className="flex-1 flex overflow-hidden">
          <div className="w-12 bg-background/50 border-r border-border flex-shrink-0 overflow-hidden">
            <div className="py-3 px-2 text-right overflow-auto" style={{ height: '100%' }}>
              {lineNumbers.map((num) => (
                <div key={num} className="text-xs text-textSecondary leading-6 font-mono select-none">
                  {num}
                </div>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <div
              ref={editorRef}
              contentEditable
              dangerouslySetInnerHTML={{ __html: initialHtml }}
              suppressContentEditableWarning
              className="p-4 font-mono text-sm leading-6 whitespace-pre-wrap break-all min-h-full focus:outline-none"
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              spellCheck={false}
            />
          </div>
        </div>
      </div>

      {showTooltip && hoveredSuggestion && (
        <div 
          className="fixed z-50 max-w-md p-4 bg-background border border-border rounded-xl shadow-lg"
          style={{ 
            left: tooltipPosition.x + 10, 
            top: tooltipPosition.y + 10,
            transform: tooltipPosition.x > window.innerWidth - 400 ? 'translateX(-110%)' : 'none'
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${getTypeColor(hoveredSuggestion.type)}`}>
              {getTypeLabel(hoveredSuggestion.type)}
            </span>
            <span className="text-xs text-textSecondary">
              {Math.round(hoveredSuggestion.confidence * 100)}%
            </span>
          </div>
          <h4 className="font-medium text-text text-sm mb-1">{hoveredSuggestion.title}</h4>
          <p className="text-xs text-textSecondary mb-3">{hoveredSuggestion.description}</p>
          
          <div className="space-y-2 mb-3">
            <div className="text-xs">
              <span className="text-textSecondary">{t('suggestion.original')}:</span>
              <p className="text-text mt-1 line-clamp-2 bg-red-500/10 px-2 py-1 rounded">{hoveredSuggestion.originalText}</p>
            </div>
            <div className="text-xs">
              <span className="text-textSecondary">{t('suggestion.suggested')}:</span>
              <p className="text-text mt-1 line-clamp-2 bg-green-500/10 px-2 py-1 rounded">{hoveredSuggestion.suggestedText}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleRejectSuggestion(hoveredSuggestion)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface hover:bg-red-500/20 text-textSecondary hover:text-red-400 text-xs font-medium transition-colors"
            >
              <X className="w-3 h-3" />
              {t('suggestion.reject')}
            </button>
            <button
              onClick={() => handleAcceptSuggestion(hoveredSuggestion)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 hover:text-green-300 text-xs font-medium transition-colors"
            >
              <Check className="w-3 h-3" />
              {t('suggestion.accept')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default LatexEditor;