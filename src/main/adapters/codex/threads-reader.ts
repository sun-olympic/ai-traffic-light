// Codex 状态库只读查询（design.md D7）：threads 表元数据 + 背景线程宽限期过滤。
// - glob state_*.sqlite 取版本号最大（文件名带 migration 版本，随升级漂移，勿硬编码）；
// - node:sqlite readOnly 打开（等价 SQLITE_OPEN_READONLY，WAL 库可读；CLI 的 -readonly 反而打不开）；
// - MUST NOT 对 Codex 任何库执行写操作。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import path from "node:path";

/** glob state_*.sqlite 按版本号数值取最大 */
export function latestStateDb(codexDir: string): string | null {
  let best: { p: string; ver: number } | null = null;
  let names: string[];
  try {
    names = fs.readdirSync(codexDir);
  } catch {
    return null;
  }
  for (const n of names) {
    const m = n.match(/^state_(\d+)\.sqlite$/);
    if (!m) continue;
    const ver = Number(m[1]);
    if (!best || ver > best.ver) best = { p: path.join(codexDir, n), ver };
  }
  return best?.p ?? null;
}

export interface ThreadMeta {
  name: string | null;
  createdAt: number | null;
  archived: boolean;
  rolloutPath: string | null;
}

/** 打开/查询失败后的重试间隔：Codex 后装/首次初始化的场景可自动恢复，无需重启 */
const REOPEN_RETRY_MS = 30_000;

export class CodexThreadsReader {
  private readonly codexDir: string;
  private db: DatabaseSync | null = null;
  private available = true;
  private nextRetryAt = 0;

  constructor(codexDir: string) {
    this.codexDir = codexDir;
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
    if (this.db === null && (this.available || Date.now() >= this.nextRetryAt)) {
      const p = latestStateDb(this.codexDir);
      if (!p) {
        this.markUnavailable();
        return null;
      }
      try {
        this.db = new DatabaseSync(p, { readOnly: true });
        this.available = true;
      } catch {
        this.markUnavailable();
      }
    }
    return this.db;
  }

  isAvailable(): boolean {
    this.handle();
    return this.available;
  }

  metadata(threadId: string): ThreadMeta | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db.prepare("SELECT title, created_at_ms, archived, rollout_path FROM threads WHERE id = ?").get(threadId) as
        | { title: string | null; created_at_ms: number | null; archived: number | null; rollout_path: string | null }
        | undefined;
      if (!row) return null;
      // Codex UI 实际显示的是 session_index.jsonl 里 AI 生成的短标题；threads.title 只是首条消息原文
      return { name: this.indexName(threadId) ?? row.title, createdAt: row.created_at_ms, archived: row.archived === 1, rolloutPath: row.rollout_path };
    } catch {
      // schema 变化（Codex 升级）或连接失效 → 降级并允许重试恢复
      this.markUnavailable();
      return null;
    }
  }

  /** session_index.jsonl 的 AI 生成短标题（追加式 JSONL，同 id 取最后一行；文件缺失/坏行返回 null） */
  private indexName(threadId: string): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.codexDir, "session_index.jsonl"), "utf-8");
    } catch {
      return null;
    }
    let name: string | null = null;
    for (const line of raw.split("\n")) {
      if (!line.includes(threadId)) continue;
      try {
        const o = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (o.id === threadId && typeof o.thread_name === "string" && o.thread_name) name = o.thread_name;
      } catch {
        /* 坏行跳过 */
      }
    }
    return name;
  }

  /** 背景线程判据（D7）：threads 表存在且 preview 非空 = 真实用户会话；null = 库不可用（证据不足） */
  threadKnown(threadId: string): boolean | null {
    const db = this.handle();
    if (!db) return null;
    try {
      const row = db.prepare("SELECT preview FROM threads WHERE id = ?").get(threadId) as { preview: string | null } | undefined;
      return !!row && typeof row.preview === "string" && row.preview.length > 0;
    } catch {
      this.markUnavailable();
      return null;
    }
  }

  /** heartbeat 线程 id 集合（确定性证据）；文件或键缺失返回空集（本机实况即无此键） */
  heartbeatIds(): Set<string> {
    try {
      const raw = fs.readFileSync(path.join(this.codexDir, ".codex-global-state.json"), "utf-8");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const map = obj["heartbeat-thread-permissions-by-id"];
      if (typeof map === "object" && map !== null) return new Set(Object.keys(map));
    } catch {
      /* 缺失/坏文件 → 空集 */
    }
    return new Set();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export interface BackgroundGraceFilterOptions {
  graceMs: number;
  clock: () => number;
  heartbeatIds: () => Set<string>;
  threadKnown: (id: string) => boolean | null;
}

/**
 * 背景线程宽限期过滤（D7 评审定案：默认展示、延迟定罪）。
 * 首事件：heartbeat 命中立即过滤；threads 已知直接转正；缺席先跟踪并进入宽限期。
 * sweep（tick 调用）：宽限期内出现转正；期满仍缺席定罪返回（调用方移除会话）；库不可用不定罪（顺延）。
 */
export class BackgroundGraceFilter {
  private readonly opts: BackgroundGraceFilterOptions;
  private readonly pendingSince = new Map<string, number>();

  constructor(opts: BackgroundGraceFilterOptions) {
    this.opts = opts;
  }

  onFirstEvent(id: string): "filter" | "track" {
    if (this.opts.heartbeatIds().has(id)) return "filter";
    if (this.opts.threadKnown(id) !== true) this.pendingSince.set(id, this.opts.clock());
    return "track";
  }

  /** 周期复查；返回需定罪过滤的 id 列表（每个 id 只定罪一次） */
  sweep(): string[] {
    const now = this.opts.clock();
    const convicted: string[] = [];
    for (const [id, since] of this.pendingSince) {
      const knownNow = this.opts.threadKnown(id);
      if (knownNow === true) {
        this.pendingSince.delete(id); // 转正
        continue;
      }
      if (knownNow === null) continue; // 库不可用：证据不足，宽限期顺延
      if (now - since > this.opts.graceMs) {
        this.pendingSince.delete(id);
        convicted.push(id);
      }
    }
    return convicted;
  }
}
