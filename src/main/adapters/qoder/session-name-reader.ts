import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTrailingQuestion } from "../../state/trailing-question";

/** Qoder 0.4+ 会话库：标题用于本地显示；最新回复只在内存中用于结尾提问判定。 */
export function defaultQoderSessionDbPath(): string | null {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Application Support/com.qoder.app.stable/main.sqlite");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), "com.qoder.app.stable/main.sqlite");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "com.qoder.app.stable/main.sqlite");
}

export class QoderSessionNameReader {
  private readonly dbPath: string | null;
  private db: DatabaseSync | null = null;

  constructor(dbPath: string | null = defaultQoderSessionDbPath()) {
    this.dbPath = dbPath;
  }

  title(sessionId: string): string | null {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return null;
    try {
      if (!this.db) this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      const row = this.db.prepare("SELECT title FROM chat_sessions WHERE session_id = ?").get(sessionId) as { title?: unknown } | undefined;
      return typeof row?.title === "string" && row.title.trim() ? row.title.trim() : null;
    } catch {
      this.close(); // DB 升级、锁冲突或 schema 不同，静默回退旧名称来源。
      return null;
    }
  }

  /** 最新对话方仍是 assistant 时返回其文本；只供本地判断 Qoder 是否在等用户回答，不落盘。 */
  latestAssistantMessage(sessionId: string): string | null {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return null;
    try {
      if (!this.db) this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      const row = this.db.prepare(`
        SELECT json_extract(payload_json, '$.role') AS role,
               json_extract(payload_json, '$.text') AS text
        FROM chat_session_messages
        WHERE session_id = ?
          AND json_extract(payload_json, '$.role') IN ('user', 'assistant')
        ORDER BY sequence DESC
        LIMIT 1
      `).get(sessionId) as { role?: unknown; text?: unknown } | undefined;
      return row?.role === "assistant" && typeof row.text === "string" && row.text.trim() ? row.text : null;
    } catch {
      this.close(); // 旧版 Qoder 或 schema 变更时退回 hook 状态。
      return null;
    }
  }

  /** 未被用户回复的结尾提问；原文仅在进程内用于已有的黄灯判定。 */
  latestAssistantQuestion(sessionId: string, questionWords: string[]): string | null {
    const text = this.latestAssistantMessage(sessionId);
    return text && isTrailingQuestion(text, questionWords) ? text : null;
  }

  close(): void {
    try { this.db?.close(); } catch { /* 忽略关闭错误 */ }
    this.db = null;
  }
}
