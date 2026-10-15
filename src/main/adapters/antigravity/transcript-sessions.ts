// Modern Antigravity stores conversation state in brain/* transcript JSONL files.
// Only structural fields are read here; message content is deliberately ignored.
import * as fs from "node:fs";
import path from "node:path";
import { deriveObservation } from "./derive-state";
import type { StepRow } from "./db-reader";

const MAX_TAIL_BYTES = 64 * 1024;
const STATUS: Record<string, number> = {
  PENDING: 1, RUNNING: 2, GENERATING: 8, QUEUED: 11,
  WAITING: 9, NEEDS_USER_INPUT: 9,
  DONE: 3, COMPLETED: 3,
  CANCELED: 6, CANCELLED: 6,
  ERROR: 7, FAILED: 7,
};

export interface TranscriptSession {
  sessionId: string;
  transcriptPath: string;
  mtime: number;
  ino: number;
  observation: ReturnType<typeof deriveObservation>;
}

function latestTranscript(home: string, sessionId: string): string | null {
  const dir = path.join(home, "brain", sessionId, ".system_generated", "logs");
  try {
    const candidates = fs.readdirSync(dir).filter((name) => name.startsWith("transcript") && name.endsWith(".jsonl"));
    let best: { path: string; mtime: number } | null = null;
    for (const name of candidates) {
      const p = path.join(dir, name);
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
      } catch { /* a file may disappear between readdir and stat */ }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

function readStructuralRows(p: string): StepRow[] {
  try {
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - MAX_TAIL_BYTES);
    const fd = fs.openSync(p, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(Math.min(st.size, MAX_TAIL_BYTES));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally { fs.closeSync(fd); }
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const rows: StepRow[] = [];
    for (const line of text.split("\n")) {
      try {
        const item = JSON.parse(line) as Record<string, unknown>;
        const idx = item.step_index;
        const status = typeof item.status === "string" ? STATUS[item.status.toUpperCase()] : undefined;
        if (Number.isInteger(idx) && typeof status === "number") {
          // 用户与系统消息的 DONE 只表示消息已写入，不表示模型已完成这一轮。
          const nonModelMessage = item.source === "USER_EXPLICIT" || item.source === "SYSTEM";
          rows.push({ idx: idx as number, stepType: 0, status: nonModelMessage && status === STATUS.DONE ? STATUS.RUNNING : status, errorDetails: null });
        }
      } catch { /* ignore incomplete/malformed JSON lines */ }
    }
    return rows;
  } catch {
    return [];
  }
}

/** Discover bounded recent transcript sessions without reading message text. */
export function discoverTranscriptSessions(home: string, cap = 20): TranscriptSession[] {
  const brain = path.join(home, "brain");
  let ids: string[];
  try { ids = fs.readdirSync(brain); } catch { return []; }
  const candidates: Array<{ sessionId: string; transcriptPath: string; mtime: number; ino: number }> = [];
  for (const sessionId of ids) {
    const dir = path.join(brain, sessionId);
    try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
    const transcriptPath = latestTranscript(home, sessionId);
    if (!transcriptPath) continue;
    try {
      const st = fs.lstatSync(transcriptPath);
      candidates.push({ sessionId, transcriptPath, mtime: st.mtimeMs, ino: st.ino });
    } catch { /* session may be concurrently rotated */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const found: TranscriptSession[] = [];
  for (const candidate of candidates.slice(0, cap)) {
    const rows = readStructuralRows(candidate.transcriptPath);
    if (!rows.length) continue;
    found.push({ ...candidate, observation: deriveObservation(rows) });
  }
  return found;
}
