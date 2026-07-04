import { beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexProbeSnapshot, locateRollout, readRolloutTail, resolveCodexStop, scanRecentRollouts } from "./rollout-reader";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-rollout-"));
});

function line(type: string, payload: Record<string, unknown>, ts = "2026-07-04T01:00:00.000Z"): string {
  return JSON.stringify({ timestamp: ts, type, payload });
}

function writeRollout(name: string, lines: string[], sub = "2026/07/04"): string {
  const d = join(dir, sub);
  mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const META = line("session_meta", { id: "th-1", session_id: "th-1", cwd: "/x" });

describe("readRolloutTail（终态倒序解析）", () => {
  test("task_complete → completed + last_agent_message", () => {
    const p = writeRollout("r1.jsonl", [
      META,
      line("event_msg", { type: "task_started" }),
      line("event_msg", { type: "task_complete", last_agent_message: "要继续吗？" }),
      line("event_msg", { type: "token_count", info: {} }),
    ]);
    expect(readRolloutTail(p)).toEqual({ ok: true, status: "completed", lastAssistantMessage: "要继续吗？" });
  });

  test("turn_aborted → aborted", () => {
    const p = writeRollout("r2.jsonl", [META, line("event_msg", { type: "task_started" }), line("event_msg", { type: "turn_aborted", reason: "interrupted" })]);
    expect(readRolloutTail(p)).toEqual({ ok: true, status: "aborted", lastAssistantMessage: null });
  });

  test("error 宽匹配：尾部最后一个 event_msg 类型含 error 字样 → error", () => {
    const p = writeRollout("r3.jsonl", [META, line("event_msg", { type: "task_started" }), line("event_msg", { type: "stream_error", message: "boom" })]);
    expect(readRolloutTail(p).status).toBe("error");
  });

  test("回合中途 stream_error 重试成功后尾部 task_complete → completed（终态位置约束）", () => {
    const p = writeRollout("r4.jsonl", [
      META,
      line("event_msg", { type: "stream_error", message: "retrying" }),
      line("event_msg", { type: "task_complete", last_agent_message: null }),
    ]);
    expect(readRolloutTail(p).status).toBe("completed");
  });

  test("回合边界约束：上一轮 task_complete 不被误取为当前回合终态（新回合已 task_started）", () => {
    const p = writeRollout("r-boundary.jsonl", [
      META,
      line("event_msg", { type: "task_complete", last_agent_message: "上一轮的结尾" }),
      line("event_msg", { type: "task_started" }),
      line("event_msg", { type: "user_message", message: "新指令" }),
      line("event_msg", { type: "agent_message", message: "思考中" }),
      line("event_msg", { type: "token_count" }),
    ]);
    expect(readRolloutTail(p)).toEqual({ ok: true, status: "running", lastAssistantMessage: null });
  });

  test("无终态事件（回合进行中）→ running", () => {
    const p = writeRollout("r5.jsonl", [META, line("event_msg", { type: "task_started" }), line("response_item", { type: "function_call" })]);
    expect(readRolloutTail(p)).toEqual({ ok: true, status: "running", lastAssistantMessage: null });
  });

  test("文件不存在 → ok=false（调用方兜底 completed）", () => {
    expect(readRolloutTail(join(dir, "nope.jsonl")).ok).toBe(false);
  });

  test("坏行与未知事件类型跳过不报错（schema 宽容）", () => {
    const p = writeRollout("r6.jsonl", ["not-json{", line("weird_future_type", {}), line("event_msg", { type: "task_complete", last_agent_message: "done" })]);
    expect(readRolloutTail(p).status).toBe("completed");
  });
});

describe("locateRollout（目录扫描兜底）", () => {
  test("按 threadId 命中文件名；同 threadId 多文件（resume）取 mtime 最新", () => {
    const older = writeRollout("rollout-2026-07-03T10-00-00-th-9.jsonl", [META], "2026/07/03");
    const newer = writeRollout("rollout-2026-07-04T09-00-00-th-9.jsonl", [META], "2026/07/04");
    utimesSync(older, new Date("2026-07-03T10:00:00Z"), new Date("2026-07-03T10:00:00Z"));
    utimesSync(newer, new Date("2026-07-04T09:00:00Z"), new Date("2026-07-04T09:00:00Z"));
    expect(locateRollout(dir, "th-9")).toBe(newer);
  });

  test("无命中 → null", () => {
    expect(locateRollout(dir, "th-none")).toBeNull();
  });
});

describe("resolveCodexStop（stopStatusResolver 实现）", () => {
  test("transcriptPath 优先直读", () => {
    const p = writeRollout("rollout-x-th-2.jsonl", [META, line("event_msg", { type: "turn_aborted", reason: "interrupted" })]);
    expect(resolveCodexStop(dir, "th-2", p)).toEqual({ status: "aborted", lastAssistantMessage: null });
  });

  test("transcriptPath 缺失时目录扫描兜底", () => {
    writeRollout("rollout-2026-07-04T09-00-00-th-3.jsonl", [META, line("event_msg", { type: "task_complete", last_agent_message: "好了" })]);
    expect(resolveCodexStop(dir, "th-3", undefined)).toEqual({ status: "completed", lastAssistantMessage: "好了" });
  });

  test("全部失败 → null（tracker 兜底 completed）", () => {
    expect(resolveCodexStop(dir, "th-404", "/nope/x.jsonl")).toBeNull();
  });

  test("文件可读但无终态（running）→ 视为解析失败返回 null", () => {
    const p = writeRollout("rollout-x-th-5.jsonl", [META, line("event_msg", { type: "task_started" })]);
    expect(resolveCodexStop(dir, "th-5", p)).toBeNull();
  });
});

describe("codexProbeSnapshot（3.4 probe 兜底）", () => {
  test("rollout 尾部有终态 → snapshot.terminal 带回（tracker 注入合成 stop）", () => {
    const p = writeRollout("rollout-x-th-p1.jsonl", [META, line("event_msg", { type: "turn_aborted", reason: "interrupted" })]);
    const snap = codexProbeSnapshot(dir, "th-p1", p);
    expect(snap).not.toBeNull();
    expect(snap!.terminal).toEqual({ status: "aborted", lastAssistantMessage: null });
    expect(snap!.pending.kind).toBe("none");
  });

  test("回合进行中（无终态）→ 无 terminal 的常规快照", () => {
    const p = writeRollout("rollout-x-th-p2.jsonl", [META, line("event_msg", { type: "task_started" })]);
    const snap = codexProbeSnapshot(dir, "th-p2", p);
    expect(snap!.terminal).toBeUndefined();
    expect(snap!.executing).toBe(false);
  });

  test("文件不可读 → null（探针通道降级信号）", () => {
    expect(codexProbeSnapshot(dir, "th-p404", undefined)).toBeNull();
  });
});

describe("scanRecentRollouts（冷启动重建）", () => {
  const now = new Date("2026-07-04T12:00:00Z").getTime();

  test("近 7 天窗口内：未终态会话全部恢复，已完成会话仅近 24h", () => {
    const meta = (id: string) => line("session_meta", { id, session_id: id });
    // 3 天前完成 → 超 24h，不纳入
    const old = writeRollout("rollout-2026-07-01T10-00-00-th-a.jsonl", [meta("th-a"), line("event_msg", { type: "task_complete" })], "2026/07/01");
    utimesSync(old, new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T10:00:00Z"));
    // 3 天前未终态 → 恢复
    const oldRunning = writeRollout("rollout-2026-07-01T11-00-00-th-b.jsonl", [meta("th-b"), line("event_msg", { type: "task_started" })], "2026/07/01");
    utimesSync(oldRunning, new Date("2026-07-01T11:00:00Z"), new Date("2026-07-01T11:00:00Z"));
    // 1 小时前完成 → 纳入
    const fresh = writeRollout("rollout-2026-07-04T11-00-00-th-c.jsonl", [meta("th-c"), line("event_msg", { type: "task_complete", last_agent_message: "done" })]);
    utimesSync(fresh, new Date("2026-07-04T11:00:00Z"), new Date("2026-07-04T11:00:00Z"));

    const got = scanRecentRollouts(dir, now);
    const ids = got.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["th-b", "th-c"]);
    expect(got.find((s) => s.sessionId === "th-b")?.status).toBe("running");
    expect(got.find((s) => s.sessionId === "th-c")?.status).toBe("completed");
  });

  test("超 7 天目录不扫描", () => {
    const stale = writeRollout("rollout-2026-06-20T10-00-00-th-z.jsonl", [META, line("event_msg", { type: "task_started" })], "2026/06/20");
    utimesSync(stale, new Date("2026-06-20T10:00:00Z"), new Date("2026-06-20T10:00:00Z"));
    expect(scanRecentRollouts(dir, now)).toHaveLength(0);
  });

  test("sessionId 取 session_meta 的 id（session_id 兜底、文件名再兜底）", () => {
    const noIdMeta = line("session_meta", { session_id: "th-legacy" });
    const p = writeRollout("rollout-2026-07-04T10-00-00-th-legacy.jsonl", [noIdMeta, line("event_msg", { type: "task_started" })]);
    utimesSync(p, new Date("2026-07-04T10:00:00Z"), new Date("2026-07-04T10:00:00Z"));
    expect(scanRecentRollouts(dir, now)[0]?.sessionId).toBe("th-legacy");
  });
});
