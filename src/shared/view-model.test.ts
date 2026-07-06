import { describe, expect, test } from "vitest";
import { buildDetailModel, formatDuration, sanitizeSessionName, toolDisplayName } from "./view-model";
import type { SessionView } from "../main/state/tracker";

function s(partial: Partial<SessionView>): SessionView {
  return {
    tool: "cursor",
    sessionId: "s1",
    state: "running",
    waitingKind: null,
    missedQuestion: false,
    missedReason: null,
    note: null,
    stateSince: 1000,
    lastEventAt: 1000,
    ...partial,
  };
}

const now = 100_000;

describe("buildDetailModel", () => {
  test("waiting 行高亮、软黄灯带忽略按钮、精确黄灯不带", () => {
    const rows = buildDetailModel(
      [
        s({ sessionId: "a", state: "waiting", waitingKind: "trailing_question" }),
        s({ sessionId: "b", state: "waiting", waitingKind: "question" }),
      ],
      "zh",
      now,
    ).rows;
    const a = rows.find((r) => r.sessionId === "a")!;
    const b = rows.find((r) => r.sessionId === "b")!;
    expect(a.highlight).toBe(true);
    expect(a.canIgnore).toBe(true);
    expect(b.canIgnore).toBe(false);
  });

  test("failed 行带知悉按钮", () => {
    const rows = buildDetailModel([s({ state: "failed" })], "zh", now).rows;
    expect(rows[0].canAcknowledge).toBe(true);
  });

  test("错过提问标记透出，原因映射本地化文案", () => {
    const rows = buildDetailModel([s({ missedQuestion: true, missedReason: "dismissed" })], "zh", now).rows;
    expect(rows[0].missedQuestion).toBe(true);
    expect(rows[0].missedLabel).toBe("提问表单被意外关闭，作答未提交");
    const unanswered = buildDetailModel([s({ missedQuestion: true, missedReason: "unanswered" })], "en", now).rows;
    expect(unanswered[0].missedLabel).toBe("Question auto-handled without answer");
    // 旧版标记无原因：回退 unanswered 文案；无标记则无文案
    const legacy = buildDetailModel([s({ missedQuestion: true, missedReason: null })], "zh", now).rows;
    expect(legacy[0].missedLabel).toBe("提问未作答被自动处理");
    expect(buildDetailModel([s({})], "zh", now).rows[0].missedLabel).toBeNull();
  });

  test("排序：waiting > failed > running > idle", () => {
    const rows = buildDetailModel(
      [s({ sessionId: "i", state: "idle" }), s({ sessionId: "r" }), s({ sessionId: "f", state: "failed" }), s({ sessionId: "w", state: "waiting", waitingKind: "question" })],
      "zh",
      now,
    ).rows;
    expect(rows.map((r) => r.sessionId)).toEqual(["w", "f", "r", "i"]);
  });

  test("同状态按 stateSince 倒序（最新在前）", () => {
    const idles = Array.from({ length: 4 }, (_, i) => s({ sessionId: `i${i}`, state: "idle", stateSince: i * 100 }));
    const model = buildDetailModel(idles, "zh", now);
    expect(model.rows.map((r) => r.sessionId)).toEqual(["i3", "i2", "i1", "i0"]);
  });

  test("会话名缺省显示 sessionId 前 8 位", () => {
    const rows = buildDetailModel([s({ sessionId: "abcdefgh-1234" })], "zh", now).rows;
    expect(rows[0].name).toBe("abcdefgh");
  });

  test("等待类型标签本地化", () => {
    const rows = buildDetailModel([s({ state: "waiting", waitingKind: "approval" })], "zh", now).rows;
    expect(rows[0].statusLabel).toBe("等待命令审批");
    const rowsEn = buildDetailModel([s({ state: "waiting", waitingKind: "approval" })], "en", now).rows;
    expect(rowsEn[0].statusLabel).toBe("Waiting for approval");
  });

  test("混合工具：行保留 tool 标识，排序只看状态不看工具", () => {
    const rows = buildDetailModel(
      [
        s({ tool: "codex", sessionId: "cx", state: "idle" }),
        s({ tool: "cursor", sessionId: "cu", state: "waiting", waitingKind: "question" }),
        s({ tool: "codex", sessionId: "cx2", state: "running" }),
      ],
      "zh",
      now,
    ).rows;
    expect(rows.map((r) => `${r.tool}:${r.sessionId}`)).toEqual(["cursor:cu", "codex:cx2", "codex:cx"]);
  });

  test("tool_exited 文案按工具名区分（中英）", () => {
    const cx = buildDetailModel([s({ tool: "codex", note: "tool_exited" })], "zh", now).rows;
    expect(cx[0].statusLabel).toBe("Codex 已退出");
    const cu = buildDetailModel([s({ tool: "cursor", note: "tool_exited" })], "en", now).rows;
    expect(cu[0].statusLabel).toBe("Cursor exited");
  });

  test("codex 审批标签带「或已批准执行中」标注（批准瞬间无 hook，spike 1.3）", () => {
    const rows = buildDetailModel([s({ tool: "codex", state: "waiting", waitingKind: "approval" })], "zh", now).rows;
    expect(rows[0].statusLabel).toBe("等待审批（或已批准执行中）");
    const rowsEn = buildDetailModel([s({ tool: "codex", state: "waiting", waitingKind: "approval" })], "en", now).rows;
    expect(rowsEn[0].statusLabel).toBe("Waiting for approval (may be running)");
  });
});

describe("user_action 等待行（qoder）", () => {
  test("等待用户操作文案（非审批措辞）且不可忽略", () => {
    const v: SessionView = {
      tool: "qoder",
      sessionId: "task-1.session.execution",
      state: "waiting",
      waitingKind: "user_action",
      missedQuestion: false,
      note: null,
      stateSince: 1000,
      lastEventAt: 1000,
    };
    const row = buildDetailModel([v], "zh", 2000).rows[0];
    expect(row.statusLabel).toBe("等待用户操作");
    expect(row.canIgnore).toBe(false);
    expect(row.highlight).toBe(true);
    expect(buildDetailModel([v], "en", 2000).rows[0].statusLabel).toBe("Waiting for user action");
  });

  test("qoder 工具显示名为 Qoder", () => {
    expect(toolDisplayName("qoder")).toBe("Qoder");
  });

  test("antigravity 工具显示名为 Antigravity", () => {
    expect(toolDisplayName("antigravity")).toBe("Antigravity");
  });
});

describe("sanitizeSessionName（codex 原始 prompt 标题清洗）", () => {
  test("markdown 链接留文字、格式符去除、换行压缩", () => {
    expect(sanitizeSessionName("帮我对 [ai-traffic-light](ai-traffic-light/) 执行 code review，检查是否存在bug")).toBe("帮我对 ai-traffic-light 执行 code review，检查是否存在bug");
    expect(sanitizeSessionName("Run `touch /tmp/x`.\n  Do **nothing** else.")).toBe("Run touch /tmp/x. Do nothing else.");
  });

  test("干净标题原样保留", () => {
    expect(sanitizeSessionName("Cursor会话状态监控实现")).toBe("Cursor会话状态监控实现");
  });
});

describe("formatDuration", () => {
  test("秒/分/时", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(65_000)).toBe("1m5s");
    expect(formatDuration(3_665_000)).toBe("1h1m");
  });
});
