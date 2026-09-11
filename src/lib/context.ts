/**
 * 上下文库共享编排：把论文加入工作区上下文库（HTTP + 幂等入库）。
 *
 * 三个调用方共用同一条链路，避免状态不一致：
 * - 阅读器「加入上下文」按钮（src/pages/DeepResearch.tsx）
 * - QAPanel 工具流候选论文加入（handleAddToolPaperToContext）
 * - 问答前阅读焦点自动收录（ensureReadingFocusInContext）
 *
 * 幂等性：
 * - 后端 POST /context 对 paper 按 ref_id 判重，返回的可能是既有条目；
 * - 本地 store 按返回条目 id 合并（已存在则 patch，避免列表重复）。
 * 注意：PDF 选中摘录（summary_override）不走本模块——摘录在后端不判重、
 * 允许同一论文保留多条。
 */
import { createPaperContext } from '../api';
import { usePaperMindStore } from '../store';
import type { ContextItem } from '../types';

export async function addPaperContextItem(
  paperId: string,
  workspaceId?: string,
): Promise<ContextItem> {
  const item = await createPaperContext(paperId, undefined, workspaceId);
  const state = usePaperMindStore.getState();
  if (state.contextItems.some((x) => x.id === item.id)) {
    state.patchContextItem(item.id, item);
  } else {
    state.addContextItem(item);
  }
  return item;
}

/** 某篇论文是否已作为完整 paper 上下文条目存在（不含同论文的选中摘录）。 */
export function isPaperInContext(paperId: string): boolean {
  return usePaperMindStore.getState().contextItems.some(
    (i) => i.type === 'paper' && i.paperId === paperId,
  );
}
