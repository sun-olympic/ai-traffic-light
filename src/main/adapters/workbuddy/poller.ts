// WorkBuddy 轮询 diff 管道：
// 基线 + diff → 状态转移 / updatedAt 变化时产出标准化 TrafficEvent → 内存直投 tracker。
// WorkBuddy 的 "completed" 是"当前轮次完成"而非永久终态（会话可恢复交互），
// 只有 stopped / error 才是真终态。活性判定主要靠 updatedAt 变化而非纯 status 转移。
import type { EventType, TrafficEvent } from "../../../shared/events";
import type { ProbeSnapshot } from "../adapter";
import type { WorkbuddySnapshot, WorkbuddySession, WorkbuddyStatus } from "./db-reader";

interface WorkbuddyPollerDeps {
  read: () => WorkbuddySnapshot | null;
  emit: (ev: TrafficEvent) => void;
  clock: () => number;
  transcriptTail?: (sessionId: string) => string | null;
}

const EVENT_SCHEMA_VERSION = 3;
// "completed" 后 60 秒内视为"刚完成、会话仍温热"（冷启动首次遇到时用）
const WARM_THRESHOLD_MS = 60_000;

function isTerminal(s: WorkbuddyStatus): boolean {
  return s === "stopped" || s === "error";
}

export class WorkbuddyPoller {
  private readonly deps: WorkbuddyPollerDeps;
  private baseline = new Map<string, WorkbuddySession>();
  private lastSnap: WorkbuddySnapshot | null = null;

  constructor(deps: WorkbuddyPollerDeps) {
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
        if (isTerminal(sess.status)) continue;
        if (sess.status === "running" || sess.status === "waiting") {
          this.emit("session_start", id, now, {});
          if (sess.status === "running") this.emit("activity", id, now, {});
          if (sess.status === "waiting") this.emit("user_action_required", id, now, {});
        } else if (sess.status === "completed" && now - sess.updatedAt < WARM_THRESHOLD_MS) {
          this.emit("session_start", id, now, {});
          this.emit("activity", id, now, {});
        } else if (sess.status === "completed" && now - sess.updatedAt < 3600_000) {
          // 冷完成会话（60 秒 ~ 1 小时）：注入 start+stop 以触发结尾提问检测
          const lastMsg = this.deps.transcriptTail?.(id) ?? null;
          this.emit("session_start", id, sess.updatedAt, {});
          this.deps.emit({
            v: EVENT_SCHEMA_VERSION, tool: "workbuddy", sessionId: id, event: "stop" as EventType,
            ts: sess.updatedAt, meta: { status: "completed", resolvedLastMessage: lastMsg },
          });
        }
      } else {
        // 已跟踪的会话：检测状态变化 或 updatedAt 变化
        if (isTerminal(sess.status) && !isTerminal(prev.status)) {
          const stopStatus = sess.status === "stopped" ? "aborted" : "error";
          this.emit("stop", id, now, { status: stopStatus });
        } else if (sess.status === "completed" && prev.status !== "completed") {
          // AI 完成当前轮次：即时 stop + 尾问文本，让 tracker 立即判黄灯/灭灯（不等 30s probeSnapshot）
          const lastMsg = this.deps.transcriptTail?.(id) ?? null;
          this.emit("stop", id, now, { status: "completed", resolvedLastMessage: lastMsg });
        } else if (sess.status === "running" && prev.status !== "running") {
          this.emit("activity", id, now, {});
        } else if (sess.status === "waiting" && prev.status !== "waiting") {
          this.emit("user_action_required", id, now, {});
        } else if (sess.updatedAt > prev.updatedAt && !isTerminal(sess.status) && sess.status !== "completed") {
          // updatedAt 变化 = 有新交互（Pending→running 瞬间完成，轮询没抓到中间态）
          if (sess.status === "waiting") {
            this.emit("user_action_required", id, now, {});
          } else {
            this.emit("activity", id, now, {});
          }
        }
      }
    }

    this.baseline = current;
  }

  probeSnapshot(sessionId: string): ProbeSnapshot | null {
    const sess = this.lastSnap?.sessions.find((s) => s.sessionId === sessionId);
    if (!sess) return null;
    const now = this.deps.clock();
    const completedCold = sess.status === "completed" && now - sess.updatedAt > 30_000;
    const terminalStatus = sess.status === "stopped" ? "aborted" as const
      : sess.status === "error" ? "error" as const
      : completedCold ? "completed" as const
      : null;
    const lastAssistantMessage = terminalStatus === "completed"
      ? (this.deps.transcriptTail?.(sessionId) ?? null) : null;
    return {
      pending: sess.status === "waiting" ? { kind: "user_action_pending" as const } : { kind: "none" as const },
      executing: sess.status === "running",
      stuckCandidate: false,
      missedQuestion: false,
      ...(terminalStatus ? { terminal: { status: terminalStatus, lastAssistantMessage } } : {}),
    };
  }

  sessionInfo(sessionId: string): WorkbuddySession | undefined {
    return this.lastSnap?.sessions.find((s) => s.sessionId === sessionId);
  }

  private emit(event: EventType, sessionId: string, ts: number, meta: Record<string, unknown>): void {
    this.deps.emit({ v: EVENT_SCHEMA_VERSION, tool: "workbuddy", sessionId, event, ts, meta });
  }
}
