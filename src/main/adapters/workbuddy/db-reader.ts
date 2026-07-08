// WorkBuddy 本地会话读取器。
// 双数据源合并：
// 1. ~/.workbuddy/workbuddy.db sessions 表（SQLite）— 用户创建的会话，有 status/title
// 2. ~/.workbuddy/sessions/*.json 心跳文件 — 运行中实例的 pid/heartbeat/sessionId
// 心跳文件中的 sessionId 与 DB sessions.id 对应；心跳活跃 = 会话在运行。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastAssistantText } from "../../state/trailing-question";

export type WorkbuddyStatus = "running" | "waiting" | "completed" | "stopped" | "error" | "unknown";

export interface WorkbuddySession {
  sessionId: string;
  status: WorkbuddyStatus;
  updatedAt: number;
  title: string | null;
  customTitle: string | null;
  cwd: string | null;
}

export interface WorkbuddySnapshot {
  sessions: WorkbuddySession[];
}

export type WorkbuddyHealth = "not_detected" | "ok" | "degraded";

export function defaultWorkbuddyHome(): string | null {
  const home = os.homedir();
  const p = path.join(home, ".workbuddy");
  return fs.existsSync(p) ? p : null;
}

const STATUS_MAP: Record<string, WorkbuddyStatus> = {
  pending: "waiting",
  planning: "running",
  working: "running",
  running: "running",
  in_progress: "running",
  active: "running",
  thinking: "running",
  generating: "running",
  streaming: "running",
  waiting: "waiting",
  user_input: "waiting",
  paused: "waiting",
  completed: "completed",
  done: "completed",
  finished: "completed",
  stopped: "stopped",
  cancelled: "stopped",
  canceled: "stopped",
  error: "error",
  failed: "error",
};

export function normalizeWorkbuddyStatus(raw: string): WorkbuddyStatus {
  return STATUS_MAP[raw.toLowerCase()] ?? "unknown";
}

export function workbuddySafeName(sessionId: string): string {
  return `WorkBuddy · ${sessionId.slice(0, 8)}`;
}

const REOPEN_RETRY_MS = 30_000;
// 心跳超过 60 秒没更新 = 进程已死
const HEARTBEAT_STALE_MS = 60_000;

interface HeartbeatFile {
  pid: number;
  lastHeartbeat: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  updatedAt: number;
}

export class WorkbuddySnapshotReader {
  private readonly wbHome: string | null;
  private db: DatabaseSync | null = null;
  private lastHealth: WorkbuddyHealth = "not_detected";
  private nextRetryAt = 0;

  constructor(wbHome: string | null = defaultWorkbuddyHome()) {
    this.wbHome = wbHome;
  }

  health(): WorkbuddyHealth {
    return this.lastHealth;
  }

  read(): WorkbuddySnapshot | null {
    if (!this.wbHome) {
      this.lastHealth = "not_detected";
      return null;
    }

    const dbSessions = this.readDbSessions();
    const heartbeats = this.readHeartbeats();

    if (dbSessions === null && heartbeats.length === 0) {
      this.lastHealth = this.wbHome ? "ok" : "not_detected";
      return { sessions: [] };
    }

    const now = Date.now();
    const sessionMap = new Map<string, WorkbuddySession>();

    // DB sessions 为基准
    if (dbSessions) {
      for (const s of dbSessions) sessionMap.set(s.sessionId, s);
    }

    // 心跳文件不参与会话状态判定：
    // - 进程存活由 process-liveness.ts 检测（ps comm 特征匹配）
    // - 心跳 updatedAt 是进程活性时间戳，不等于用户交互——合并会让 poller 误判持续活动
    // - 无 DB 对应的心跳（如 interactive-<pid>）是 CLI 后台进程，不作为用户会话跟踪

    this.lastHealth = "ok";
    return { sessions: [...sessionMap.values()] };
  }

  private readDbSessions(): WorkbuddySession[] | null {
    const dbPath = this.wbHome ? path.join(this.wbHome, "workbuddy.db") : null;
    if (!dbPath || !fs.existsSync(dbPath)) return null;

    if (this.db === null) {
      if (this.lastHealth === "degraded" && Date.now() < this.nextRetryAt) return null;
      try {
        this.db = new DatabaseSync(dbPath, { readOnly: true });
      } catch {
        this.markDegraded();
        return null;
      }
    }
    try {
      const rows = this.db.prepare(
        "SELECT id, status, title, custom_title, updated_at, last_activity_at, cwd FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50"
      ).all() as Record<string, unknown>[];
      return this.parseRows(rows);
    } catch {
      this.markDegraded();
      return null;
    }
  }

  private readHeartbeats(): HeartbeatFile[] {
    const sessDir = this.wbHome ? path.join(this.wbHome, "sessions") : null;
    if (!sessDir || !fs.existsSync(sessDir)) return [];
    const out: HeartbeatFile[] = [];
    try {
      for (const f of fs.readdirSync(sessDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(sessDir, f), "utf-8"));
          if (typeof raw.sessionId === "string" && typeof raw.lastHeartbeat === "number") {
            out.push(raw as HeartbeatFile);
          }
        } catch {
          /* skip bad file */
        }
      }
    } catch {
      /* skip */
    }
    return out;
  }

  private parseRows(rows: Record<string, unknown>[]): WorkbuddySession[] {
    const out: WorkbuddySession[] = [];
    for (const r of rows) {
      const id = String(r.id ?? "");
      if (!id) continue;
      const rawStatus = String(r.status ?? "unknown");
      const updatedAt = typeof r.last_activity_at === "number" ? r.last_activity_at
        : typeof r.updated_at === "number" ? r.updated_at
        : 0;
      const customTitle = typeof r.custom_title === "string" && r.custom_title.trim() ? r.custom_title : null;
      const title = typeof r.title === "string" && r.title.trim() ? r.title : null;
      const cwd = typeof r.cwd === "string" && r.cwd.trim() ? r.cwd : null;
      out.push({
        sessionId: id,
        status: normalizeWorkbuddyStatus(rawStatus),
        updatedAt,
        title,
        customTitle,
        cwd,
      });
    }
    return out;
  }

  private markDegraded(): void {
    this.close();
    this.lastHealth = "degraded";
    this.nextRetryAt = Date.now() + REOPEN_RETRY_MS;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}

/** 读 WorkBuddy 对话文件尾部最后一条 assistant 消息文本（结尾提问判定用）。
 *  对话文件路径：~/.workbuddy/projects/<slug>/<sessionId>.jsonl
 *  slug = cwd 路径用 - 连接（去首 /）。有界读取：只读末尾 8KB，避免大文件全读。 */
export function readWorkbuddyTranscriptTail(wbHome: string, sessionId: string, cwd: string | null): string | null {
  if (!cwd) return null;
  const slug = cwd.replace(/^\//, "").replace(/\//g, "-");
  const file = path.join(wbHome, "projects", slug, `${sessionId}.jsonl`);
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const readSize = Math.min(stat.size, 8192);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString("utf-8");
    return lastAssistantText(tail);
  } catch {
    return null;
  }
}
