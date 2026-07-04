// Antigravity 轮询 diff 管道（add-antigravity-support D6/D20/D28/D29/D31/D37）。
// 单一职责：对快照做 diff/episode/epoch 判定并产出标准化事件（内存直投 tracker，
// 绝不写 events.jsonl——隐私边界 D6）；快照怎么读出来是 snapshot-source 的职责。
import type { TrafficEvent } from "../../../shared/events";
import type { ProbeSnapshot, StopResolution } from "../adapter";
import type { SessionObservation, SessionStateKind } from "./derive-state";

/** 一份快照里单个会话的观测（read 依赖产出；epoch = 库指纹，替换/迁移检测用） */
export interface SessionSnapshot {
  sessionId: string;
  observation: SessionObservation;
  /** 库源 mtime：终态事件的稳定时间戳（D37）与基线新鲜度（D31）依据 */
  mtime: number;
  epoch: number;
}

export interface AntigravitySnapshot {
  sessions: SessionSnapshot[];
}

export interface AntigravityPollerDeps {
  /** 读取当前快照；null = 未检测到/降级（本轮跳过，既有状态与基线保留） */
  read: () => AntigravitySnapshot | null;
  emit: (ev: TrafficEvent) => void;
  clock: () => number;
  /** 基线时 waiting 视为"新鲜可恢复"的窗口（D31）；超窗静默防陈旧黄灯复活 */
  freshWaitingMs?: number;
  /**
   * 终态写静默确认窗口（D39）：Antigravity 只在步骤完成时落行，活跃轨迹的 steps 可能全 DONE；
   * 库 mtime 仍在窗口内的终态观测视为 running，静默超窗后才确认终态
   */
  terminalQuietMs?: number;
  /** 结构完成后的有界 transcript 尾部文本（D38）；null = 无安全尾部，跳过尾问 */
  transcriptTail?: (sessionId: string) => string | null;
}

interface SeenSession {
  kind: SessionStateKind;
  maxIdx: number;
  epoch: number;
  /** 终态证据 idx（D29/D37）：只有更高 idx 的进展才能开启新 episode */
  terminalIdx: number | null;
}

const DEFAULT_FRESH_WAITING_MS = 600_000;
// ponytail: 30s 静默窗是经验值——超长工具步（窗口内无落行）会提前判完成、下一行落库时按新 episode 复活；
// 升级路径是 D26 的 trajectory 级结构解码（waiting_steps/fully_idle）取代 mtime 静默启发式
const DEFAULT_TERMINAL_QUIET_MS = 30_000;

const TERMINAL_STATUS: Partial<Record<SessionStateKind, StopResolution["status"]>> = {
  completed: "completed",
  aborted: "aborted",
  error: "error",
};

export class AntigravityPoller {
  private readonly deps: AntigravityPollerDeps;
  private readonly seen = new Map<string, SeenSession>();
  /** 最近一次成功读取的快照：probe 与 poll 共用同代数据（D28，杜绝 stale probe 清新鲜黄灯） */
  private latest: AntigravitySnapshot | null = null;

  constructor(deps: AntigravityPollerDeps) {
    this.deps = deps;
  }

  /**
   * 终态写静默归一化（D39）：终态观测但库仍在写（mtime 在静默窗内）视为 running——
   * 活跃轨迹的当前步不落行，steps 全 DONE 不代表轨迹结束；静默超窗后维持原终态观测。
   */
  private effectiveObservation(s: SessionSnapshot): SessionObservation {
    const obs = s.observation;
    if (!(obs.kind in TERMINAL_STATUS)) return obs;
    const quiet = this.deps.terminalQuietMs ?? DEFAULT_TERMINAL_QUIET_MS;
    if (this.deps.clock() - s.mtime < quiet) return { ...obs, kind: "running" };
    return obs;
  }

  poll(): void {
    const snap = this.deps.read();
    if (snap === null) return; // 降级/未检测到：状态保留，恢复后继续（D12/D13）
    // 进入 diff/probe 前统一归一化，后续所有判定基于有效观测（poll/probe 同代同语义，D28/D39）
    this.latest = { sessions: snap.sessions.map((s) => ({ ...s, observation: this.effectiveObservation(s) })) };
    for (const s of this.latest.sessions) {
      const prev = this.seen.get(s.sessionId);
      if (!prev) {
        this.baseline(s);
        continue;
      }
      if (s.epoch !== prev.epoch || s.observation.maxIdx < prev.maxIdx) {
        // 库替换/迁移/压缩重置（D29）：静默重新基线，不发终态告警也不发 activity，下轮 diff 接管
        this.remember(s);
        continue;
      }
      this.diff(prev, s);
    }
    // 会话从快照消失：不发事件（消失≠完成，D13）；seen 保留以便重现时 diff 仍成立
  }

