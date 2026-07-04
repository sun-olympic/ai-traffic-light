// 单会话状态机（design.md D2）：状态转移只依据主 agent 事件（subagent 事件在事件源就不产生）。
// waiting 的进入由外部判定器（DB 探测/审批计时/结尾提问/卡死）调用 setWaiting 驱动，
// 状态机本身只负责合法性（能力降级、软硬黄灯、清除时机）。
import type { CapabilityFlags } from "../adapters/adapter";
import type { TrafficEvent } from "../../shared/events";

export type SessionState = "running" | "waiting" | "failed" | "idle" | "removed";

/** 黄灯子类型：question/approval/user_action 为精确信号（不可忽略），trailing_question/stuck/inactive 为软黄灯（可忽略） */
export type WaitingKind = "question" | "approval" | "user_action" | "trailing_question" | "stuck" | "inactive";

const SOFT_KINDS: ReadonlySet<WaitingKind> = new Set(["trailing_question", "stuck", "inactive"]);

export class SessionMachine {
  readonly tool: string;
  readonly sessionId: string;
  readonly capabilities: CapabilityFlags;

  state: SessionState = "idle";
  waitingKind: WaitingKind | null = null;
  stateSince = 0;
  lastEventAt = 0;

  constructor(tool: string, sessionId: string, capabilities: CapabilityFlags) {
    this.tool = tool;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
  }

  get ignorable(): boolean {
    return this.waitingKind !== null && SOFT_KINDS.has(this.waitingKind);
  }

  private transition(next: SessionState, ts: number): void {
    if (this.state !== next) this.stateSince = ts;
    this.state = next;
    if (next !== "waiting") this.waitingKind = null;
  }

  handle(ev: TrafficEvent): void {
    this.lastEventAt = ev.ts;
    switch (ev.event) {
      case "prompt":
      case "activity":
      case "before_exec":
      case "after_exec":
        // 任何活动事件都把会话拉回 running（覆盖 failed 复活、waiting 清除、removed 复活）
        this.transition("running", ev.ts);
        break;
      case "session_start":
        // 只开了会话未必开始干活（新建聊天页签就会触发）：新会话落灰色空闲态，
        // 已有状态的会话不被 start 重置（避免 Cursor 重载时清掉红灯/黄灯）
        if (this.stateSince === 0) this.stateSince = ev.ts;
        break;
      case "approval_request":
        // 推送型精确审批（schema v2，codex PermissionRequest）：立即亮黄，无阈值/白名单；
        // 清除靠任何后续事件（活动事件回 running、stop 落终态），冷启动首事件即此也成立
        this.setWaiting("approval", ev.ts);
        break;
      case "user_action_required":
        // 推送型泛化用户操作等待（schema v3，qoder ActionRequired）：语义同 approval 但非命令审批
        this.setWaiting("user_action", ev.ts);
        break;
      case "stop": {
        const status = ev.meta.status;
        // error = 工具明确上报的异常；aborted 是否算失败按能力声明：Cursor 的 aborted 外部不可区分
        // 是否异常（手动停止与断网中止同报），统一亮红交用户决策；codex 的 aborted 明确是用户
        // 中断/拒绝审批，声明 redIncludesAborted=false 落 idle。其余状态（completed/unknown 等）落 idle。
        const abortedIsRed = status === "aborted" && this.capabilities.redIncludesAborted !== false;
        if ((status === "error" || abortedIsRed) && this.capabilities.red === "exact") {
          this.transition("failed", ev.ts);
        } else {
          this.transition("idle", ev.ts);
        }
        break;
      }
      case "session_end":
        this.transition("removed", ev.ts);
        break;
    }
  }

  /** 外部判定器设置黄灯；按能力降级（yellow=none 永不进 waiting） */
  setWaiting(kind: WaitingKind, ts: number = Date.now()): void {
    if (this.capabilities.yellow === "none") return;
    this.transition("waiting", ts);
    this.waitingKind = kind;
  }

  /** 外部判定器清除黄灯（探测到挂起已结束），回到 running */
  clearWaiting(ts: number = Date.now()): void {
    if (this.state !== "waiting") return;
    this.transition("running", ts);
  }

  /** 忽略软黄灯（结尾提问/疑似卡死）；精确黄灯不可忽略 */
  ignoreWaiting(ts: number = Date.now()): void {
    if (this.state !== "waiting" || !this.ignorable) return;
    this.transition("idle", ts);
  }

  /** 红灯手动知悉 */
  acknowledgeFailure(ts: number = Date.now()): void {
    if (this.state !== "failed") return;
    this.transition("idle", ts);
  }
}
