import { beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravitySafeName, AntigravitySnapshotSource } from "./snapshot-source";

let home: string;
let now: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tl-agy-src-"));
  mkdirSync(join(home, "conversations"), { recursive: true });
  now = 1_800_000_000_000;
});

function source(h: string | null = home, retryMs = 30_000): AntigravitySnapshotSource {
  return new AntigravitySnapshotSource(h, { retryMs, clock: () => now });
}

// 全合成结构 fixture（spec：Fixtures are sanitized）
function makeDb(name: string, rows: Array<[number, number, number, string | null]>): string {
  const p = join(home, "conversations", name);
  const db = new DatabaseSync(p);
  db.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, error_details TEXT)");
  for (const [idx, stepType, status, err] of rows) {
    db.prepare("INSERT INTO steps (idx, step_type, status, error_details) VALUES (?, ?, ?, ?)").run(idx, stepType, status, err);
  }
  db.close();
  return p;
}

describe("antigravitySafeName（D21/D32 隐私安全显示名）", () => {
  test("短 id 合成名，不含任何 prompt 类内容", () => {
    expect(antigravitySafeName("f3a9c2d1-7b64-4e21-a0ff-1234567890ab")).toBe("Antigravity f3a9c2d1");
  });
});

describe("AntigravitySnapshotSource（组合快照 + 健康 + 退避）", () => {
  test("home 为 null（非 macOS 无覆盖）→ null + not_detected", () => {
    const s = source(null);
    expect(s.read()).toBeNull();
    expect(s.health()).toBe("not_detected");
  });

  test("home 目录不存在 → null + not_detected（中性，不告警）", () => {
    const s = source(join(home, "nope"));
    expect(s.read()).toBeNull();
    expect(s.health()).toBe("not_detected");
  });

  test("目录存在但无会话库 → 空快照 + ok", () => {
    const s = source();
    expect(s.read()).toEqual({ sessions: [] });
    expect(s.health()).toBe("ok");
  });

  test("现代 brain transcript 会话即使没有 SQLite .db 也进入快照", () => {
    const id = "d8f2cf96-3b06-479e-9003-05b6960bad10";
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), [
      JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-10-14T05:00:00Z" }),
      JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-10-14T05:00:02Z" }),
    ].join("\n"));

    const snap = source().read();
    expect(snap!.sessions.map((s) => s.sessionId)).toContain(id);
    expect(snap!.sessions.find((s) => s.sessionId === id)?.observation).toMatchObject({ kind: "completed", maxIdx: 2 });
  });

  test("步骤均 DONE 但最新 executor_metadata 带错误字段时识别为失败", () => {
    const id = "agent-terminated";
    const p = makeDb(`${id}.db`, [[0, 14, 3, null], [1, 17, 3, null]]);
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE executor_metadata (idx INTEGER, data BLOB)");
    const detail = Buffer.from("Account not eligible", "utf8");
    db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (?, ?)").run(1, Buffer.concat([Buffer.from([0x62, detail.length]), detail]));
    db.close();

    expect(source().read()!.sessions.find((s) => s.sessionId === id)?.observation.kind).toBe("error");
  });

  test("错误字段仍在但存在更新的运行中步骤时不提前亮红", () => {
    const id = "retry-in-progress";
    const p = makeDb(`${id}.db`, [[0, 17, 3, null], [1, 17, 2, null]]);
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE executor_metadata (idx INTEGER, data BLOB)");
    const detail = Buffer.from("Previous attempt failed", "utf8");
    db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (?, ?)").run(0, Buffer.concat([Buffer.from([0x62, detail.length]), detail]));
    db.close();

    expect(source().read()!.sessions.find((s) => s.sessionId === id)?.observation.kind).toBe("running");
  });

  test("现代 transcript 的结构化 WAITING / RUNNING 状态被识别，正文文本不参与判断", () => {
    const id = "modern-session";
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), [
      JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "" }),
      JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "WAITING", content: "" }),
    ].join("\n"));
    expect(source().read()!.sessions.find((s) => s.sessionId === id)?.observation.kind).toBe("waiting");
  });

  test("新用户输入已落盘但模型尚未写入时仍在运行，不能误判完成", () => {
    const id = "user-turn-pending";
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), [
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE" }),
      JSON.stringify({ step_index: 2, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE" }),
    ].join("\n"));

    expect(source().read()!.sessions.find((s) => s.sessionId === id)?.observation.kind).toBe("running");
  });

  test("用户输入后的 SYSTEM/DONE 也不能在模型回复前结束任务", () => {
    const id = "system-before-model";
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), [
      JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE" }),
      JSON.stringify({ step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE" }),
    ].join("\n"));

    expect(source().read()!.sessions.find((s) => s.sessionId === id)?.observation.kind).toBe("running");
  });

  test("相同步骤上的 SQLite 活跃状态优先于 transcript 终态", () => {
    const id = "same-id";
    makeDb(`${id}.db`, [[9, 14, 2, null]]);
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), JSON.stringify({ step_index: 9, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE" }));
    const sessions = source().read()!.sessions.filter((s) => s.sessionId === id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].observation.kind).toBe("running");
    expect(sessions[0].observation.maxIdx).toBe(9);
  });

  test("更新且领先的 transcript 可越过滞后的 SQLite 步骤", () => {
    const id = "transcript-ahead";
    const dbPath = makeDb(`${id}.db`, [[0, 14, 3, null], [1, 15, 3, null]]);
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const transcriptPath = join(logs, "transcript.jsonl");
    writeFileSync(transcriptPath, [0, 1, 2, 3].map((idx) => JSON.stringify({ step_index: idx, status: "DONE" })).join("\n"));
    const dbUpdatedAt = (now - 10_000) / 1000;
    const completedAt = (now - 1_000) / 1000;
    utimesSync(dbPath, dbUpdatedAt, dbUpdatedAt);
    utimesSync(transcriptPath, completedAt, completedAt);

    const session = source().read()!.sessions.find((s) => s.sessionId === id)!;
    expect(session.observation).toMatchObject({ kind: "completed", maxIdx: 3 });
    expect(session.mtime).toBeCloseTo(completedAt * 1000, 0);
  });

  test("同一步骤同一终态时，使用较早的 transcript 完成时间而非延迟更新的 DB 时间", () => {
    const id = "same-terminal";
    const dbPath = makeDb(`${id}.db`, [[0, 14, 3, null], [1, 15, 3, null]]);
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const transcriptPath = join(logs, "transcript.jsonl");
    writeFileSync(transcriptPath, [0, 1].map((idx) => JSON.stringify({ step_index: idx, status: "DONE" })).join("\n"));
    const completedAt = (now - 10_000) / 1000;
    const dbUpdatedAt = (now - 1_000) / 1000;
    utimesSync(transcriptPath, completedAt, completedAt);
    utimesSync(dbPath, dbUpdatedAt, dbUpdatedAt);

    const session = source().read()!.sessions.find((s) => s.sessionId === id)!;
    expect(session.observation).toMatchObject({ kind: "completed", maxIdx: 1 });
    expect(session.mtime).toBeCloseTo(completedAt * 1000, 0);
  });

  test("正常读取：session id 取文件名，observation/mtime/epoch 齐备", () => {
    makeDb("sess-1.db", [[0, 14, 3, null], [1, 5, 2, null]]);
    const snap = source().read();
    expect(snap!.sessions).toHaveLength(1);
    const s = snap!.sessions[0];
    expect(s.sessionId).toBe("sess-1");
    expect(s.observation.kind).toBe("running");
    expect(s.mtime).toBeGreaterThan(0);
    expect(s.epoch).toBeGreaterThan(0);
  });

  test("坏库 + 好库：好库照常返回，健康降级 degraded", () => {
    makeDb("good.db", [[0, 14, 9, null]]);
    writeFileSync(join(home, "conversations", "bad.db"), "not-a-database");
    const s = source();
    const snap = s.read();
    expect(snap!.sessions.map((x) => x.sessionId)).toEqual(["good"]);
    expect(s.health()).toBe("degraded");
  });

  test("同一会话的 SQLite 读取失败时，旧 transcript 不得冒充成功快照", () => {
    const id = "broken-with-transcript";
    writeFileSync(join(home, "conversations", `${id}.db`), "not-a-database");
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), JSON.stringify({ step_index: 4, source: "MODEL", status: "DONE" }));

    const s = source();
    expect(s.read()!.sessions.some((session) => session.sessionId === id)).toBe(false);
    expect(s.health()).toBe("degraded");
  });

  test("schema 不匹配 → schema_mismatch（保守失败，D34）", () => {
    const p = join(home, "conversations", "odd.db");
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE steps (idx INTEGER)"); // 缺必需列
    db.close();
    const s = source();
    s.read();
    expect(s.health()).toBe("schema_mismatch");
  });

  // Windows 无 POSIX 权限位，chmod 000 不生效
  test.skipIf(process.platform === "win32")("权限拒绝 → permission_denied（健康态而非无会话，D24）", () => {
    const p = makeDb("locked.db", [[0, 14, 3, null]]);
    chmodSync(p, 0o000);
    try {
      const s = source();
      s.read();
      expect(s.health()).toBe("permission_denied");
    } finally {
      chmodSync(p, 0o600);
    }
  });

  test("逐文件退避（D35）：失败库在 retryMs 内跳过不重读，窗口过后自动恢复", () => {
    const p = join(home, "conversations", "flaky.db");
    writeFileSync(p, "not-a-database");
    const s = source(home, 30_000);
    s.read();
    expect(s.health()).toBe("degraded");
    // 修复文件（先删坏文件再建真库）；退避窗口内仍跳过 → 快照缺失该会话
    rmSync(p);
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, error_details TEXT)");
    db.prepare("INSERT INTO steps (idx, step_type, status, error_details) VALUES (0, 14, 2, NULL)").run();
    db.close();
    expect(s.read()!.sessions).toHaveLength(0);
    // 窗口过后恢复读取
    now += 30_001;
    expect(s.read()!.sessions.map((x) => x.sessionId)).toEqual(["flaky"]);
    expect(s.health()).toBe("ok");
  });
});

