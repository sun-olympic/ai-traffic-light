import { describe, expect, test } from "vitest";
import { judgePending, judgeMissedQuestion, judgeStuck, snapshotFromBubbles } from "./bubble-judge";
import type { BubbleRow } from "./db-reader";

function row(partial: Partial<BubbleRow>): BubbleRow {
  return {
    key: "bubbleId:c1:b1",
    toolName: null,
    status: null,
    userDecision: null,
    additionalStatus: null,
    blockReason: null,
    reviewStatus: null,
    ...partial,
  };
}

describe("judgePending（黄灯精确判据，design Context 8/9）", () => {
  test("ask_question + additionalData.status=pending → 提问等待", () => {
    const rows = [row({ toolName: "ask_question", status: "completed", additionalStatus: "pending" })];
    expect(judgePending(rows)).toEqual({ kind: "question_pending" });
  });

  test("ask_question 挂起初期（status=loading, additionalData=null）→ 提问等待（tentative，需确认期）", () => {
    const rows = [row({ toolName: "ask_question", status: "loading" })];
    expect(judgePending(rows)).toEqual({ kind: "question_pending", tentative: true });
  });

  test("run_terminal + additionalData.status=pending → 审批等待（带 blockReason）", () => {
    const rows = [
      row({
        toolName: "run_terminal_command_v2",
        status: "loading",
        additionalStatus: "pending",
        blockReason: "Not in allowlist: sudo",
        reviewStatus: "Requested",
      }),
    ];
    expect(judgePending(rows)).toEqual({ kind: "approval_pending", blockReason: "Not in allowlist: sudo" });
  });

  test("已作答的 ask_question（submitted/accepted）不判等待", () => {
    const rows = [row({ toolName: "ask_question", status: "completed", userDecision: "accepted", additionalStatus: "submitted" })];
    expect(judgePending(rows)).toEqual({ kind: "none" });
  });

  test("普通完成气泡不判等待", () => {
    const rows = [row({ toolName: "run_terminal_command_v2", status: "completed", additionalStatus: "success" })];
    expect(judgePending(rows)).toEqual({ kind: "none" });
  });

  test("只看最新的工具气泡：新气泡已完成时忽略旧挂起", () => {
    const rows = [
      row({ toolName: "run_terminal_command_v2", status: "completed", additionalStatus: "success" }),
      row({ toolName: "ask_question", status: "loading", additionalStatus: "pending" }),
    ];
    expect(judgePending(rows)).toEqual({ kind: "none" });
  });

  test("挂起中的 ask 是最新气泡时判等待（实测挂起期间不会有更新的气泡）", () => {
    const rows = [row({ toolName: "ask_question", status: "loading" }), row({})];
    expect(judgePending(rows)).toEqual({ kind: "question_pending", tentative: true });
  });

  test("ask 之后出现新气泡 = 已作答恢复，残留 pending 不再判等待（实测 pending 翻转严重滞后）", () => {
    const rows = [row({}), row({ toolName: "ask_question", status: "completed", additionalStatus: "pending" })];
    expect(judgePending(rows)).toEqual({ kind: "none" });
  });

  test("非工具气泡不影响审批等待判定", () => {
    const rows = [row({}), row({ toolName: "run_terminal_command_v2", status: "loading", additionalStatus: "pending" })];
    expect(judgePending(rows)).toEqual({ kind: "approval_pending", blockReason: undefined });
  });

  test("空结果 → none（CLI 会话静默跳过）", () => {
    expect(judgePending([])).toEqual({ kind: "none" });
  });
});

describe("judgeMissedQuestion（3.2a：提问结束挂起时检查 userDecision）", () => {
  test("翻转后非 accepted → 错过提问", () => {
    const rows = [row({ toolName: "ask_question", status: "completed", userDecision: null, additionalStatus: "expired" })];
    expect(judgeMissedQuestion(rows)).toBe(true);
  });

  test("正常作答 accepted → 不标记", () => {
    const rows = [row({ toolName: "ask_question", status: "completed", userDecision: "accepted", additionalStatus: "submitted" })];
    expect(judgeMissedQuestion(rows)).toBe(false);
  });

  test("仍在挂起（pending）→ 不标记", () => {
    const rows = [row({ toolName: "ask_question", status: "completed", additionalStatus: "pending" })];
    expect(judgeMissedQuestion(rows)).toBe(false);
  });

  test("最新气泡不是 ask_question → 不标记", () => {
    const rows = [row({ toolName: "run_terminal_command_v2", status: "completed" })];
    expect(judgeMissedQuestion(rows)).toBe(false);
  });
});

describe("snapshotFromBubbles（2.3：气泡行 → 工具无关快照）", () => {
  test("null（DB 不可用）透传为 null 降级信号", () => {
    expect(snapshotFromBubbles(null)).toBeNull();
  });

  test("pending ask 快照：pending=question、非执行中、非卡死", () => {
    const snap = snapshotFromBubbles([row({ toolName: "ask_question", status: "completed", additionalStatus: "pending" })]);
    expect(snap).toEqual({
      pending: { kind: "question_pending" },
      executing: false,
      stuckCandidate: false,
      missedQuestion: false,
    });
  });

  test("执行中气泡快照：executing=true 且 stuckCandidate=true（卡死由 tracker 计时定罪）", () => {
    const snap = snapshotFromBubbles([row({ toolName: "generate_image", status: "loading", additionalStatus: "cancelled" })]);
    expect(snap?.executing).toBe(true);
    expect(snap?.stuckCandidate).toBe(true);
    expect(snap?.pending.kind).toBe("none");
  });

  test("过期 ask 快照：missedQuestion=true", () => {
    const snap = snapshotFromBubbles([row({ toolName: "ask_question", status: "completed", additionalStatus: "expired" })]);
    expect(snap?.missedQuestion).toBe(true);
  });
});

describe("judgeStuck（3.3b：最新气泡 loading 超阈值）", () => {
  test("loading 且非挂起等待 → 卡死候选", () => {
    const rows = [row({ toolName: "generate_image", status: "loading" })];
    expect(judgeStuck(rows)).toBe(true);
  });

  test("挂起等待（additionalData.status=pending）不算卡死（属于审批/提问黄灯）", () => {
    const rows = [row({ toolName: "run_terminal_command_v2", status: "loading", additionalStatus: "pending" })];
    expect(judgeStuck(rows)).toBe(false);
  });

  test("已完成不算卡死", () => {
    const rows = [row({ toolName: "generate_image", status: "completed" })];
    expect(judgeStuck(rows)).toBe(false);
  });
});
