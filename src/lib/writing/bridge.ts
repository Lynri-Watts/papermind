/**
 * 写作工作区宿主桥。
 *
 * QAPanel（发送链路）在提问前必须把所有打开文件的防抖缓冲区落盘，
 * 但它不应直接接触 WritingWorkspace 的内部状态。WritingWorkspace 挂载时
 * 注册宿主（flushAll），卸载时注销；QAPanel 经 requestWritingFlush 调用。
 *
 * 与 lib/mindmap/bridge 不同：flush 是一次性的命令式请求，不需要事件缓冲。
 */
export interface WritingHost {
  /** 把 main.tex 与全部子文件的待保存改动立即落盘（编译/提问前调用） */
  flushAll: () => Promise<void>;
}

let host: WritingHost | null = null;

/** WritingWorkspace 挂载/卸载时注册宿主；传 null 注销。 */
export function registerWritingHost(next: WritingHost | null): void {
  host = next;
}

/** 请求宿主立即落盘；写作区未挂载（非写作视图）时直接成功。 */
export async function requestWritingFlush(): Promise<void> {
  if (!host) return;
  await host.flushAll();
}
