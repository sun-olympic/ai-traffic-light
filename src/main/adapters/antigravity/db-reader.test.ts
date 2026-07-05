import { beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSteps } from "./db-reader";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-agy-db-"));
});

// 全合成 fixture：结构字段 only，无真实 prompt/工具参数/代码内容（spec：Fixtures are sanitized）
function makeDb(name: string, opts?: { wal?: boolean; rows?: Array<[number, number, number, string | null]>; noTable?: boolean; missingColumn?: boolean }): string {
  const p = join(dir, name);
  const db = new DatabaseSync(p);
  if (opts?.wal) db.exec("PRAGMA journal_mode=WAL");
  if (!opts?.noTable) {
    db.exec(
      opts?.missingColumn
        ? "CREATE TABLE steps (idx INTEGER, step_type INTEGER)"
        : "CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, error_details TEXT, step_payload BLOB)",
    );
    for (const [idx, stepType, status, err] of opts?.rows ?? []) {
      db.prepare("INSERT INTO steps (idx, step_type, status, error_details) VALUES (?, ?, ?, ?)").run(idx, stepType, status, err);
    }
  }
  if (!opts?.wal) db.close(); // WAL 库保持连接打开，让 -wal 文件存续（模拟 Antigravity 正在写）
  return p;
}

function candidate(dbPath: string): { dbPath: string; hasWal: boolean } {
  return { dbPath, hasWal: existsSync(`${dbPath}-wal`) };
}

describe("readSteps（D12 锁安全只读访问）", () => {
  test("无 WAL 的库：读出结构行（按 idx 升序）", () => {
    const p = makeDb("s1.db", { rows: [[1, 14, 3, null], [0, 101, 3, null], [2, 5, 2, null]] });
    const r = readSteps(candidate(p));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toEqual([
        { idx: 0, stepType: 101, status: 3, errorDetails: null },
        { idx: 1, stepType: 14, status: 3, errorDetails: null },
        { idx: 2, stepType: 5, status: 2, errorDetails: null },
      ]);
    }
  });

  test("WAL 库（sidecar 存在，写连接未关）：快照副本路径仍读出最新行", () => {
    const p = makeDb("s2.db", { wal: true, rows: [[0, 14, 3, null], [1, 5, 8, null]] });
    expect(existsSync(`${p}-wal`)).toBe(true);
    const r = readSteps(candidate(p));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows.map((x) => x.status)).toEqual([3, 8]);
  });

  test("steps 表缺失 → schema_mismatch", () => {
    const p = makeDb("s3.db", { noTable: true });
    const r = readSteps(candidate(p));
    expect(r).toEqual({ ok: false, reason: "schema_mismatch" });
  });

  test("必需列缺失 → schema_mismatch", () => {
    const p = makeDb("s4.db", { missingColumn: true });
    const r = readSteps(candidate(p));
    expect(r).toEqual({ ok: false, reason: "schema_mismatch" });
  });

  test("非 sqlite 文件 → unreadable", () => {
    const p = join(dir, "junk.db");
    writeFileSync(p, "not-a-database");
    expect(readSteps(candidate(p))).toEqual({ ok: false, reason: "unreadable" });
  });

  // Windows 无 POSIX 权限位，chmod 000 不生效
  test.skipIf(process.platform === "win32")("权限拒绝 → permission_denied", () => {
    const p = makeDb("s5.db", { rows: [[0, 14, 3, null]] });
    chmodSync(p, 0o000);
    try {
      expect(readSteps(candidate(p))).toEqual({ ok: false, reason: "permission_denied" });
    } finally {
      chmodSync(p, 0o600);
    }
  });

  test("文件不存在 → unreadable", () => {
    expect(readSteps(candidate(join(dir, "gone.db")))).toEqual({ ok: false, reason: "unreadable" });
  });
});
