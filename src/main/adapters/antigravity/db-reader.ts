// Antigravity 会话库锁安全只读读取（add-antigravity-support D12/D34/D35）。
// 单一职责：打开一个候选库、校验最小 schema、读出 steps 结构行；不做状态解释、不做轮询编排。
// DatabaseSync 是同步 API，天然满足"一次只读一个库"（D12 串行要求）。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ReadFailure = "unreadable" | "schema_mismatch" | "permission_denied";

/** steps 表结构行；只取状态推导必需的结构字段，step_payload 等内容字段绝不读（D21 隐私边界） */
export interface StepRow {
  idx: number;
  stepType: number;
  status: number;
  errorDetails: string | null;
}

export type DbReadResult = { ok: true; rows: StepRow[] } | { ok: false; reason: ReadFailure };

/** 最小 schema 指纹（D34）：缺任一必需列 → schema_mismatch（fail closed，未知新增列不影响） */
const REQUIRED_COLUMNS = ["idx", "step_type", "status", "error_details"] as const;

function isPermissionError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * 无 WAL：优先 immutable 只读（实测只读目录权限下唯一可行的直接打开方式，D12），
 * 失败回退普通只读。有 WAL：immutable 会漏最新 WAL 状态（D12），必须走快照副本。
 */
function openDb(cand: { dbPath: string; hasWal: boolean }): { db: DatabaseSync; cleanup: () => void } | null {
  if (!cand.hasWal) {
    try {
      return { db: new DatabaseSync(`file:${cand.dbPath}?mode=ro&immutable=1`, { readOnly: true }), cleanup: () => {} };
    } catch {
      /* URI 不支持或打开失败 → 回退 */
    }
    try {
      return { db: new DatabaseSync(cand.dbPath, { readOnly: true }), cleanup: () => {} };
    } catch {
      return null;
    }
  }
  return openSnapshotCopy(cand.dbPath);
}

/** 有界快照副本（D12）：db+wal+shm 拷入私有临时目录后打开副本；副本归我们所有，可写打开让 SQLite 完成 WAL 恢复 */
function openSnapshotCopy(dbPath: string): { db: DatabaseSync; cleanup: () => void } | null {
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-agy-snap-"));
  } catch {
    return null;
  }
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const copy = path.join(tmp, "snapshot.db");
    fs.copyFileSync(dbPath, copy);
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${ext}`)) fs.copyFileSync(`${dbPath}${ext}`, `${copy}${ext}`);
    }
    return { db: new DatabaseSync(copy), cleanup };
  } catch {
    cleanup();
    return null;
  }
}

/** 读取一个候选库的 steps 结构行（按 idx 升序）；失败按原因分类，绝不抛异常 */
export function readSteps(cand: { dbPath: string; hasWal: boolean }): DbReadResult {
  try {
    fs.accessSync(cand.dbPath, fs.constants.R_OK);
  } catch (e) {
    return { ok: false, reason: isPermissionError(e) ? "permission_denied" : "unreadable" };
  }
  const opened = openDb(cand);
  if (opened === null) return { ok: false, reason: "unreadable" };
  const { db, cleanup } = opened;
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('steps')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (cols.length === 0 || REQUIRED_COLUMNS.some((c) => !names.has(c))) {
      return { ok: false, reason: "schema_mismatch" };
    }
    const raw = db.prepare("SELECT idx, step_type, status, error_details FROM steps ORDER BY idx").all() as Array<Record<string, unknown>>;
    const rows: StepRow[] = raw.map((r) => ({
      idx: Number(r.idx),
      stepType: Number(r.step_type),
      status: Number(r.status),
      errorDetails: typeof r.error_details === "string" ? r.error_details : null,
    }));
    return { ok: true, rows };
  } catch {
    // 打开成功但查询失败：损坏/非 sqlite/锁竞争 → unreadable（调用方降级保状态，D12）
    return { ok: false, reason: "unreadable" };
  } finally {
    try {
      db.close();
    } catch {
      /* 关闭失败无需处理 */
    }
    cleanup();
  }
}
