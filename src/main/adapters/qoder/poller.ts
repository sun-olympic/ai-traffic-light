// Qoder 轮询 diff 管道（add-qoder-support D2/D8）：周期读快照、与上次状态比对，
// 仅在状态转移时产出标准化事件（内存直投 tracker，不写 events.jsonl——隐私边界 D6 的最彻底满足，
// 冷启动状态每次由基线重建，比回放历史事件更准）。
import type { TrafficEvent } from "../../../shared/events";
import type { ProbeSnapshot, StopResolution } from "../adapter";
import type { QoderSnapshot, QoderStatus, QoderTask } from "./snapshot-reader";

export interface QoderPollerDeps {
  /** 读取当前快照；null = 未检测到/降级（本轮跳过，基线保留） */
  read: () => QoderSnapshot | null;
  emit: (ev: TrafficEvent) => void;
  clock: () => number;
  /** 任务本地 transcript 路径解析（尾问检测用）；null = 无本地记录（远程任务等），跳过尾问 */
  transcriptPath?: (taskId: string) => string | null;
}

interface SeenTask {
  status: QoderStatus;
  updatedAt: number;
}

const TERMINAL: Record<string, StopResolution["status"]> = { completed: "completed", stopped: "aborted", error: "error" };

export class QoderPoller {
  private readonly deps: QoderPollerDeps;
  private baselined = false;
  private readonly seen = new Map<string, SeenTask>();
  private latest: QoderSnapshot | null = null;

  constructor(deps: QoderPollerDeps) {
    this.deps = deps;
  }

  /** 最近一次成功轮询里该会话的任务信息（显示名用；不额外触发 IO） */
  taskInfo(sessionId: string): { taskId: string; workspacePath: string | null; displayName: string | null } | null {
    const t = this.latest?.tasks.find((x) => x.canonicalId === sessionId);
    return t ? { taskId: t.taskId, workspacePath: t.workspacePath, displayName: t.displayName } : null;
  }

  poll(): void {
    const snap = this.deps.read();
    if (snap === null) return; // 降级/未检测到：基线与已见状态保留，恢复后继续 diff
    this.latest = snap;
    if (!this.baselined) {
      // 启动基线（D2）：活跃任务恢复可见状态，历史终态静默——不为几小时前的 error 制造新红灯
      for (const t of snap.tasks) {
        this.seen.set(t.canonicalId, { status: t.status, updatedAt: t.updatedAt });
        this.emitForStatus(t, true);
      }
      this.baselined = true;
      return;
    }
    for (const t of snap.tasks) {
      const prev = this.seen.get(t.canonicalId);
      this.seen.set(t.canonicalId, { status: t.status, updatedAt: t.updatedAt });
      if (!prev) {
        // 基线后新任务：按当前状态发事件（新任务出现即终态视同历史，静默）
        this.emitForStatus(t, true);
        continue;
      }
      if (prev.status !== t.status) {
        this.emitForStatus(t, false);
        continue;
      }
      // 状态未变：running 任务快照时间前进 = 活性证据，刷 lastEventAt 防 inactive 误报；
      // user_action 等待不发 activity（会误清黄灯）；终态任务的时间变化不复活会话（ai_tracker 类活动不算状态）
      if (t.status === "running" && t.updatedAt > prev.updatedAt) {
        this.emit(t.canonicalId, "activity", {});
      }
    }
    // 任务从快照消失：不视为完成也不发事件（spec：Disappearing task is not assumed complete），
    // 会话由 inactive 兜底提醒 + 既有 GC 回收；保留 seen 以便任务重现时 diff 仍成立
  }

  /** 按任务当前状态发事件；silentTerminal 时终态与 unknown 均静默（基线/新任务场景） */
  private emitForStatus(t: QoderTask, silentTerminal: boolean): void {
    switch (t.status) {
      case "running":
        this.emit(t.canonicalId, "activity", {});
        return;
      case "user_action":
        this.emit(t.canonicalId, "user_action_required", {});
        return;
      case "unknown":
        return; // D4：unknown 保守不动
      default: {
        if (silentTerminal) return;
        const meta: Record<string, unknown> = { status: TERMINAL[t.status] };
        if (t.status === "completed") {
          const p = this.deps.transcriptPath?.(t.taskId) ?? null;
          if (p) meta.transcriptPath = p;
        }
        this.emit(t.canonicalId, "stop", meta);
      }
    }
  }

  private emit(sessionId: string, event: TrafficEvent["event"], meta: Record<string, unknown>): void {
    this.deps.emit({ v: 3, tool: "qoder", sessionId, event, ts: this.deps.clock(), meta });
  }

  /**
   * 探针通路（tracker probe 注入）：读最新快照按 canonical id 定位任务。
   * running=执行中（防审批/卡死误报）；user_action=专属挂起；终态带 terminal 保险丝（diff 事件丢失兜底）；
   * 任务缺失返回中性快照（不误标降级）；读取失败返回 null（真降级）。
   */
  probeSnapshot(sessionId: string): ProbeSnapshot | null {
    const snap = this.deps.read();
    if (snap === null) return null;
    const t = snap.tasks.find((x) => x.canonicalId === sessionId);
    const neutral: ProbeSnapshot = { pending: { kind: "none" }, executing: false, stuckCandidate: false, missedQuestion: false };
    if (!t) return neutral;
    if (t.status === "running") return { ...neutral, executing: true };
    if (t.status === "user_action") return { ...neutral, pending: { kind: "user_action_pending" } };
    const terminal = TERMINAL[t.status];
    if (terminal) return { ...neutral, terminal: { status: terminal, lastAssistantMessage: null } };
    return neutral; // unknown
  }
}
