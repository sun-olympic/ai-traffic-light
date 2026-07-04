import { beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { defaultAntigravityHome, discoverCandidates } from "./store-locator";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-agy-"));
});

function makeDb(name: string, mtimeSec: number): string {
  const p = join(dir, "conversations", name);
  writeFileSync(p, "synthetic");
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe("defaultAntigravityHome（D23/D33 平台与路径覆盖）", () => {
  test("环境变量覆盖优先（任何平台）", () => {
    expect(defaultAntigravityHome("linux", { TL_ANTIGRAVITY_HOME: "/custom/agy" })).toBe("/custom/agy");
  });
  test("macOS 默认 ~/.gemini/antigravity", () => {
    expect(defaultAntigravityHome("darwin", {})).toBe(join(homedir(), ".gemini/antigravity"));
  });
  test("非 macOS 无覆盖 → null（not detected）", () => {
    expect(defaultAntigravityHome("linux", {})).toBeNull();
    expect(defaultAntigravityHome("win32", {})).toBeNull();
  });
});

describe("discoverCandidates（D22/D35 有界发现）", () => {
  test("conversations 目录缺失 → 空数组", () => {
    expect(discoverCandidates(dir)).toEqual([]);
    expect(discoverCandidates(join(dir, "nope"))).toEqual([]);
  });

  test("只挑常规 .db 文件；.pb/目录/符号链接忽略；sessionId 取文件名", () => {
    mkdirSync(join(dir, "conversations"), { recursive: true });
    makeDb("session-aaa.db", 1000);
    writeFileSync(join(dir, "conversations", "old-history.pb"), "x");
    mkdirSync(join(dir, "conversations", "some-dir.db"));
    symlinkSync(join(dir, "conversations", "session-aaa.db"), join(dir, "conversations", "link.db"));
    const cands = discoverCandidates(dir);
    expect(cands).toHaveLength(1);
    expect(cands[0].sessionId).toBe("session-aaa");
    expect(cands[0].dbPath).toBe(join(dir, "conversations", "session-aaa.db"));
    expect(cands[0].ino).toBeGreaterThan(0);
  });

  test("mtime 取 db/-wal/-shm 最大值；hasWal 反映 sidecar 存在", () => {
    mkdirSync(join(dir, "conversations"), { recursive: true });
    makeDb("s1.db", 1000);
    const wal = join(dir, "conversations", "s1.db-wal");
    writeFileSync(wal, "");
    utimesSync(wal, 2000, 2000);
    const [c] = discoverCandidates(dir);
    expect(c.hasWal).toBe(true);
    expect(c.mtime).toBe(2000_000);
  });

  test("无 sidecar 时 hasWal=false", () => {
    mkdirSync(join(dir, "conversations"), { recursive: true });
    makeDb("s1.db", 1000);
    expect(discoverCandidates(dir)[0].hasWal).toBe(false);
  });

  test("按 mtime 降序并按 cap 截断", () => {
    mkdirSync(join(dir, "conversations"), { recursive: true });
    makeDb("s-old.db", 1000);
    makeDb("s-new.db", 3000);
    makeDb("s-mid.db", 2000);
    const all = discoverCandidates(dir);
    expect(all.map((c) => c.sessionId)).toEqual(["s-new", "s-mid", "s-old"]);
    expect(discoverCandidates(dir, 2).map((c) => c.sessionId)).toEqual(["s-new", "s-mid"]);
  });
});
