/**
 * 后端在线状态（全局单一事实源，框架无关，可被 React 订阅）。
 *
 * 两条探测通道互为补充：
 * 1. **心跳**：startBackendWatch 后定时 GET /api/health。在线时间隔较长
 *    （省请求），离线后缩短间隔以便后端一恢复就自动消提示；页面重新可见时
 *    立即补一次探测（避免后台标签切回时显示过期状态）。
 * 2. **业务请求联动**：api 层每次请求在网络层成功/失败时调用
 *    notifyRequestSucceeded / notifyRequestFailed，后端没启动时用户的首次
 *    操作即可让横幅立刻出现，不必等心跳；fetch 只有「连不上 / 被中止 /
 *    CORS 失败」才会 reject，HTTP 4xx/5xx 仍算后端在线。
 *
 * 状态：
 * - checking：应用刚启动的首次探测（横幅不显示，避免闪烁）
 * - online：后端可达
 * - offline：确认不可达（显示横幅）
 * - retrying：离线后用户点了「重试」，探测进行中（横幅显示连接中）
 */
export type BackendStatus = 'checking' | 'online' | 'offline' | 'retrying';

const ONLINE_INTERVAL_MS = 15000;
const OFFLINE_INTERVAL_MS = 4000;
const PING_TIMEOUT_MS = 6000;

let status: BackendStatus = 'checking';
const listeners = new Set<() => void>();

let healthUrl: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let pingSeq = 0;
let disposed = false;
/** 文档可见性回调（仅 watch 启动时注册一次，停止时移除） */
let visibilityHandler: (() => void) | null = null;

function emit(): void {
  listeners.forEach((l) => l());
}

function setStatus(next: BackendStatus): void {
  if (status === next) return;
  status = next;
  emit();
}

export function getBackendStatus(): BackendStatus {
  return status;
}

export function subscribeBackendStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext(): void {
  clearTimer();
  if (disposed || !healthUrl) return;
  const delay = status === 'offline' || status === 'retrying'
    ? OFFLINE_INTERVAL_MS
    : ONLINE_INTERVAL_MS;
  timer = setTimeout(() => {
    void ping();
  }, delay);
}

/** 探测一次 /health；结果驱动状态与下一轮调度。 */
export async function ping(): Promise<boolean> {
  if (!healthUrl) return status === 'online';
  const seq = ++pingSeq;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  let ok = false;
  try {
    const resp = await fetch(healthUrl, { signal: controller.signal });
    ok = resp.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timeout);
  }
  // 后发的探测（手动重试/可见性触发）抢先返回时，丢弃过期结果
  if (seq === pingSeq && !disposed) {
    setStatus(ok ? 'online' : 'offline');
    scheduleNext();
  }
  return ok;
}

/**
 * 启动心跳（幂等，App 挂载时调用一次）。立即做一次探测，之后按在线/离线
 * 状态以不同间隔轮询。
 */
export function startBackendWatch(url: string): void {
  healthUrl = url;
  disposed = false;
  if (!visibilityHandler) {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') void ping();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
  void ping();
}

/** 停止心跳（测试或卸载场景；业务代码一般不调用） */
export function stopBackendWatch(): void {
  disposed = true;
  clearTimer();
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
}

/** 用户手动「重试连接」：进入 retrying 并立即探测 */
export function retryConnection(): void {
  if (status === 'retrying' || status === 'online') return;
  setStatus('retrying');
  void ping();
}

/** 业务请求在网络层成功（拿到任何 HTTP 响应，含 4xx/5xx）时调用 */
export function notifyRequestSucceeded(): void {
  if (status !== 'online') {
    setStatus('online');
    // 心跳间隔随状态切换：恢复在线后回到长间隔
    if (!disposed && healthUrl) scheduleNext();
  }
}

/** 业务请求因网络层失败（fetch reject：连不上/中止/CORS）时调用 */
export function notifyRequestFailed(): void {
  if (status !== 'offline') {
    setStatus('offline');
    // 立即进入离线短间隔轮询，不必等上一轮长间隔走完
    if (!disposed && healthUrl) scheduleNext();
  }
}
