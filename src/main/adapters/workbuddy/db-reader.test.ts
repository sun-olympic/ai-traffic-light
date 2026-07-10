import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WorkbuddySnapshotReader } from "./db-reader";

const NOW = 1_783_578_600_000;

let dir: string;

function writeDb(rows: Array<{ id: string; status: string; updatedAt?: number; lastActivityAt?: number }>): void {
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT,
      cwd TEXT,
      title TEXT,
      custom_title TEXT,
      status TEXT,
      updated_at INTEGER,
      last_activity_at INTEGER,
      deleted_at INTEGER
    )
  `);
  const stmt = db.prepare(`
    INSERT INTO sessions (id, cwd, title, custom_title, status, updated_at, last_activity_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  for (const r of rows) {
    stmt.run(r.id, "/tmp/project", null, null, r.status, r.updatedAt ?? NOW - 120_000, r.lastActivityAt ?? r.updatedAt ?? NOW - 120_000);
  }
  db.close();
}

function writeHeartbeat(sessionId: string, lastHeartbeat: number, startedAt = NOW - 10_000): void {
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({
    pid: 1234,
    lastHeartbeat,
    sessionId,
    cwd: "/tmp/project",
    startedAt,
    kind: "interactive",
    updatedAt: lastHeartbeat,
  }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-reader-"));
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("WorkbuddySnapshotReader", () => {
  test("active heartbeat upgrades a warm completed DB session to running", () => {
    writeDb([{ id: "s1", status: "completed" }]);
    writeHeartbeat("s1", NOW - 1000);

    const snap = new WorkbuddySnapshotReader(dir).read();

    expect(snap?.sessions).toEqual([
      expect.objectContaining({ sessionId: "s1", status: "running" }),
    ]);
  });

  test("waiting DB status stays waiting even when heartbeat is active", () => {
    writeDb([{ id: "s1", status: "pending" }]);
    writeHeartbeat("s1", NOW - 1000);

    const snap = new WorkbuddySnapshotReader(dir).read();

    expect(snap?.sessions[0]).toMatchObject({ sessionId: "s1", status: "waiting" });
  });

  test("stale heartbeat does not upgrade a completed DB session", () => {
    writeDb([{ id: "s1", status: "completed" }]);
    writeHeartbeat("s1", NOW - 120_000);

    const snap = new WorkbuddySnapshotReader(dir).read();

    expect(snap?.sessions[0]).toMatchObject({ sessionId: "s1", status: "completed" });
  });

  test("active heartbeat older than the DB completion does not keep an ended session running", () => {
    writeDb([{ id: "s1", status: "completed", updatedAt: NOW - 5_000 }]);
    writeHeartbeat("s1", NOW - 1_000, NOW - 30_000);

    const snap = new WorkbuddySnapshotReader(dir).read();

    expect(snap?.sessions[0]).toMatchObject({ sessionId: "s1", status: "completed" });
  });
});
