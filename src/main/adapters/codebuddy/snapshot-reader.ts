// CodeBuddy CN 本地会话快照读取器（VS Code 派生）。
// 主数据源：codebuddy-sessions.vscdb（ItemTable，key=session:<id>，value=JSON）
// 提供精确的 status（Completed/Active/Pending 等）和 updatedAt 时间戳。
// 回退数据源：message-queue/*.json + genie-history（仅在 sessions DB 不可用时）
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export type CodebuddyStatus = "running" | "completed" | "idle" | "unknown";

export interface CodebuddySession {
  sessionId: string;
  status: CodebuddyStatus;
  updatedAt: number;
  workspacePath: string | null;
  displayName: string | null;
  userId: string | null;
}

export interface CodebuddySnapshot {
  sessions: CodebuddySession[];
}

export type CodebuddyHealth = "not_detected" | "ok" | "degraded";

function defaultCodebuddyAppDir(): string | null {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/CodeBuddy CN");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), "CodeBuddy CN");
  }
  return null;
}

export function defaultCodebuddyGenieDir(): string | null {
  const appDir = defaultCodebuddyAppDir();
  return appDir ? path.join(appDir, "User/globalStorage/tencent-cloud.coding-copilot/genie-history") : null;
}

export function codebuddySafeName(sessionId: string): string {
  return `CodeBuddy · ${sessionId.slice(0, 8)}`;
}

const STATUS_MAP: Record<string, CodebuddyStatus> = {
  working: "running",
  active: "running",
  running: "running",
  pending: "running",
  thinking: "running",
  streaming: "running",
  generating: "running",
  completed: "completed",
  done: "completed",
  finished: "completed",
  stopped: "completed",
  cancelled: "completed",
  error: "completed",
  failed: "completed",
};

function normalizeStatus(raw: string): CodebuddyStatus {
  return STATUS_MAP[raw.toLowerCase()] ?? "unknown";
}

const REOPEN_RETRY_MS = 30_000;

export class CodebuddySnapshotReader {
  private readonly appDir: string | null;
  private db: DatabaseSync | null = null;
  private lastHealth: CodebuddyHealth = "not_detected";
  private nextRetryAt = 0;

  constructor(genieDir?: string | null) {
    if (genieDir) {
      // 兼容旧调用：推算 appDir
      this.appDir = path.resolve(genieDir, "../../..");
    } else {
      this.appDir = defaultCodebuddyAppDir();
    }
  }

  health(): CodebuddyHealth {
    return this.lastHealth;
  }

  read(): CodebuddySnapshot | null {
    if (!this.appDir || !fs.existsSync(this.appDir)) {
      this.lastHealth = "not_detected";
      return null;
    }
    // 主路径：codebuddy-sessions.vscdb
    const dbSessions = this.readSessionsDb();
    if (dbSessions !== null) {
      this.lastHealth = "ok";
      return { sessions: dbSessions };
    }
    // 回退路径：message-queue + genie-history（DB 不可用时）
    try {
      const sessions = this.fallbackSessions();
      this.lastHealth = sessions.length > 0 ? "ok" : (this.appDir ? "ok" : "not_detected");
      return { sessions };
    } catch {
      this.lastHealth = "degraded";
      return null;
    }
  }

