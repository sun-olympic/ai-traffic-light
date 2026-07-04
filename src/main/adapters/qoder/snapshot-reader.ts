// Qoder 本地任务快照只读读取器（add-qoder-support D1/D4/D5/D6）。
// 数据源：~/Library/Application Support/Qoder/User/globalStorage/state.vscdb
// 表 ItemTable，键 aicoding.questTaskListSnapshot（本机实测 v1 结构：
// { version, updatedAt, folders: { <workspacePath|__virtual__>: { updatedAt, tasks: [...] } } }）。
// 隐私边界（D6）：task 的 query/title/name/userRequirements 等 prompt 类字段一律不进入解析结果。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 归一化后的任务状态（D4）；unknown 永不直接映射为红 */
export type QoderStatus = "running" | "user_action" | "completed" | "stopped" | "error" | "unknown";

/** 任务视图；除 displayName 外禁止添加 prompt 类字段 */
export interface QoderTask {
  taskId: string;
  canonicalId: string;
  status: QoderStatus;
  /** 快照内该任务最近更新时刻（活性证据） */
  updatedAt: number;
  /** __virtual__ 等无工作区任务为 null */
  workspacePath: string | null;
  /**
   * 任务标题（name/title，Qoder 界面同源显示名）。可能含 prompt 文本，
   * 仅限本地面板即时展示（D6 允许）；通知与持久化事件必须用 qoderSafeName。
   */
  displayName: string | null;
}

export interface QoderSnapshot {
  tasks: QoderTask[];
}

export type QoderHealth = "not_detected" | "ok" | "degraded";

/** 平台默认存储路径；第一版仅支持 macOS，其余平台返回 null（= not detected） */
export function defaultQoderDbPath(): string | null {
  if (process.platform !== "darwin") return null;
  return path.join(os.homedir(), "Library/Application Support/Qoder/User/globalStorage/state.vscdb");
}

const STATUS_MAP: Record<string, QoderStatus> = {
  running: "running",
  planning: "running",
  in_progress: "running",
  prompting: "running",
  streaming: "running",
  actionrequired: "user_action",
  action_required: "user_action",
  suspended: "user_action",
  completed: "completed",
  complete: "completed",
  end_turn: "completed",
  stopped: "stopped",
  stop: "stopped",
  cancelled: "stopped",
  canceled: "stopped",
  error: "error",
  failed: "error",
  failure: "error",
  error_aborted: "error",
};

export function normalizeQoderStatus(raw: string): QoderStatus {
  return STATUS_MAP[raw.toLowerCase()] ?? "unknown";
}

/** D5：canonical id 优先 executionSessionId，缺失回退 <taskId>.session.execution */
export function canonicalQoderSessionId(t: { id: string; executionSessionId?: string }): string {
  return t.executionSessionId || `${t.id}.session.execution`;
}

/** D5：剥离 .session.execution / .session.design 后缀做别名比较 */
export function stripQoderSessionSuffix(id: string): string {
  return id.replace(/\.session\.(execution|design)$/, "");
}

/** D6：隐私安全显示名（workspace 目录名 + 任务短 id），绝不使用 title/query */
export function qoderSafeName(taskId: string, workspacePath: string | null): string {
  const shortId = taskId.slice(0, 9);
  return workspacePath ? `${path.basename(workspacePath)} · ${shortId}` : `Qoder task ${shortId}`;
}

/** 平台默认会话记录缓存目录；transcript 仅用于尾问检测（D7） */
export function defaultQoderCacheDir(): string {
  return path.join(os.homedir(), ".qoder/cache");
}

/**
 * 定位任务的本地 transcript（实测：~/.qoder/cache/projects/<ws>-<hash>/conversation-history/<tid8>/<tid8>.jsonl，
 * tid8 = taskId 前 8 字符）；项目目录 hash 算法未知，遍历 projects 下所有项目找匹配。
 * 远程/云任务无本地记录返回 null（调用方跳过尾问检测）。
 */
export function qoderTranscriptPath(cacheDir: string, taskId: string): string | null {
  const short = taskId.slice(0, 8);
  let projects: string[];
  try {
    projects = fs.readdirSync(path.join(cacheDir, "projects"));
  } catch {
    return null;
  }
  for (const proj of projects) {
    const p = path.join(cacheDir, "projects", proj, "conversation-history", short, `${short}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 打开/查询失败后的重试间隔（与 Cursor/Codex reader 同姿势：降级 + 自动恢复） */
const REOPEN_RETRY_MS = 30_000;

export class QoderSnapshotReader {
  private readonly dbPath: string | null;
  private db: DatabaseSync | null = null;
  private lastHealth: QoderHealth = "not_detected";
  private nextRetryAt = 0;

  constructor(dbPath: string | null = defaultQoderDbPath()) {
    this.dbPath = dbPath;
  }

  /** 三态健康（D9）：not_detected 中性不告警；degraded 提示重试中 */
  health(): QoderHealth {
    return this.lastHealth;
  }

  /** 读取当前任务快照；null = 未检测到或降级（区分看 health()） */
  read(): QoderSnapshot | null {
    if (this.dbPath === null || !fs.existsSync(this.dbPath)) {
      this.close();
      this.lastHealth = "not_detected";
      return null;
    }
    if (this.db === null) {
      if (this.lastHealth === "degraded" && Date.now() < this.nextRetryAt) return null;
      try {
        this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      } catch {
        this.markDegraded();
        return null;
      }
    }
    try {
      const row = this.db.prepare("SELECT value FROM ItemTable WHERE key = 'aicoding.questTaskListSnapshot'").get() as
        | { value: string | Uint8Array }
        | undefined;
      if (!row) {
        this.markDegraded();
        return null;
      }
      const json = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
      const snap = this.parse(json);
      if (snap === null) {
        this.markDegraded();
        return null;
      }
      this.lastHealth = "ok";
      return snap;
    } catch {
      // schema 变化（Qoder 升级）或连接失效 → 降级并允许重试恢复
      this.markDegraded();
      return null;
    }
  }

  private parse(json: string): QoderSnapshot | null {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null) return null;
    const folders = (data as Record<string, unknown>).folders;
    if (typeof folders !== "object" || folders === null) return null;
    const tasks: QoderTask[] = [];
    for (const [folderKey, folderVal] of Object.entries(folders as Record<string, unknown>)) {
      const workspacePath = folderKey.startsWith("/") ? folderKey : null;
      const list = (folderVal as Record<string, unknown> | null)?.tasks;
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (typeof raw !== "object" || raw === null) continue;
        const t = raw as Record<string, unknown>;
        if (typeof t.id !== "string" || !t.id) continue; // 坏行跳过
        const name = typeof t.name === "string" && t.name.trim() ? t.name : typeof t.title === "string" && t.title.trim() ? t.title : null;
        tasks.push({
          taskId: t.id,
          canonicalId: canonicalQoderSessionId({ id: t.id, executionSessionId: typeof t.executionSessionId === "string" ? t.executionSessionId : undefined }),
          status: normalizeQoderStatus(typeof t.status === "string" ? t.status : ""),
          updatedAt: typeof t.updatedAtTimestamp === "number" ? t.updatedAtTimestamp : 0,
          workspacePath,
          displayName: name,
        });
      }
    }
    return { tasks };
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
      /* 关闭失败无需处理 */
    }
    this.db = null;
  }
}
