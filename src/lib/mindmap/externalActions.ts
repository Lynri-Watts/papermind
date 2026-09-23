/**
 * 画布外部的思维导图写入编排（Explore 结果卡 / 上下文卡 / 后续 AI 工具共用）。
 *
 * 为什么不走画布本地队列：发起方可能与画布不同屏，甚至画布尚未挂载。
 * 因此这里直接对服务端提交（服务端是最终权威），成功后：
 *   1. 更新 store 文档缓存（图库列表 version/时间随之刷新）；
 *   2. 通过 bridge 广播已提交事件 —— 打开的画布即时落图，后挂载的画布靠版本去重。
 */
import { submitMindmapActions } from '../../api';
import { usePaperMindStore } from '../../store';
import type { MindmapAction } from '../../types';
import { findRoot } from './model';
import { emitMindmapCommitted } from './bridge';

export interface MindmapPaperInput {
  /** 论文标识（local:<ws>:<path> 或 arxiv:xxx 等 source:external_id） */
  id: string;
  title: string;
}

export interface AddPaperOutcome {
  mapId: string;
  mapTitle: string;
  /** true=本次调用自动新建了导图 */
  created: boolean;
  /** true=导图中已存在同一 paperId 的论文节点，未重复添加 */
  duplicated: boolean;
}

/** 生成批内临时节点 ID（与 useMindmapEditor.newClientTempId 同形态）。 */
function tempNodeId(): string {
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  return `tmp_${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 把论文作为 paper 节点加入指定作用域的「当前导图」根下。
 * 没有当前导图时，用 defaultMapTitle 新建一张，并将其设为该作用域选中项。
 */
export async function addPaperToActiveMindmap(
  paper: MindmapPaperInput,
  options: { workspaceId: string | null; defaultMapTitle: string }
): Promise<AddPaperOutcome> {
  const { workspaceId, defaultMapTitle } = options;
  const store = usePaperMindStore.getState();

  // 1. 确保有当前导图（store thunk 会把它设为作用域选中项并缓存首版文档）
  let mapId = store.getActiveMindmapId(workspaceId);
  let created = false;
  if (!mapId) {
    const info = await store.createMindmap({
      workspaceId,
      title: defaultMapTitle,
      rootText: defaultMapTitle,
    });
    mapId = info.id;
    created = true;
  }

  // 2. 强制拉最新文档（version 必须新鲜，否则 409）
  const info = await usePaperMindStore.getState().loadMindmapDoc(mapId, workspaceId, true);
  const root = findRoot(info.nodes);
  if (!root) throw new Error('mindmap root missing');

  // 3. 幂等：同一 paperId 已存在则直接返回
  if (info.nodes.some((n) => n.kind === 'paper' && n.paperId === paper.id)) {
    return { mapId, mapTitle: info.title, created, duplicated: true };
  }

  // 4. 提交 add_node（挂根下；服务端生成正式 ID 并经 idMap 回填）
  const actions: MindmapAction[] = [
    {
      op: 'add_node',
      id: tempNodeId(),
      parentId: root.id,
      text: paper.title,
      kind: 'paper',
      paperId: paper.id,
    },
  ];
  const result = await submitMindmapActions(mapId, info.version, actions, workspaceId);

  // 5. 缓存 + 广播
  usePaperMindStore.getState().cacheMindmapDoc(result.mindmap);
  emitMindmapCommitted(mapId, {
    version: result.mindmap.version,
    actions,
    idMap: result.idMap,
    origin: 'user',
  });

  return { mapId, mapTitle: result.mindmap.title, created, duplicated: false };
}
