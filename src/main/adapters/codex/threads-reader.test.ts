import { beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundGraceFilter, CodexThreadsReader, latestStateDb } from "./threads-reader";

let codexDir: string;

beforeEach(() => {
  codexDir = mkdtempSync(join(tmpdir(), "tl-codex-"));
});

function makeDb(name = "state_5.sqlite"): string {
  const p = join(codexDir, name);
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
    source TEXT, cwd TEXT, title TEXT, archived INTEGER DEFAULT 0, preview TEXT
  )`);
  db.exec(`INSERT INTO threads (id, rollout_path, created_at_ms, title, archived, preview, source)
    VALUES ('th-1', '/x/rollout-th-1.jsonl', 1783120000000, '修复登录 bug', 0, '修复登录 bug', 'cli'),
           ('th-arch', '/x/r2.jsonl', 1783120000000, '旧会话', 1, '旧会话', 'cli'),
           ('th-bg', '/x/r3.jsonl', 1783120000000, '', 0, '', 'cli')`);
  db.close();
  return p;
}

describe("latestStateDb（版本漂移）", () => {
  test("多版本并存取版本号最大（数值比较：state_10 > state_5）", () => {
    makeDb("state_5.sqlite");
    makeDb("state_10.sqlite");
    expect(latestStateDb(codexDir)).toBe(join(codexDir, "state_10.sqlite"));
  });

  test("无状态库 → null", () => {
    expect(latestStateDb(codexDir)).toBeNull();
  });
});

describe("CodexThreadsReader", () => {
  test("按主键查元数据：title/createdAt/archived/rolloutPath", () => {
    makeDb();
    const r = new CodexThreadsReader(codexDir);
    expect(r.metadata("th-1")).toEqual({ name: "修复登录 bug", createdAt: 1783120000000, archived: false, rolloutPath: "/x/rollout-th-1.jsonl" });
    expect(r.metadata("th-arch")?.archived).toBe(true);
  });

  test("id 缺席 → null（显示回退 sessionId 前 8 位由 UI 层做）", () => {
    makeDb();
    expect(new CodexThreadsReader(codexDir).metadata("th-404")).toBeNull();
  });

  test("session_index.jsonl 的 AI 短标题优先于 threads.title；同 id 多行取最后；无索引回落 title", () => {
    makeDb();
    writeFileSync(
      join(codexDir, "session_index.jsonl"),
      [
        JSON.stringify({ id: "th-1", thread_name: "旧短标题", updated_at: "2026-07-04T01:00:00Z" }),
        JSON.stringify({ id: "th-1", thread_name: "登录 bug 修复", updated_at: "2026-07-04T02:00:00Z" }),
        "bad-json{",
      ].join("\n"),
    );
    const r = new CodexThreadsReader(codexDir);
    expect(r.metadata("th-1")?.name).toBe("登录 bug 修复");
    expect(r.metadata("th-arch")?.name).toBe("旧会话"); // 索引无此 id → 回落 threads.title
  });

  test("threadKnown：存在且 preview 非空 → true；preview 空/缺席 → false；库不可用 → null", () => {
    makeDb();
    const r = new CodexThreadsReader(codexDir);
    expect(r.threadKnown("th-1")).toBe(true);
    expect(r.threadKnown("th-bg")).toBe(false);
    expect(r.threadKnown("th-404")).toBe(false);
    const empty = new CodexThreadsReader(mkdtempSync(join(tmpdir(), "tl-empty-")));
    expect(empty.threadKnown("th-1")).toBeNull();
  });

  test("heartbeatIds：global-state 键存在取集合，缺失（本机实况）空集", () => {
    const r1 = new CodexThreadsReader(codexDir);
    expect(r1.heartbeatIds().size).toBe(0);
    writeFileSync(join(codexDir, ".codex-global-state.json"), JSON.stringify({ "heartbeat-thread-permissions-by-id": { "th-hb": {} } }));
    const r2 = new CodexThreadsReader(codexDir);
    expect(r2.heartbeatIds().has("th-hb")).toBe(true);
  });
});

describe("BackgroundGraceFilter（宽限期确认）", () => {
  let now: number;
  let known: Record<string, boolean | null>;
  let hb: Set<string>;

  const makeFilter = () =>
    new BackgroundGraceFilter({
      graceMs: 60_000,
      clock: () => now,
      heartbeatIds: () => hb,
      threadKnown: (id) => (id in known ? known[id] : false),
    });

  beforeEach(() => {
    now = 1_783_120_000_000;
    known = {};
    hb = new Set();
  });

  test("heartbeat 命中 → 首事件立即过滤", () => {
    hb.add("th-hb");
    expect(makeFilter().onFirstEvent("th-hb")).toBe("filter");
  });

  test("threads 表已知 → 直接转正，不进宽限期", () => {
    known["th-1"] = true;
    const f = makeFilter();
    expect(f.onFirstEvent("th-1")).toBe("track");
    now += 120_000;
    expect(f.sweep()).toEqual([]);
  });

  test("race 场景：首事件时缺席但宽限期内出现 → 转正无中断", () => {
    const f = makeFilter();
    expect(f.onFirstEvent("th-new")).toBe("track"); // 先展示
    now += 20_000;
    known["th-new"] = true; // threads 表插入了
    expect(f.sweep()).toEqual([]);
    now += 120_000;
    expect(f.sweep()).toEqual([]); // 已转正，不再复查
  });

  test("宽限期期满仍缺席 → 定罪过滤", () => {
    const f = makeFilter();
    f.onFirstEvent("th-ghost");
    now += 30_000;
    expect(f.sweep()).toEqual([]); // 未期满
    now += 31_000;
    expect(f.sweep()).toEqual(["th-ghost"]);
    expect(f.sweep()).toEqual([]); // 定罪一次后移除
  });

  test("库不可用（null）→ 证据不足不定罪，宽限期顺延", () => {
    known["th-x"] = null;
    const f = makeFilter();
    f.onFirstEvent("th-x");
    now += 120_000;
    expect(f.sweep()).toEqual([]);
  });
});