describe("最终回复标记 finalReply（D40：末条是无 tool_calls 的 PLANNER_RESPONSE）", () => {
  const user = (idx: number) => ({ step_index: idx, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE" });
  const planner = (idx: number, extra: Record<string, unknown> = {}) => ({ step_index: idx, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", ...extra });
  const tool = (idx: number) => ({ step_index: idx, source: "MODEL", type: "RUN_COMMAND", status: "DONE" });

  function writeTranscript(id: string, records: object[]): string {
    const logs = join(home, "brain", id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const p = join(logs, "transcript.jsonl");
    writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n"));
    return p;
  }
  const finalReplyOf = (id: string) => source().read()!.sessions.find((s) => s.sessionId === id)?.finalReply;

  test.each<[string, object[], true | undefined]>([
    ["典型回合收尾：工具步骤之后的最终回复", [user(1), planner(2, { tool_calls: [{}] }), tool(3), planner(4)], true],
    ["tool_calls 为空数组也算最终回复", [user(1), planner(2, { tool_calls: [] })], true],
    ["tool_calls 为 null 也算最终回复", [user(1), planner(2, { tool_calls: null })], true],
    ["末条回复带 tool_calls：后面必有工具步骤，不是最终回复", [user(1), planner(2, { tool_calls: [{}] })], undefined],
    ["末条是工具步骤", [user(1), planner(2, { tool_calls: [{}] }), tool(3)], undefined],
    ["末条是用户输入（新一轮刚开始）", [user(1), planner(2), user(3)], undefined],
    ["tool_calls 形状异常 → 保守当作还没结束", [user(1), planner(2, { tool_calls: "x" })], undefined],
    ["末条回复未完成（RUNNING）", [user(1), planner(2, { status: "RUNNING" })], undefined],
    ["旧格式 source=assistant 不走快速通道", [user(1), { step_index: 2, source: "assistant", status: "DONE" }], undefined],
  ])("%s", (_name, records, expected) => {
    const id = "final-reply-case";
    writeTranscript(id, records);
    expect(finalReplyOf(id)).toBe(expected);
  });

  test("DB 滞后、transcript 领先时，finalReply 随 transcript 观测传递", () => {
    const id = "lag-final";
    const dbPath = makeDb(`${id}.db`, [[0, 14, 3, null], [1, 15, 3, null]]);
    const transcriptPath = writeTranscript(id, [user(0), planner(1, { tool_calls: [{}] }), tool(2), planner(3)]);
    utimesSync(dbPath, (now - 10_000) / 1000, (now - 10_000) / 1000);
    utimesSync(transcriptPath, (now - 1_000) / 1000, (now - 1_000) / 1000);
    expect(finalReplyOf(id)).toBe(true);
  });

  test("DB 追上同一条终态后仍保留 finalReply，并使用较早的 transcript 时间", () => {
    const id = "caught-up-final";
    const dbPath = makeDb(`${id}.db`, [[0, 14, 3, null], [1, 15, 3, null]]);
    const transcriptPath = writeTranscript(id, [user(0), planner(1)]);
    const repliedAt = (now - 10_000) / 1000;
    utimesSync(transcriptPath, repliedAt, repliedAt);
    utimesSync(dbPath, (now - 1_000) / 1000, (now - 1_000) / 1000);
    const session = source().read()!.sessions.find((s) => s.sessionId === id)!;
    expect(session.finalReply).toBe(true);
    expect(session.mtime).toBeCloseTo(repliedAt * 1000, 0);
  });

  test("DB 步骤领先于 transcript 时不继承 finalReply", () => {
    const id = "db-ahead";
    const dbPath = makeDb(`${id}.db`, [[0, 14, 3, null], [1, 15, 3, null], [2, 15, 3, null]]);
    const transcriptPath = writeTranscript(id, [user(0), planner(1)]);
    utimesSync(dbPath, (now - 10_000) / 1000, (now - 10_000) / 1000);
    utimesSync(transcriptPath, (now - 1_000) / 1000, (now - 1_000) / 1000);
    expect(finalReplyOf(id)).toBeUndefined();
  });
});
