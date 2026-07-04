import { beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("schema 不匹配 → schema_mismatch（保守失败，D34）", () => {
    const p = join(home, "conversations", "odd.db");
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE steps (idx INTEGER)"); // 缺必需列
    db.close();
    const s = source();
    s.read();
    expect(s.health()).toBe("schema_mismatch");
  });

  test("权限拒绝 → permission_denied（健康态而非无会话，D24）", () => {
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
