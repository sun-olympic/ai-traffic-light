import { beforeEach, describe, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorDbReader } from "./db-reader";

let dbPath: string;

function seed(rows: Array<{ key: string; value: unknown }>): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  const ins = db.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const r of rows) ins.run(r.key, JSON.stringify(r.value));
  db.close();
}

function bubble(conv: string, id: string, tfd: Record<string, unknown> | null) {
  return { key: `bubbleId:${conv}:${id}`, value: tfd ? { toolFormerData: tfd } : { text: "普通消息" } };
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "tl-db-")), "state.vscdb");
});

describe("CursorDbReader", () => {
  test("读取最新 N 条气泡（rowid 倒序）", () => {
    seed([
      bubble("c1", "b1", { name: "run_terminal_command_v2", status: "completed" }),
      bubble("c1", "b2", { name: "ask_question", status: "loading" }),
      bubble("c2", "x1", { name: "ask_question", status: "loading" }),
    ]);
    const reader = new CursorDbReader(dbPath);
    const rows = reader.latestBubbles("c1", 5);
    expect(rows).toHaveLength(2);
    expect(rows[0].toolName).toBe("ask_question");
    expect(rows[1].toolName).toBe("run_terminal_command_v2");
    reader.close();
  });

  test("挂起判定字段透出：additionalData.status / blockReason / reviewData.status", () => {
    seed([
      bubble("c1", "b1", {
        name: "run_terminal_command_v2",
        status: "loading",
        additionalData: { status: "pending", blockReason: "Not in allowlist: sudo", reviewData: { status: "Requested" } },
      }),
    ]);
    const reader = new CursorDbReader(dbPath);
    const [row] = reader.latestBubbles("c1", 1);
    expect(row.additionalStatus).toBe("pending");
    expect(row.blockReason).toContain("sudo");
    expect(row.reviewStatus).toBe("Requested");
    reader.close();
  });

  test("result 字段只对 ask_question 提取（其他工具恒 null，避免大输出进 JS）", () => {
    seed([
      bubble("c1", "b1", { name: "run_terminal_command_v2", status: "completed", result: '{"output":"大段命令输出"}' }),
      bubble("c1", "b2", { name: "ask_question", status: "completed", userDecision: "accepted", result: '{"answers":[{"questionId":"q","selectedOptionIds":["__freeform_other__"]}]}' }),
    ]);
    const reader = new CursorDbReader(dbPath);
    const rows = reader.latestBubbles("c1", 2);
    expect(rows[0].result).toContain("__freeform_other__");
    expect(rows[1].result).toBeNull();
    reader.close();
  });

  test("无 toolFormerData 的普通气泡 toolName 为 null", () => {
    seed([bubble("c1", "b1", null)]);
    const reader = new CursorDbReader(dbPath);
    expect(reader.latestBubbles("c1", 1)[0].toolName).toBeNull();
    reader.close();
  });

  test("会话无气泡返回空数组（CLI 会话兜底）", () => {
    seed([]);
    const reader = new CursorDbReader(dbPath);
    expect(reader.latestBubbles("nope", 5)).toEqual([]);
    reader.close();
  });

  test("composerData 元数据读取", () => {
    seed([{ key: "composerData:c1", value: { name: "修复登录 bug", createdAt: 1783000000000, status: "completed" } }]);
    const reader = new CursorDbReader(dbPath);
    expect(reader.sessionMetadata("c1")).toEqual({ name: "修复登录 bug", createdAt: 1783000000000 });
    reader.close();
  });

  test("composerData 缺失返回 null", () => {
    seed([]);
    const reader = new CursorDbReader(dbPath);
    expect(reader.sessionMetadata("c1")).toBeNull();
    reader.close();
  });

  test("DB 文件不存在：isAvailable=false，查询返回降级信号而非抛异常", () => {
    const reader = new CursorDbReader(join(tmpdir(), "definitely-missing", "state.vscdb"));
    expect(reader.isAvailable()).toBe(false);
    expect(reader.latestBubbles("c1", 5)).toEqual([]);
    expect(reader.sessionMetadata("c1")).toBeNull();
  });

  test("表结构不符（schema 变更）：标记不可用，不抛未捕获异常", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE somethingElse (id INTEGER)");
    db.close();
    const reader = new CursorDbReader(dbPath);
    expect(reader.latestBubbles("c1", 5)).toEqual([]);
    expect(reader.isAvailable()).toBe(false);
    reader.close();
  });

  test("DB 后建自动恢复：不可用 → 重试窗口后库出现 → 恢复可用（无需重启）", () => {
    const lateDir = mkdtempSync(join(tmpdir(), "tl-late-"));
    const latePath = join(lateDir, "state.vscdb");
    const reader = new CursorDbReader(latePath);
    expect(reader.isAvailable()).toBe(false);
    // 库出现（模拟用户后启动 Cursor）
    const db = new DatabaseSync(latePath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.close();
    expect(reader.isAvailable()).toBe(false); // 重试窗口未到，仍降级
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    expect(reader.isAvailable()).toBe(true); // 窗口到达后自动重开
    vi.restoreAllMocks();
    reader.close();
  });

  test("recentSessions：按 lastUpdatedAt 倒序取最近 N 条会话（冷启动兜底）", () => {
    seed([
      { key: "composerData:old", value: { name: "旧会话", createdAt: 1, lastUpdatedAt: 1000 } },
      { key: "composerData:new", value: { name: "新会话", createdAt: 2, lastUpdatedAt: 9000 } },
      { key: "composerData:mid", value: { name: "中会话", createdAt: 3, lastUpdatedAt: 5000 } },
    ]);
    const reader = new CursorDbReader(dbPath);
    const rows = reader.recentSessions(2);
    expect(rows.map((r) => r.sessionId)).toEqual(["new", "mid"]);
    expect(rows[0].name).toBe("新会话");
    reader.close();
  });

  test("recentSessions：DB 不可用返回空数组", () => {
    const reader = new CursorDbReader(join(tmpdir(), "missing2", "state.vscdb"));
    expect(reader.recentSessions(5)).toEqual([]);
  });

  test("composerHeader：从 ItemTable 大 JSON 中按 composerId 提取 blocking 与 checkpointAt", () => {
    seed([]); // 建 cursorDiskKV 保证库文件存在
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "composer.composerHeaders",
      JSON.stringify({
        allComposers: [
          { composerId: "c1", hasBlockingPendingActions: true, conversationCheckpointLastUpdatedAt: 123 },
          { composerId: "c2", hasBlockingPendingActions: false, conversationCheckpointLastUpdatedAt: 456 },
        ],
      }),
    );
    db.close();
    const reader = new CursorDbReader(dbPath);
    expect(reader.composerHeader("c1")).toEqual({ blocking: true, checkpointAt: 123 });
    expect(reader.composerHeader("c2")).toEqual({ blocking: false, checkpointAt: 456 });
    expect(reader.composerHeader("nope")).toBeNull();
    reader.close();
  });

  test("composerHeader：ItemTable 缺失时返回 null 且不降级气泡通路", () => {
    seed([bubble("c1", "b1", { name: "ask_question", status: "loading" })]);
    const reader = new CursorDbReader(dbPath);
    expect(reader.composerHeader("c1")).toBeNull();
    expect(reader.latestBubbles("c1", 1)).toHaveLength(1); // 气泡通路不受影响
    expect(reader.isAvailable()).toBe(true);
    reader.close();
  });

  test("以只读模式打开（写入抛错）", () => {
    seed([bubble("c1", "b1", { name: "ask_question", status: "loading" })]);
    const reader = new CursorDbReader(dbPath);
    reader.latestBubbles("c1", 1);
    expect(() => reader.rawHandleForTest()!.exec("DELETE FROM cursorDiskKV")).toThrow();
    reader.close();
  });
});
