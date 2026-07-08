// CodeBuddy 轮询 diff 管道：基于 codebuddy-sessions.vscdb 的精确状态检测。
// running = 绿灯；completed = AI 完成（即时发 stop + 尾部提问检测 → 黄灯）；idle = 灰点。
import type { EventType, TrafficEvent } from "../../../shared/events";
import type { ProbeSnapshot } from "../adapter";
import type { CodebuddySnapshot, CodebuddySession } from "./snapshot-reader";

interface CodebuddyPollerDeps {
  read: () => CodebuddySnapshot | null;
  emit: (ev: TrafficEvent) => void;
  clock: () => number;
  transcriptTail?: (sessionId: string) => string | null;
}

const EVENT_SCHEMA_VERSION = 3;

export class CodebuddyPoller {
  private readonly deps: CodebuddyPollerDeps;
  private baseline = new Map<string, CodebuddySession>();
  private lastSnap: CodebuddySnapshot | null = null;

  constructor(deps: CodebuddyPollerDeps) {
    this.deps = deps;
  }

  poll(): void {
    const snap = this.deps.read();
    if (!snap) return;
    this.lastSnap = snap;
    const now = this.deps.clock();
    const current = new Map(snap.sessions.map((s) => [s.sessionId, s]));

    for (const [id, sess] of current) {
      const prev = this.baseline.get(id);
      if (!prev) {
        if (sess.status === "running") {
          this.emit("session_start", id, now, {});
          this.emit("activity", id, now, {});
        }
      } else if (prev.status !== sess.status) {
        if (sess.status === "running") {
          this.emit("session_start", id, now, {});
          this.emit("activity", id, now, {});
        } else if (sess.status === "completed" && prev.status === "running") {
          const lastMsg = this.deps.transcriptTail?.(id) ?? null;
          this.emit("stop", id, now, { status: "completed", ...(lastMsg ? { resolvedLastMessage: lastMsg } : {}) });
        } else if (sess.status === "idle" && prev.status === "running") {
          this.emit("stop", id, now, { status: "completed" });
        }
      } else if (sess.status === "running" && sess.updatedAt > prev.updatedAt) {
        this.emit("activity", id, now, {});
      }
    }

    for (const [id, prev] of this.baseline) {
      if (!current.has(id) && prev.status === "running") {
        this.emit("stop", id, now, { status: "completed" });
      }
    }

    this.baseline = current;
  }

  probeSnapshot(sessionId: string): ProbeSnapshot | null {
    const sess = this.lastSnap?.sessions.find((s) => s.sessionId === sessionId);
    if (!sess) return null;
    const completedCold = sess.status === "completed" && this.deps.clock() - sess.updatedAt > 15_000;
    const idleCold = sess.status === "idle" && this.deps.clock() - sess.updatedAt > 15_000;
    const terminal = completedCold || idleCold;
    const lastMsg = terminal ? (this.deps.transcriptTail?.(sessionId) ?? null) : null;
    return {
      pending: { kind: "none" as const },
      executing: sess.status === "running",
      stuckCandidate: false,
      missedQuestion: false,
      ...(terminal ? { terminal: { status: "completed" as const, lastAssistantMessage: lastMsg } } : {}),
    };
  }

  sessionInfo(sessionId: string): CodebuddySession | undefined {
    return this.lastSnap?.sessions.find((s) => s.sessionId === sessionId);
  }

  private emit(event: EventType, sessionId: string, ts: number, meta: Record<string, unknown>): void {
    this.deps.emit({ v: EVENT_SCHEMA_VERSION, tool: "codebuddy", sessionId, event, ts, meta });
  }
}