  private readSessionsDb(): CodebuddySession[] | null {
    const dbPath = path.join(this.appDir!, "codebuddy-sessions.vscdb");
    if (!fs.existsSync(dbPath)) return null;
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
        "SELECT key, value FROM ItemTable WHERE key LIKE 'session:%'"
      ).all() as { key: string; value: string }[];
      const now = Date.now();
      const out: CodebuddySession[] = [];
      for (const r of rows) {
        try {
          const d = JSON.parse(r.value) as {
            conversationId?: string; status?: string; updatedAt?: number;
            cwd?: string; title?: string; userId?: string;
          };
          if (!d.conversationId || typeof d.updatedAt !== "number") continue;
          if (now - d.updatedAt > 3600_000) continue;
          out.push({
            sessionId: d.conversationId,
            status: normalizeStatus(d.status ?? ""),
            updatedAt: d.updatedAt,
            workspacePath: d.cwd ?? null,
            displayName: d.title ?? null,
            userId: d.userId ?? null,
          });
        } catch { /* skip bad row */ }
      }
      return out;
    } catch {
      this.markDegraded();
      return null;
    }
  }

  // ponytail: 回退路径仅在 sessions DB 不可用时走，保留最小实现
  private fallbackSessions(): CodebuddySession[] {
    const now = Date.now();
    const storageDir = path.join(this.appDir!, "User/globalStorage/tencent-cloud.coding-copilot");
    if (!fs.existsSync(storageDir)) return [];
    const mqDir = path.join(storageDir, "message-queue");
    const out: CodebuddySession[] = [];
    if (fs.existsSync(mqDir)) {
      for (const f of fs.readdirSync(mqDir).filter(f => f.endsWith(".json"))) {
        try {
          const filePath = path.join(mqDir, f);
          const fileMtimeMs = fs.statSync(filePath).mtimeMs;
          const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          for (const [cid, conv] of Object.entries(raw?.conversations ?? {})) {
            const c = conv as { updatedAt?: number; runtime?: { activated?: boolean; updatedAt?: number } };
            const updatedAt = Math.max(c.runtime?.updatedAt ?? 0, c.updatedAt ?? 0, fileMtimeMs);
            if (now - updatedAt > 3600_000) continue;
            out.push({
              sessionId: cid,
              status: now - updatedAt < 45_000 ? "running" : "idle",
              updatedAt,
              workspacePath: null,
              displayName: null,
              userId: null,
            });
          }
        } catch { /* skip */ }
      }
    }
    return out;
  }

  private markDegraded(): void {
    this.close();
    this.lastHealth = "degraded";
    this.nextRetryAt = Date.now() + REOPEN_RETRY_MS;
  }

  close(): void {
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
  }
}

// CodeBuddy 对话内容存储在 ~/Library/Application Support/CodeBuddyExtension/Data/<userId>/
// CodeBuddyIDE/<userId>/history/<MD5(cwd)>/<conversationId>/messages/<msgId>.json
// index.json 包含消息顺序，每条消息的 .message 是 JSON 编码的 {role, content[]} 结构。
const CB_EXT_DATA = path.join(os.homedir(), "Library/Application Support/CodeBuddyExtension/Data");

interface IndexEntry { id: string; role: string; isComplete?: boolean }

export function readCodebuddyTranscriptTail(
  userId: string | null,
  workspacePath: string | null,
  conversationId: string,
): string | null {
  if (!userId || !workspacePath) return null;
  try {
    const wsHash = crypto.createHash("md5").update(workspacePath).digest("hex");
    const convDir = path.join(CB_EXT_DATA, userId, "CodeBuddyIDE", userId, "history", wsHash, conversationId);
    const indexPath = path.join(convDir, "index.json");
    if (!fs.existsSync(indexPath)) return null;
    const idx = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { messages?: IndexEntry[] };
    const msgs = idx.messages;
    if (!Array.isArray(msgs) || !msgs.length) return null;
    // 倒序找最后一条 assistant 消息
    let lastAsst: IndexEntry | null = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") { lastAsst = msgs[i]; break; }
    }
    if (!lastAsst) return null;
    const msgPath = path.join(convDir, "messages", `${lastAsst.id}.json`);
    if (!fs.existsSync(msgPath)) return null;
    const raw = JSON.parse(fs.readFileSync(msgPath, "utf-8")) as { message?: string };
    if (typeof raw.message !== "string") return null;
    const inner = JSON.parse(raw.message) as { content?: Array<{ type?: string; text?: string }> };
    if (!Array.isArray(inner.content)) return null;
    // 提取 type="text" 的内容块
    const texts = inner.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!);
    return texts.length ? texts.join("\n") : null;
  } catch { return null; }
}
