/**
 * 后端离线全局横幅：确认后端不可达（offline）或手动重试探测中（retrying）时
 * 显示在主区域顶部。心跳/业务请求确认恢复后自动消失，不阻挡页面操作。
 * 应用启动的首次探测（checking）不显示，避免后端正常时横幅闪烁。
 */
import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff, RefreshCw, Loader2 } from 'lucide-react';
import {
  getBackendStatus, retryConnection, subscribeBackendStatus,
} from '../lib/backendStatus';

const BackendStatusBanner: React.FC = () => {
  const { t } = useTranslation('app');
  const status = useSyncExternalStore(subscribeBackendStatus, getBackendStatus);

  if (status === 'online' || status === 'checking') return null;
  const retrying = status === 'retrying';

  return (
    <div
      role="alert"
      className="flex-shrink-0 flex items-center gap-2 px-3 h-9 bg-red-500/10 border-b border-red-500/30 text-red-400 text-xs"
    >
      {retrying
        ? <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
        : <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />}
      <span className="flex-1 min-w-0 truncate">
        {retrying ? t('backend.retrying') : t('backend.offline')}
      </span>
      <button
        type="button"
        onClick={() => retryConnection()}
        disabled={retrying}
        className="flex items-center gap-1 flex-shrink-0 px-2 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/15 disabled:opacity-60 transition-colors"
      >
        {!retrying && <RefreshCw className="w-3 h-3" />}
        {t('backend.retry')}
      </button>
    </div>
  );
};

export default BackendStatusBanner;
