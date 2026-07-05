// state.vscdb 只读查询（design.md D1/D7a）：readonly 打开、主键范围查询、schema 变更降级。
// 用 node:sqlite 内置模块：零原生依赖，系统 Node（vitest）与 Electron 内置 Node ABI 通吃。
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { BUBBLE_RANGE_SQL, bubbleRangeParams, COMPOSER_DATA_SQL, composerDataParams, COMPOSER_HEADER_SQL, RECENT_SESSIONS_SQL } from "./db-constants";

export interface BubbleRow {
  key: string;
  toolName: string | null;
  status: string | null;
  userDecision: string | null;
  additionalStatus: string | null;
  blockReason: string | null;
  reviewStatus: string | null;
}

export interface SessionMeta {
  name: string | null;
  createdAt: number | null;
}

/** composerHeaders 会话头信号：作答即清与思考活性判定的补充证据（气泡通路的落库滞后补救） */
export interface ComposerHeader {
  /** 阻塞对话框（AskQuestion 等）当前挂起 */
  blocking: boolean;
  /** 会话检查点最后更新时间（作答/编辑时前进） */
  checkpointAt: number | null;
}

/** 平台默认 DB 路径（design.md D7a） */
export function defaultDbPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "Cursor/User/globalStorage/state.vscdb");
    default:
      return path.join(home, ".config/Cursor/User/globalStorage/state.vscdb");
  }
}

/** 打开/查询失败后的重试间隔：先启动本应用、后启动 Cursor 的场景可自动恢复，无需重启 */
const REOPEN_RETRY_MS = 30_000;

export class CursorDbReader {
  private db: DatabaseSync | null = null;
  private available = true;
  private nextRetryAt = 0;
  private readonly dbPath: string;

  constructor(dbPath: string = defaultDbPath()) {
    this.dbPath = dbPath;
  }

  /** DB 通道健康状态；false 时状态机应降级（黄灯走启发式），到达重试点会自动尝试恢复 */
  isAvailable(): boolean {
    this.handle();
    return this.available;
  }

  private open(): void {
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.available = true;
    } catch {
      this.markUnavailable();
    }
  }

  private markUnavailable(): void {
    try {
      this.db?.close();
    } catch {
      /* 关闭失败无需处理 */
    }
    this.db = null;
    this.available = false;
    this.nextRetryAt = Date.now() + REOPEN_RETRY_MS;
  }

  private handle(): DatabaseSync | null {
    if (this.db === null && (this.available || Date.now() >= this.nextRetryAt)) this.open();
    return this.db;
  }

  latestBubbles(sessionId: string, limit: number): BubbleRow[] {
    const db = this.handle();
    if (!db) return [];
    try {
      return db.prepare(BUBBLE_RANGE_SQL).all(...bubbleRangeParams(sessionId, limit)) as unknown as BubbleRow[];
    } catch {
      // 表/字段结构变化（Cursor 升级）或连接失效 → 降级并允许重试恢复
      this.markUnavailable();
      return [];
    }
  }

  /**
   * composerHeaders 信号（增强通路）：失败只返回 null（"无此信号"），不降级气泡通路——
   * ItemTable/headers 键属另一套结构，缺失或变化不代表气泡查询也坏了。
   */
  composerHeader(sessionId: string): ComposerHeader | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db.prepare(COMPOSER_HEADER_SQL).get(sessionId) as { blocking: unknown; checkpointAt: number | null } | undefined;
      if (!row) return null;
      // SQLite json_extract 的布尔以 0/1 返回
      return { blocking: row.blocking === 1 || row.blocking === true, checkpointAt: row.checkpointAt ?? null };
    } catch {
      return null;
    }
  }

  sessionMetadata(sessionId: string): SessionMeta | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db.prepare(COMPOSER_DATA_SQL).get(...composerDataParams(sessionId)) as
        | { name: string | null; createdAt: number | null; status: string | null }
        | undefined;
      if (!row || (row.name === null && row.createdAt === null)) return null;
      return { name: row.name, createdAt: row.createdAt };
    } catch {
      this.markUnavailable();
      return null;
    }
  }

  /** 冷启动兜底：最近活动的会话列表（status 不实时，仅用于发现，以气泡/事件校正） */
  recentSessions(limit: number): Array<{ sessionId: string; name: string | null; createdAt: number | null; lastUpdatedAt: number | null }> {
    const db = this.handle();
    if (!db) return [];
    try {
      return db.prepare(RECENT_SESSIONS_SQL).all(limit) as unknown as Array<{ sessionId: string; name: string | null; createdAt: number | null; lastUpdatedAt: number | null }>;
    } catch {
      this.markUnavailable();
      return [];
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** 仅供测试验证只读性 */
  rawHandleForTest(): DatabaseSync | null {
    return this.handle();
  }
}
