// Cursor 专属气泡判定（v2 起从 tracker 下沉到 adapter 内部）：
// 把 state.vscdb 查询结果翻译成工具无关的 ProbeSnapshot，tracker 不再认识 BubbleRow。
// 判据来自 2026-07-03 实验（design.md Context 8/9）：
// 挂起等待 = additionalData.status="pending"（bubble status 在挂起 30s 后会翻 completed，不可靠）；
// 挂起初期存在 additionalData 为空的过渡窗口，此时 ask_question 的 status=loading 仍可判提问。
import { ASK_QUESTION_TOOL, DECISION_ACCEPTED, PENDING_ADDITIONAL_STATUS, REVIEW_REQUESTED } from "./db-constants";
import type { BubbleRow } from "./db-reader";
import type { ProbeResult, ProbeSnapshot } from "../adapter";

/** rowid 倒序结果中的最新工具气泡（跳过普通消息气泡） */
function latestToolBubble(rows: BubbleRow[]): BubbleRow | null {
  return rows.find((r) => r.toolName !== null) ?? null;
}

export function judgePending(rows: BubbleRow[]): ProbeResult {
  const b = latestToolBubble(rows);
  if (!b) return { kind: "none" };
  const isPending = b.additionalStatus === PENDING_ADDITIONAL_STATUS;
  if (b.toolName === ASK_QUESTION_TOOL) {
    // 实测（2026-07-03）：作答后 pending 字段长时间不翻转，但新气泡数秒内就会追加到 ask 之后；
    // ask 不再是最新一条气泡 = 会话已恢复，残留的 pending 视为已作答
    if (rows[0] !== b) return { kind: "none" };
    if (isPending) return { kind: "question_pending" };
    // 过渡窗口：loading 且 additionalData 尚未写入。实测气泡在弹窗真正展示前几秒就已建库，
    // 标记 tentative 由调用方加确认期，避免"还在执行就亮黄"
    if (b.status === "loading" && b.additionalStatus === null) {
      return { kind: "question_pending", tentative: true };
    }
    return { kind: "none" };
  }
  if (isPending) {
    return { kind: "approval_pending", blockReason: b.blockReason ?? undefined };
  }
  return { kind: "none" };
}

/** 错过提问：ask_question 结束挂起（非 pending/loading）且 userDecision 非 accepted */
export function judgeMissedQuestion(rows: BubbleRow[]): boolean {
  const b = latestToolBubble(rows);
  if (!b || b.toolName !== ASK_QUESTION_TOOL) return false;
  const stillPending = b.additionalStatus === PENDING_ADDITIONAL_STATUS || (b.status === "loading" && b.additionalStatus === null);
  if (stillPending) return false;
  return b.userDecision !== DECISION_ACCEPTED;
}

/** 疑似卡死候选：最新工具气泡 loading 且不属于挂起等待（时长阈值由调用方计时） */
export function judgeStuck(rows: BubbleRow[]): boolean {
  const b = latestToolBubble(rows);
  if (!b) return false;
  return b.status === "loading" && b.additionalStatus !== PENDING_ADDITIONAL_STATUS;
}

/**
 * 明确执行中：最新工具气泡 loading 且带非 pending 的附加状态（实测执行中为 "cancelled"）、
 * 无审批请求标记。用于排除审批误报——真审批的过渡窗口也长这样，但 ~15s 内会翻 pending，
 * 调用方按 tick 复查即可；additionalStatus 为 null（未写入）视为证据不足，不算执行中。
 */
export function judgeExecuting(rows: BubbleRow[]): boolean {
  const b = latestToolBubble(rows);
  if (!b) return false;
  return b.status === "loading" && b.additionalStatus !== null && b.additionalStatus !== PENDING_ADDITIONAL_STATUS && b.reviewStatus !== REVIEW_REQUESTED;
}

/** Cursor 探针通路出口：气泡行 → 工具无关快照；null（DB 不可用）原样透传为降级信号 */
export function snapshotFromBubbles(rows: BubbleRow[] | null): ProbeSnapshot | null {
  if (rows === null) return null;
  return {
    pending: judgePending(rows),
    executing: judgeExecuting(rows),
    stuckCandidate: judgeStuck(rows),
    missedQuestion: judgeMissedQuestion(rows),
  };
}
