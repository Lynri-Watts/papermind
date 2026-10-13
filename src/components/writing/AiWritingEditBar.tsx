/**
 * 回答末尾的「AI 修改了论文文档」提示条（边写边审的事务级入口）。
 *
 * 一问一事务：本次回答对工作区所有文件的写入（edit/create/append/input）
 * 共享一个 transactionId。逐块接受/拒绝在 CodeEditor 内联 diff 中完成，
 * 本条提供两个事务级动作：
 * - 全部接受：剩余待审块一次性消标记（文件内容不动，本就是 AI 写入版）；
 * - 撤销本次写作：服务端按 seq 逆序物理回滚（新建文件删除、文本块反向还原），
 *   回滚结果经 writingReview store 的 filePatch 自动回填编辑器。
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, PenLine, Undo2 } from 'lucide-react';
import type { ChatWritingEdit } from '../../types';
import { useWritingReviewStore } from '../../store/writingReview';

export interface AiWritingEditBarProps {
  /** 本次回答关联的写作事务（无写入则缺省，整条不渲染） */
  edit?: ChatWritingEdit;
  /** 生成中：只显示「AI 正在写作」，事务尚未结束不允许整事务操作 */
  locked?: boolean;
  /** 本地状态回写（accepted/undone），由父组件落到消息上持久化 */
  onChange: (patch: Partial<ChatWritingEdit>) => void;
}

const AiWritingEditBar: React.FC<AiWritingEditBarProps> = ({ edit, locked = false, onChange }) => {
  const { t } = useTranslation('writing');
  const busyTxn = useWritingReviewStore((s) => s.busyTxn);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!edit) return null;
  const wsId = edit.workspaceId ?? '';
  const busy = busyTxn === edit.transactionId;

  const handleAcceptAll = async () => {
    setErrorMsg(null);
    const review = useWritingReviewStore.getState();
    await review.acceptTransaction(wsId, edit.transactionId);
    const err = useWritingReviewStore.getState().lastError;
    if (err) {
      // 对账兜底已在 store 内执行；展示错误，条不消失，用户可重试
      setErrorMsg(err);
      return;
    }
    // 返回 count=0（此刻已无待审块，如已在编辑器里逐块接受完）同样视为完成
    onChange({ accepted: true });
  };

  const handleUndo = async () => {
    setErrorMsg(null);
    const review = useWritingReviewStore.getState();
    const result = await review.rollbackTransaction(wsId, edit.transactionId);
    if (!result) {
      setErrorMsg(useWritingReviewStore.getState().lastError ?? t('review.actionFailed'));
      return;
    }
    // 部分冲突（409）：已还原的部分已回填，剩余块保持待审，不标记完成
    if (!result.ok) {
      setErrorMsg(result.error ?? t('review.actionFailed'));
      return;
    }
    onChange({ undone: true });
  };

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-text">
        <PenLine size={14} className="shrink-0 text-emerald-400" />
        {edit.undone ? (
          <span className="flex items-center gap-1 font-medium text-emerald-300">
            <Check size={13} />
            {t('review.undone')}
          </span>
        ) : edit.accepted ? (
          <span className="flex items-center gap-1 font-medium text-emerald-300">
            <Check size={13} />
            {t('review.acceptedAll')}
          </span>
        ) : locked ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-emerald-300">
            <Loader2 size={12} className="animate-spin" />
            <span className="truncate">{t('review.writingLive')}</span>
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{t('review.editedHint')}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void handleAcceptAll()}
                disabled={busy}
                className="flex items-center gap-1 rounded-md bg-emerald-500/20 px-2 py-1 font-medium text-emerald-300 ring-1 ring-emerald-500/30 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {t('review.acceptAll')}
              </button>
              <button
                type="button"
                onClick={() => void handleUndo()}
                disabled={busy}
                className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 font-medium text-textSecondary ring-1 ring-border transition-colors hover:bg-white/20 hover:text-text disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                {t('review.undoAll')}
              </button>
            </div>
          </>
        )}
      </div>
      {errorMsg && !locked && (
        <p className="mt-1 px-1 text-[11px] text-red-400">{errorMsg}</p>
      )}
    </div>
  );
};

export default AiWritingEditBar;
