/**
 * 写作区文件标签页：横向排列、点击切换、未保存圆点、关闭按钮。
 * main.tex 是固定编译入口，始终位于首位且不可关闭。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2, FileText, Image as ImageIcon, FileType, X } from 'lucide-react';
import { MAIN_TEX, baseName, isImageFile } from './utils';

interface EditorTabsProps {
  /** 打开的标签（相对路径，main.tex 应在首位） */
  tabs: string[];
  activePath: string;
  /** 有未保存改动的文件路径集合 */
  dirty: Set<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

function tabIcon(path: string): React.ReactNode {
  if (isImageFile(path)) {
    return <ImageIcon size={13} className="text-violet-400 flex-shrink-0" />;
  }
  if (path.endsWith('.pdf')) {
    return <FileType size={13} className="text-red-400 flex-shrink-0" />;
  }
  if (path.endsWith('.tex') || path.endsWith('.bib')) {
    return <FileCode2 size={13} className="text-emerald-400 flex-shrink-0" />;
  }
  return <FileText size={13} className="text-sky-400 flex-shrink-0" />;
}

const EditorTabs: React.FC<EditorTabsProps> = ({ tabs, activePath, dirty, onSelect, onClose }) => {
  const { t } = useTranslation('writing');
  return (
    <div
      className="flex items-stretch gap-1 overflow-x-auto bg-surface/60 border-b border-border px-2 pt-1.5"
      role="tablist"
    >
      {tabs.map((path) => {
        const isActive = path === activePath;
        const isDirty = dirty.has(path);
        const closable = path !== MAIN_TEX;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={isActive}
            title={path}
            onClick={() => onSelect(path)}
            className={[
              'group flex items-center gap-1.5 max-w-[180px] pl-2.5 pr-1.5 py-1.5 rounded-t-md cursor-pointer',
              'border border-b-0 text-xs transition-colors',
              isActive
                ? 'bg-background border-border text-text'
                : 'bg-white/5 border-transparent text-textSecondary hover:text-text hover:bg-white/10',
            ].join(' ')}
          >
            {tabIcon(path)}
            <span className="truncate">{baseName(path)}</span>
            {isDirty && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                title={t('files.unsaved')}
              />
            )}
            {closable && (
              <button
                type="button"
                aria-label={t('files.close')}
                className={[
                  'ml-0.5 p-0.5 rounded hover:bg-white/10 text-textSecondary hover:text-text',
                  isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                ].join(' ')}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(path);
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default EditorTabs;