  /** 首轮基线与基线后新会话（D20）：running 恢复绿灯，新鲜 waiting 恢复黄灯，历史终态/unknown 静默 */
  private baseline(s: SessionSnapshot): void {
    this.remember(s);
    const kind = s.observation.kind;
    if (kind === "running") {
      this.emit(s.sessionId, "activity", this.deps.clock(), {});
    } else if (kind === "waiting" && this.deps.clock() - s.mtime <= (this.deps.freshWaitingMs ?? DEFAULT_FRESH_WAITING_MS)) {
      // ts 用 mtime：跨重启同一等待的通知 episode 键稳定（D37）
      this.emit(s.sessionId, "user_action_required", s.mtime, {});
    }
  }

  private diff(prev: SeenSession, s: SessionSnapshot): void {
    const obs = s.observation;
    if (obs.kind === "unknown") {
      // 保守（D18）：unknown 不改变已知状态，只推进高水位
      prev.maxIdx = Math.max(prev.maxIdx, obs.maxIdx);
      return;
    }
    if (obs.kind === prev.kind) {
      // running 高水位前进 = 活性证据，刷 lastEventAt 防 inactive 误报；waiting/终态不重发
      if (obs.kind === "running" && obs.maxIdx > prev.maxIdx) {
        this.emit(s.sessionId, "activity", this.deps.clock(), {});
      }
      this.remember(s);
      return;
    }
    // 终态之后的任何转移都要求证据前进（D29/D37）：迟到的元数据写入不复活、历史等待不亮黄
    if (prev.terminalIdx !== null && obs.evidenceIdx <= prev.terminalIdx) return;
    this.remember(s);
    switch (obs.kind) {
      case "running":
        this.emit(s.sessionId, "activity", this.deps.clock(), {});
        return;
      case "waiting":
        this.emit(s.sessionId, "user_action_required", this.deps.clock(), {});
        return;
      default:
        this.emitStop(s, obs.kind);
    }
  }

  /** 终态 stop：ts 用库源 mtime（稳定时间戳，D37——重启后 ack/ignore 标记不失效） */
  private emitStop(s: SessionSnapshot, kind: SessionStateKind): void {
    const status = TERMINAL_STATUS[kind]!;
    const meta: Record<string, unknown> = { status };
    if (status === "completed") {
      // D38：尾问文本由 Antigravity 专用尾部解析带回，事件绝不携带 transcriptPath
      meta.resolvedLastMessage = this.deps.transcriptTail?.(s.sessionId) ?? null;
    }
    this.emit(s.sessionId, "stop", s.mtime, meta);
  }

  private remember(s: SessionSnapshot): void {
    const obs = s.observation;
    this.seen.set(s.sessionId, {
      kind: obs.kind,
      maxIdx: obs.maxIdx,
      epoch: s.epoch,
      terminalIdx: obs.kind in TERMINAL_STATUS ? obs.evidenceIdx : null,
    });
  }

  private emit(sessionId: string, event: TrafficEvent["event"], ts: number, meta: Record<string, unknown>): void {
    this.deps.emit({ v: 3, tool: "antigravity", sessionId, event, ts, meta });
  }

  /**
   * 探针通路（tracker probe 注入）：读 poll 同代的最新成功快照（D28）。
   * running=执行中；waiting=专属挂起；终态带 terminal 保险丝；
   * 会话缺失/unknown/从未成功读取 → null（保留既有状态并标记降级，绝不误清黄灯）。
   */
  probeSnapshot(sessionId: string): ProbeSnapshot | null {
    const s = this.latest?.sessions.find((x) => x.sessionId === sessionId);
    if (!s) return null;
    const neutral: ProbeSnapshot = { pending: { kind: "none" }, executing: false, stuckCandidate: false, missedQuestion: false };
    const kind = s.observation.kind;
    if (kind === "running") return { ...neutral, executing: true };
    if (kind === "waiting") return { ...neutral, pending: { kind: "user_action_pending" } };
    const status = TERMINAL_STATUS[kind];
    if (status) {
      const lastAssistantMessage = status === "completed" ? (this.deps.transcriptTail?.(sessionId) ?? null) : null;
      return { ...neutral, terminal: { status, lastAssistantMessage } };
    }
    return null; // unknown：保守降级（D18/D28）
  }
}
