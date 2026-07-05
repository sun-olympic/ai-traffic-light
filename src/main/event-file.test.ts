import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventFileWatcher, rotateIfNeeded, ensureSecureDir } from "./event-file";
import type { TrafficEvent } from "../shared/events";

let home: string;
let watcher: EventFileWatcher | null = null;

function line(sessionId: string, event: string, ts = Date.now()): string {
  return JSON.stringify({ v: 1, tool: "cursor", sessionId, event, ts, meta: {} }) + "\n";
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tl-ev-"));
});

afterEach(async () => {
  await watcher?.stop();
  watcher = null;
});

async function collect(count: number, timeoutMs = 3000): Promise<TrafficEvent[]> {
  const got: TrafficEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout, got ${got.length}/${count}`)), timeoutMs);
    watcher = new EventFileWatcher(home, (ev) => {
      got.push(ev);
      if (got.length >= count) {
        clearTimeout(timer);
        resolve(got);
      }
    });
    void watcher.start();
  });
}

describe("EventFileWatcher", () => {
  test("已有历史事件在 start 时回放", async () => {
    writeFileSync(join(home, "events.jsonl"), line("s1", "prompt") + line("s1", "stop"));
    const evs = await collect(2);
    expect(evs.map((e) => e.event)).toEqual(["prompt", "stop"]);
  });

  test("追加写入被增量读出（不重复回放旧行）", async () => {
    writeFileSync(join(home, "events.jsonl"), line("s1", "prompt"));
    const all: TrafficEvent[] = [];
    watcher = new EventFileWatcher(home, (ev) => all.push(ev));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 300));
    appendFileSync(join(home, "events.jsonl"), line("s2", "session_start"));
    await vi.waitFor(() => expect(all).toHaveLength(2), { timeout: 3000 });
    expect(all[1].sessionId).toBe("s2");
  });

  test("坏行被跳过，后续行照常解析", async () => {
    writeFileSync(join(home, "events.jsonl"), "garbage-not-json\n" + line("s1", "prompt"));
    const evs = await collect(1);
    expect(evs[0].sessionId).toBe("s1");
  });

  test("onEvent 抛错不中断同批后续行，也不打断后续增量读", async () => {
    writeFileSync(join(home, "events.jsonl"), line("bad", "prompt") + line("s1", "prompt"));
    const got: string[] = [];
    watcher = new EventFileWatcher(home, (ev) => {
      if (ev.sessionId === "bad") throw new Error("handler boom");
      got.push(ev.sessionId);
    });
    await watcher.start();
    await vi.waitFor(() => expect(got).toEqual(["s1"]), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 300)); // 等 chokidar 就绪（与既有增量读测试一致）
    appendFileSync(join(home, "events.jsonl"), line("s2", "session_start"));
    await vi.waitFor(() => expect(got).toEqual(["s1", "s2"]), { timeout: 3000 });
  });

  test("poll() 轮询兜底：不依赖 fs 事件也能读到增量", async () => {
    writeFileSync(join(home, "events.jsonl"), line("s1", "prompt"));
    const got: string[] = [];
    // 不调 start()：模拟 fsevents 完全失效，仅靠周期 poll 补读
    watcher = new EventFileWatcher(home, (ev) => got.push(ev.sessionId));
    watcher.poll();
    await vi.waitFor(() => expect(got).toEqual(["s1"]), { timeout: 3000 });
    appendFileSync(join(home, "events.jsonl"), line("s2", "session_start"));
    watcher.poll();
    await vi.waitFor(() => expect(got).toEqual(["s1", "s2"]), { timeout: 3000 });
  });

  test("记录最后事件时间（通道健康度）", async () => {
    const ts = Date.now() - 1000;
    writeFileSync(join(home, "events.jsonl"), line("s1", "prompt", ts));
    await collect(1);
    expect(watcher!.lastEventAt()).toBe(ts);
  });
});

describe("rotateIfNeeded", () => {
  test("小于上限不轮转", () => {
    const f = join(home, "events.jsonl");
    writeFileSync(f, line("s1", "prompt"));
    rotateIfNeeded(home, 10 * 1024 * 1024, 2);
    expect(readdirSync(home)).toEqual(["events.jsonl"]);
  });

  test("超限时归档并只保留最近 2 个归档", () => {
    const f = join(home, "events.jsonl");
    for (let round = 0; round < 3; round++) {
      writeFileSync(f, line("s1", "prompt").repeat(50));
      rotateIfNeeded(home, 100, 2);
    }
    const files = readdirSync(home).filter((x) => x.startsWith("events") && x !== "events.jsonl");
    expect(files.length).toBe(2);
    expect(existsSync(f)).toBe(false);
  });
});

describe("ensureSecureDir", () => {
  // Windows 无 POSIX 权限位，mode 断言不成立
  test.skipIf(process.platform === "win32")("目录 700、事件文件 600", () => {
    ensureSecureDir(home);
    const f = join(home, "events.jsonl");
    appendFileSync(f, line("s1", "prompt"), { mode: 0o600 });
    ensureSecureDir(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});
