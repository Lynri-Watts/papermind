/**
 * 二进制文件只读预览（写作标签页中的图片 / PDF）。
 * - 图片：居中展示，提供「复制 \\includegraphics 引用」与下载；
 * - PDF：浏览器原生内嵌查看器（后端 send_file 支持 Range）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, ExternalLink, Check } from 'lucide-react';
import { workspaceFileUrl } from '../../api';
import { isImageFile } from './utils';

interface BinaryViewerProps {
  wsId: string;
  path: string;
  onCopyImageRef: (path: string) => Promise<boolean> | boolean;
}

const BinaryViewer: React.FC<BinaryViewerProps> = ({ wsId, path, onCopyImageRef }) => {
  const { t } = useTranslation('writing');
  const [copied, setCopied] = React.useState(false);
  const url = `${workspaceFileUrl(wsId, path)}?t=${encodeURIComponent(path)}`;
  const image = isImageFile(path);

  const copyRef = async () => {
    const ok = await onCopyImageRef(path);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-surface/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <span className="text-xs text-textSecondary truncate" title={path}>{path}</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {image && (
            <button
              type="button"
              onClick={copyRef}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-textSecondary hover:text-text hover:bg-white/10 transition-colors"
              title={t('files.copyImageRef')}
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              {t('files.insertRef')}
            </button>
          )}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded text-textSecondary hover:text-text hover:bg-white/10 transition-colors"
            title={t('files.openNewTab')}
          >
            <ExternalLink size={12} />
          </a>
          <a
            href={url}
            download={path.split('/').pop()}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded text-textSecondary hover:text-text hover:bg-white/10 transition-colors"
            title={t('files.download')}
          >
            <Download size={12} />
          </a>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4">
        {image ? (
          <img
            src={url}
            alt={path}
            className="max-w-full max-h-full object-contain rounded shadow-lg"
          />
        ) : (
          <iframe
            src={url}
            title={path}
            className="w-full h-full rounded border border-border bg-white"
          />
        )}
      </div>
    </div>
  );
};

export default BinaryViewer;
