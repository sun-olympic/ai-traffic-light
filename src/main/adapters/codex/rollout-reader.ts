// Codex rollout JSONL 定向读取（design.md D5）：stop 终态判别 / 结尾提问文本 / probe 兜底 / 冷启动重建。
// 全部同步 fs（尾部读几十 KB，与 readTranscript 同级），不常开监听。
// schema 宽容：坏行跳过、未知类型跳过、session_meta 的 id 优先 session_id 兜底（实证一个月内漂移过一次）。
import * as fs from "node:fs";
import path from "node:path";
import type { ProbeSnapshot, StopResolution } from "../adapter";

export interface RolloutTail {
  ok: boolean;
  /** running = 尾部无终态事件（回合进行中） */
  status: "completed" | "aborted" | "error" | "running";
  lastAssistantMessage: string | null;
}

const TAIL_BYTES = 64 * 1024;

/** 尾部倒序找最近的终态 event_msg：task_complete/turn_aborted/类型含 error 字样（终态位置 + 宽匹配） */
export function readRolloutTail(filePath: string): RolloutTail {
  let text: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, status: "running", lastAssistantMessage: null };
  }

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; payload?: { type?: unknown; last_agent_message?: unknown } };
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // 坏行/截断行跳过
    }
    if (entry?.type !== "event_msg") continue;
    const t = String(entry.payload?.type ?? "");
    if (t === "task_complete") {
      const msg = entry.payload?.last_agent_message;
      return { ok: true, status: "completed", lastAssistantMessage: typeof msg === "string" ? msg : null };
    }
    if (t === "turn_aborted") return { ok: true, status: "aborted", lastAssistantMessage: null };
    if (t.includes("error")) return { ok: true, status: "error", lastAssistantMessage: null };
    // 回合边界：先撞到 task_started 说明当前回合尚无终态（实测踩坑：越界会把上一轮的
    // task_complete 误判为当前终态，审批等待黄灯被合成 stop 清掉）
    if (t === "task_started") return { ok: true, status: "running", lastAssistantMessage: null };
    // 其余 event_msg（token_count/agent_message 等）继续向前找
  }
  return { ok: true, status: "running", lastAssistantMessage: null };
}

/** 目录扫描兜底：按文件名中的 threadId 命中，多文件（resume）取 mtime 最新 */
export function locateRollout(sessionsDir: string, threadId: string): string | null {
  let best: { p: string; mtime: number } | null = null;
  for (const p of walkRolloutFiles(sessionsDir)) {
    if (!path.basename(p).includes(threadId)) continue;
    try {
      const mtime = fs.statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { p, mtime };
    } catch {
      /* 竞争删除，跳过 */
    }
  }
  return best?.p ?? null;
}

/** stopStatusResolver 实现：transcriptPath 优先直读 → 目录扫描兜底；不可读或无终态返回 null（tracker 兜底 completed） */
export function resolveCodexStop(sessionsDir: string, sessionId: string, transcriptPath: string | undefined): StopResolution | null {
  const candidates: string[] = [];
  if (transcriptPath) candidates.push(transcriptPath);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const located = locateRollout(sessionsDir, sessionId);
    if (located) candidates.push(located);
  }
  for (const p of candidates) {
    const tail = readRolloutTail(p);
    if (tail.ok && tail.status !== "running") {
      return { status: tail.status, lastAssistantMessage: tail.lastAssistantMessage };
    }
  }
  return null;
}

/**
 * codex 探针（D4 保险丝）：读 rollout 尾行，发现终态带回 terminal（tracker 注入合成 stop）。
 * codex 的精确黄灯是推送型（approval_request），probe 的 pending 恒为 none；
 * executing/stuck 无气泡数据源，恒 false（卡死兜底由通用 inactive 机制覆盖）。
 */
export function codexProbeSnapshot(sessionsDir: string, sessionId: string, transcriptPath: string | undefined): ProbeSnapshot | null {
  let p = transcriptPath;
  if (!p || !fs.existsSync(p)) p = locateRollout(sessionsDir, sessionId) ?? undefined;
  if (!p) return null;
  const tail = readRolloutTail(p);
  if (!tail.ok) return null;
  return {
    pending: { kind: "none" },
    executing: false,
    stuckCandidate: false,
    missedQuestion: false,
    ...(tail.status !== "running" ? { terminal: { status: tail.status, lastAssistantMessage: tail.lastAssistantMessage } } : {}),
  };
}

export interface ColdStartSession {
  sessionId: string;
  transcriptPath: string;
  status: RolloutTail["status"];
  lastActiveAt: number;
}

const DAY_MS = 24 * 3600_000;

/** 冷启动重建：扫近 7 天目录；未终态会话全部恢复，已完成/中止/错误会话仅近 24h（防灰点洪水） */
export function scanRecentRollouts(sessionsDir: string, now: number = Date.now()): ColdStartSession[] {
  const out: ColdStartSession[] = [];
  for (const p of walkRolloutFiles(sessionsDir, { sinceMs: now - 7 * DAY_MS })) {
    let mtime: number;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < now - 7 * DAY_MS) continue;
    const tail = readRolloutTail(p);
    if (!tail.ok) continue;
    if (tail.status !== "running" && mtime < now - DAY_MS) continue;
    const sessionId = sessionIdOf(p);
    if (!sessionId) continue;
    out.push({ sessionId, transcriptPath: p, status: tail.status, lastActiveAt: mtime });
  }
  return out;
}

/** 近 24h rollout 目录最新文件 mtime（0 = 无活动）；"已安装未生效"的活跃迹象证据（design D6） */
export function latestRolloutActivityAt(sessionsDir: string, now: number = Date.now()): number {
  let latest = 0;
  for (const p of walkRolloutFiles(sessionsDir, { sinceMs: now - DAY_MS })) {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* 文件消失跳过 */
    }
  }
  return latest;
}

/** 首行 session_meta 的 id 优先、session_id 兜底、文件名再兜底（rollout-<ts>-<uuid>.jsonl） */
function sessionIdOf(filePath: string): string | null {
  try {
    const head = fs.readFileSync(filePath, "utf-8").slice(0, 4096);
    const first = head.split("\n")[0];
    const entry = JSON.parse(first);
    if (entry?.type === "session_meta") {
      const id = entry.payload?.id ?? entry.payload?.session_id;
      if (typeof id === "string" && id) return id;
    }
  } catch {
    /* 落文件名兜底 */
  }
  const m = path.basename(filePath).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/);
  return m ? m[1] : null;
}

/** 遍历 sessions/YYYY/MM/DD/*.jsonl；sinceMs 提供时按目录日期剪枝（目录日期粒度为天） */
function* walkRolloutFiles(sessionsDir: string, opts: { sinceMs?: number } = {}): Generator<string> {
  let years: string[];
  try {
    years = fs.readdirSync(sessionsDir);
  } catch {
    return;
  }
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of tryReaddir(path.join(sessionsDir, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of tryReaddir(path.join(sessionsDir, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        if (opts.sinceMs !== undefined) {
          const dayEnd = Date.parse(`${y}-${m}-${d}T23:59:59Z`);
          if (Number.isFinite(dayEnd) && dayEnd < opts.sinceMs) continue;
        }
        for (const f of tryReaddir(path.join(sessionsDir, y, m, d))) {
          if (f.endsWith(".jsonl")) yield path.join(sessionsDir, y, m, d, f);
        }
      }
    }
  }
}

function tryReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}
