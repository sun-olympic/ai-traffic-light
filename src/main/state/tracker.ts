// 多会话跟踪编排器：事件驱动状态机 + 周期 tick 驱动黄灯判定/GC/存活检测（design.md D2/D2a/D2b/D2c/D2d/D5）。
// 依赖全部注入（时钟/探针快照/进程存活/transcript 读取/提醒/持久化标记），保证可单测。
// v2：能力表注册制（App 启动注册 adapter 列表），探针通路工具无关（ProbeSnapshot），
// Cursor 专属的气泡判定已下沉到 adapters/cursor/bubble-judge。
import type { AppConfig } from "../../shared/config";
import type { TrafficEvent } from "../../shared/events";
import type { CapabilityFlags, MissedReason, ProbeSnapshot, StopResolution, UserActionBlocker } from "../adapters/adapter";
import { SessionMachine, type SessionState, type WaitingKind } from "./session-machine";
import { isTrailingQuestion, lastAssistantText } from "./trailing-question";

export type NotifyKind = "waiting" | "failed" | "missed_question";

export interface SessionView {
  tool: string;
  sessionId: string;
  state: SessionState;
  waitingKind: WaitingKind | null;
  waitingCause: UserActionBlocker["source"] | null;
  missedQuestion: boolean;
  /** 错过提问的具体原因（无标记或旧版标记无原因时为 null） */
  missedReason: MissedReason | null;
  note: "tool_exited" | null;
  stateSince: number;
  lastEventAt: number;
}

export interface TrackerDeps {
  config: AppConfig;
  clock: () => number;
  /** 已注册 adapter 的能力表（App 启动装配）；未注册工具按 none 能力兜底 */
  registry: Record<string, CapabilityFlags>;
  /** 定向探测某会话的工具无关快照；null = 探针通道不可用（降级） */
  probe: (tool: string, sessionId: string) => ProbeSnapshot | null;
  /** 工具外部的系统级用户输入阻塞源；tracker 负责归属到最可能的运行中会话 */
  externalUserAction?: () => UserActionBlocker | null;
  isToolAlive: (tool: string) => boolean;
  readTranscript: (path: string) => string | null;
  /** 无状态 stop 的终态解析（codex 回读 rollout 尾部）；null = 解析失败（兜底 completed） */
  resolveStop?: (tool: string, sessionId: string, transcriptPath: string | undefined) => StopResolution | null;
  notify: (kind: NotifyKind, session: SessionView) => void;
  /** 持久化标记存储（知悉/忽略/错过提问），App 层落盘 */
  marks: Map<string, string>;
}

interface PendingExec {
  ts: number;
  kind: string;
  command?: string;
  toolName?: string;
}

interface Tracked {
  machine: SessionMachine;
  pendingExec: PendingExec | null;
  stuckSince: number | null;
  lastStopTs: number;
  note: "tool_exited" | null;
  /** 睡眠唤醒时间：inactive 判定基准取 max(lastEventAt, wakeResetAt)，防睡眠时长误算为无活动 */
  wakeResetAt: number;
  /** 过渡窗口提问（tentative）首次探测到的时间，持续超过确认期才亮黄 */
  askTentativeSince: number | null;
  /** 探针变更令牌与最近变更时刻：变化 = 工具状态库仍在产出（思考分批落库也算活性） */
  lastToken: string | null;
  lastTokenChangeAt: number;
  /** 作答即清后的错过提问补查窗口截止（气泡落盘滞后，作答与自动跳过要等落盘才可分辨） */
  missedCheckUntil: number;
  /** 外部用户操作阻塞源（如系统弹窗）归属到本会话时的 blocker key */
  externalUserActionKey: string | null;
  waitingCause: UserActionBlocker["source"] | null;
}

/** tentative 提问确认期：气泡建库比弹窗展示早约 2s，短于此时长不亮黄；4s 实测偏晚 */
const ASK_TENTATIVE_CONFIRM_MS = 2000;

/**
 * 作答即清后的错过提问补查窗口：清灯依据 headers（作答后 ~3s 翻转），但 accepted/自动跳过
 * 要等气泡落盘（实测常随下一个工具调用批量写入，思考越久越晚）才可分辨。
 * ponytail: 窗口内若事件流一直不静默则探针不跑、补查可能漏掉——错过提问本就是尽力而为的辅助标记
 */
const MISSED_CHECK_WINDOW_MS = 120_000;

const NO_CAPABILITIES: CapabilityFlags = { yellow: "none", red: "none", metadata: false };

const markKey = {
  ignore: (tool: string, sid: string, stopTs: number) => `ignore:${tool}:${sid}:${stopTs}`,
  ack: (tool: string, sid: string, stopTs: number) => `ack:${tool}:${sid}:${stopTs}`,
  missed: (tool: string, sid: string) => `missed:${tool}:${sid}`,
};

export class SessionTracker {
  private readonly deps: TrackerDeps;
  private readonly tracked = new Map<string, Tracked>();
  private readonly backgroundIgnored = new Set<string>();
  private readonly notified = new Set<string>();
  private readonly externalUserActionOwners = new Map<string, string>();
  /** 按工具记录探针降级：混合会话下 Cursor DB 挂了不能被同 tick 的 Codex 探测成功掩盖 */
  private readonly degradedTools = new Set<string>();

  constructor(deps: TrackerDeps) {
    this.deps = deps;
  }

  private key(tool: string, sid: string): string {
    return `${tool}:${sid}`;
  }

  private get config(): AppConfig {
    return this.deps.config;
  }

  handleEvent(ev: TrafficEvent): void {
    // 无状态 stop（codex）：终态解析器补齐 status 后再走既有 stop 分支
    if (ev.event === "stop" && ev.meta.status === undefined) {
      const r = this.deps.resolveStop ? this.deps.resolveStop(ev.tool, ev.sessionId, ev.meta.transcriptPath as string | undefined) : undefined;
      if (r === null) {
        // 解析不到终态 = rollout 尚未落盘（5.1 实测：Stop hook 先于 task_complete flush 几毫秒）。
        // 丢弃本次 stop 保持 running，D4 probe 保险丝下个 tick 会合成带完整终态与结尾文本的 stop；
        // rollout 永久不可读的极端情况由 inactive 兜底提醒，不会红灯误报。
        return;
      }
      ev = { ...ev, meta: { ...ev.meta, status: r?.status ?? "completed", ...(r ? { resolvedLastMessage: r.lastAssistantMessage } : {}) } };
    }
    const k = this.key(ev.tool, ev.sessionId);
    if (this.backgroundIgnored.has(k)) return;
    if (ev.event === "session_start" && ev.meta.isBackgroundAgent === true && !this.config.includeBackgroundAgents) {
      this.backgroundIgnored.add(k);
      return;
    }

    let t = this.tracked.get(k);
    if (!t) {
      const caps = this.deps.registry[ev.tool] ?? NO_CAPABILITIES;
      t = {
        machine: new SessionMachine(ev.tool, ev.sessionId, caps),
        pendingExec: null,
        stuckSince: null,
        lastStopTs: 0,
        note: null,
        wakeResetAt: 0,
        askTentativeSince: null,
        lastToken: null,
        lastTokenChangeAt: 0,
        missedCheckUntil: 0,
        externalUserActionKey: null,
        waitingCause: null,
      };
      this.tracked.set(k, t);
    }
    t.note = null;
    // 任何新事件清除进行中的等待计时（审批拒绝场景 + stop 清空）
    if (ev.event !== "before_exec") t.pendingExec = null;
    // 任何事件都是活性证据：卡死计时归零（卡死只兜底 hooks 完全静默 + 气泡长期 loading 的场景，
    // 高频读写文件时最新气泡几乎总在 loading，不清零会在活跃会话上累积成误报）
    t.stuckSince = null;

    t.machine.handle(ev);

    if (ev.event === "user_action_required") {
      t.waitingCause = ev.meta.source === "system_dialog" ? "system_dialog" : null;
      t.externalUserActionKey = typeof ev.meta.blockerKey === "string" ? ev.meta.blockerKey : null;
    } else if (t.machine.state !== "waiting") {
      t.waitingCause = null;
      t.externalUserActionKey = null;
    }

    if (ev.event === "before_exec") {
      t.pendingExec = { ts: ev.ts, kind: String(ev.meta.kind ?? "shell"), command: ev.meta.command as string | undefined, toolName: ev.meta.toolName as string | undefined };
    }

    if (ev.event === "stop") {
      t.lastStopTs = ev.ts;
      const status = ev.meta.status;
      if (t.machine.state === "failed") {
        // 回放时依据持久化知悉标记熄灭红灯（error 与 aborted 同路径）
        if (this.deps.marks.has(markKey.ack(ev.tool, ev.sessionId, ev.ts))) {
          t.machine.acknowledgeFailure(ev.ts);
        }
      } else if (status === "completed") {
        this.judgeTrailingQuestion(t, ev);
      }
    }

    if (t.machine.state === "removed") this.tracked.delete(k);
    this.emitTransitions(t);
  }

  private judgeTrailingQuestion(t: Tracked, ev: TrafficEvent): void {
    if (this.deps.marks.has(markKey.ignore(ev.tool, ev.sessionId, ev.ts))) return;
    // resolver 路径（codex）：结尾文本随终态一起解析，不走 Cursor transcript 格式解析器（对 rollout 会静默返回 null）
    if ("resolvedLastMessage" in ev.meta) {
      const msg = ev.meta.resolvedLastMessage;
      if (typeof msg === "string" && isTrailingQuestion(msg, this.config.questionWords)) {
        t.machine.setWaiting("trailing_question", ev.ts);
      }
      return;
    }
    const path = ev.meta.transcriptPath;
    if (typeof path !== "string" || !path) return;
    const jsonl = this.deps.readTranscript(path);
    if (jsonl === null) return; // 读取失败回退 idle（machine 已是 idle）
    const text = lastAssistantText(jsonl);
    if (text !== null && isTrailingQuestion(text, this.config.questionWords)) {
      t.machine.setWaiting("trailing_question", ev.ts);
    }
  }

  /** 周期驱动（建议 2~5s 一次）：GC、存活检测、黄灯探测、卡死计时 */
  tick(): void {
    const now = this.deps.clock();
    const externalAction = this.deps.externalUserAction?.() ?? null;
    if (!externalAction) this.externalUserActionOwners.clear();
    const externalOwnerKey = externalAction ? this.resolveExternalUserActionOwner(externalAction) : null;

    for (const [k, t] of this.tracked) {
      if (now - t.machine.lastEventAt > this.config.sessionGcMs) {
        this.tracked.delete(k);
        // 常驻进程防泄漏：会话回收时同步清掉它的提醒去重记录
        for (const e of this.notified) if (e.startsWith(`${k}:`)) this.notified.delete(e);
        continue;
      }
      // 事件到达本身就是存活证据：ps 缓存有一个刷新周期的盲区（codex CLI 刚启动时缓存仍是"未运行"），
      // 刚收到事件的会话豁免 tool_exited 判定，防止竞态把审批黄灯清成 idle
      const recentEvent = now - t.machine.lastEventAt < this.config.livenessIntervalMs + 5_000;
      if (!recentEvent && !this.deps.isToolAlive(t.machine.tool)) {
        // 只自动清 running/waiting（等待已无意义）；failed 红灯保留到用户知悉，防止用户还没看到异常就被静默清掉
        if (t.machine.state === "running" || t.machine.state === "waiting") {
          t.machine.clearWaiting(now);
          // 工具进程退出不算中断异常（用户主动关闭 Cursor 是常态），用 unknown 落 idle 而非红灯
          if (t.machine.state === "running") t.machine.handle({ v: 1, tool: t.machine.tool, sessionId: t.machine.sessionId, event: "stop", ts: t.machine.lastEventAt, meta: { status: "unknown" } });
          t.note = "tool_exited";
          t.pendingExec = null;
          t.stuckSince = null;
        }
        continue;
      }
      this.tickSession(t, now, k === externalOwnerKey ? externalAction : null);
      this.emitTransitions(t);
    }
  }

  private resolveExternalUserActionOwner(action: UserActionBlocker): string | null {
    const existing = this.externalUserActionOwners.get(action.key);
    if (existing) {
      const t = this.tracked.get(existing);
      if (t && (t.machine.state === "running" || (t.machine.state === "waiting" && t.externalUserActionKey === action.key))) {
        return existing;
      }
    }

    const candidates = [...this.tracked.entries()].filter(([, t]) => t.machine.tool !== "system" && t.machine.state === "running");
    const pendingExec = candidates
      .filter(([, t]) => t.pendingExec !== null)
      .sort((a, b) => (b[1].pendingExec!.ts - a[1].pendingExec!.ts) || (b[1].machine.lastEventAt - a[1].machine.lastEventAt));
    const selected = (pendingExec[0] ?? candidates.sort((a, b) => b[1].machine.lastEventAt - a[1].machine.lastEventAt)[0])?.[0] ?? null;
    if (selected) this.externalUserActionOwners.set(action.key, selected);
    return selected;
  }

  private tickSession(t: Tracked, now: number, externalAction: UserActionBlocker | null = null): void {
    const m = t.machine;
    if (m.state !== "running" && m.state !== "waiting") return;

    if (externalAction) {
      m.setWaiting("user_action", now);
      t.waitingCause = externalAction.source;
      t.externalUserActionKey = externalAction.key;
      t.stuckSince = null;
      return;
    }
    if (m.state === "waiting" && m.waitingKind === "user_action" && t.externalUserActionKey !== null) {
      t.waitingCause = null;
      t.externalUserActionKey = null;
      m.clearWaiting(now);
      return;
    }

    // 同 tick 内探测结果复用（审批分支已查过就不再查第二次，探测是同步 DB/文件 IO）
    let snap: ProbeSnapshot | null | undefined;

    // 审批等待：before_exec 后静默超阈值且不在白名单
    if (m.state === "running" && t.pendingExec && now - t.pendingExec.ts > this.config.approvalThresholdMs && !this.isWhitelisted(t.pendingExec)) {
      snap = this.probe(t);
      // 探针明确显示执行中 → 慢命令而非等审批，不亮黄，逐 tick 复查；
      // 真审批的 pending 字段有 ~15s 写入延迟（早期同样显示执行中），翻转后下个 tick 即亮黄；
      // 通道降级/证据不足 → 维持启发式亮黄（宁可误报不漏报）。
      // 例外（2026-07-05 实测误报）：headers 弹窗标志明确 false = 无任何弹窗（自动运行的长命令），
      // 不亮启发式黄——真审批弹窗 ~3s 内翻 true 远小于阈值；气泡 pending 落盘后仍走下方精确路径兜底
      if (!snap?.executing && snap?.blockingPending !== false) {
        m.setWaiting("approval", now);
        return;
      }
    }

    const quiet = now - m.lastEventAt > this.config.quietBeforeProbeMs;
    // waiting(approval/user_action) 也需探测：推送事件可能丢失，清灯/终态靠 probe 保险丝
    const needProbe = (m.state === "running" && quiet) || (m.state === "waiting" && (m.waitingKind === "question" || m.waitingKind === "stuck" || m.waitingKind === "approval" || m.waitingKind === "user_action"));
    if (!needProbe) return;

    if (snap === undefined) snap = this.probe(t);
    if (snap === null) {
      // 探针通道降级：精确黄灯停用，仅保留无活动兜底
      this.judgeInactive(t, now);
      return;
    }

    // D4 保险丝：会话已达终态但 stop 未到（codex 中断/错误/拒绝审批无 Stop hook）→ 注入合成 stop
    if (snap.terminal) {
      this.handleEvent({
        v: 2,
        tool: m.tool,
        sessionId: m.sessionId,
        event: "stop",
        ts: now,
        meta: { status: snap.terminal.status, resolvedLastMessage: snap.terminal.lastAssistantMessage, synthetic: true },
      });
      return;
    }

    // 作答即清后的错过提问补查：清灯时气泡尚未落盘，落盘后才能分辨 accepted 与自动跳过
    if (t.missedCheckUntil > 0) {
      if (snap.missedQuestion) {
        t.missedCheckUntil = 0;
        this.markMissed(m, now, snap.missedReason);
      } else if (now > t.missedCheckUntil) {
        t.missedCheckUntil = 0;
      }
    }

    const pending = snap.pending;
    if (m.state === "waiting" && m.waitingKind === "question" && pending.kind !== "question_pending") {
      // 提问结束：检查是否被自动处理（错过提问）
      if (snap.missedQuestion) this.markMissed(m, now, snap.missedReason);
      m.clearWaiting(now);
      return;
    }
    // 作答即清（2026-07-05 实测）：作答标记随 Cursor 惰性批量落库，思考期间气泡长期滞留 pending；
    // headers 的 blocking 在作答后 ~3s 翻 false，且检查点/令牌必有一次变更。要求"令牌在黄灯亮起
    // 之后变过"排除 headers 尚未写入 blocking=true 的窗口（那时令牌停在提问之前）。
    if (m.state === "waiting" && m.waitingKind === "question" && snap.blockingPending === false && t.lastTokenChangeAt > m.stateSince) {
      t.missedCheckUntil = now + MISSED_CHECK_WINDOW_MS;
      m.clearWaiting(now);
      return;
    }
    if (pending.kind === "question_pending" && pending.tentative) {
      t.askTentativeSince ??= now;
      if (now - t.askTentativeSince < ASK_TENTATIVE_CONFIRM_MS) return;
    } else {
      t.askTentativeSince = null;
    }
    if (pending.kind === "question_pending") {
      m.setWaiting("question", now);
      return;
    }
    if (pending.kind === "approval_pending") {
      m.setWaiting("approval", now);
      return;
    }
    // user_action（qoder）：探针即快照实况，直接亮/清（清灯回 running 由下方统一处理）
    if (pending.kind === "user_action_pending") {
      t.waitingCause = null;
      t.externalUserActionKey = null;
      m.setWaiting("user_action", now);
      return;
    }
    if (m.state === "waiting" && m.waitingKind === "user_action") {
      t.waitingCause = null;
      t.externalUserActionKey = null;
      m.clearWaiting(now);
      return;
    }

    // 疑似卡死：探针持续报告卡死候选超阈值。
    // pendingExec 活跃期间豁免（2026-07-05 实测误报）：hooks 已确认命令在执行，气泡 loading
    // 是预期状态而非卡死证据；真挂死（after_exec 永不到达）由 judgeInactive 5min 兜底
    if (snap.stuckCandidate && !t.pendingExec) {
      t.stuckSince ??= now;
      if (now - t.stuckSince > this.config.stuckThresholdMs) {
        m.setWaiting("stuck", now);
      }
    } else {
      t.stuckSince = null;
      if (m.state === "waiting" && m.waitingKind === "stuck") {
        m.clearWaiting(now);
        return; // 本 tick 已有转换，无活动兜底下轮再判
      }
      this.judgeInactive(t, now);
    }
  }

  /**
   * 兜底判定：running 且长时间无任何事件（turn 挂起等后台任务、stop 未触发等），对用户与卡死无异，软黄灯提醒。
   * 令牌变更时刻计入基准：长思考零 hook 事件，但思考文本会分批落库（2026-07-05 实测），不算无活动
   */
  private judgeInactive(t: Tracked, now: number): void {
    const m = t.machine;
    if (m.state !== "running") return;
    if (now - Math.max(m.lastEventAt, t.wakeResetAt, t.lastTokenChangeAt) > this.config.inactiveThresholdMs) {
      m.setWaiting("inactive", now);
    }
  }

  private probe(t: Tracked): ProbeSnapshot | null {
    const m = t.machine;
    const snap = this.deps.probe(m.tool, m.sessionId);
    // 随最近一次探测结果实时刷新：通道恢复（如后启动的 Cursor/Codex 建好库）后自动解除降级
    if (snap === null) {
      this.degradedTools.add(m.tool);
      return null;
    }
    this.degradedTools.delete(m.tool);
    // 令牌变更 = 状态库仍在产出（思考分批落库也算）：刷新活性时刻并重置卡死计时。
    // 首次观测只建基线不计时，避免冷启动首个探测被当成活动
    if (snap.changeToken !== undefined && snap.changeToken !== t.lastToken) {
      if (t.lastToken !== null) {
        t.lastTokenChangeAt = this.deps.clock();
        t.stuckSince = null;
      }
      t.lastToken = snap.changeToken;
    }
    return snap;
  }

  private isWhitelisted(pe: PendingExec): boolean {
    if (pe.kind === "mcp") return pe.toolName !== undefined && this.config.mcpWhitelist.includes(pe.toolName);
    return pe.command !== undefined && this.config.shellWhitelist.some((w) => pe.command!.includes(w));
  }

  /** 标记值格式 "<ts>|<reason>"；旧版纯时间戳兼容（解析侧宽容） */
  private markMissed(m: SessionMachine, now: number, reason?: MissedReason): void {
    this.deps.marks.set(markKey.missed(m.tool, m.sessionId), `${now}|${reason ?? "unanswered"}`);
    this.deps.notify("missed_question", this.viewOf(m.tool, m.sessionId)!);
  }

  private missedReasonOf(tool: string, sid: string): MissedReason | null {
    const v = this.deps.marks.get(markKey.missed(tool, sid));
    if (v === undefined) return null;
    const reason = v.split("|")[1];
    return reason === "dismissed" ? "dismissed" : "unanswered";
  }

  /** 状态进入 waiting/failed 时提醒（同会话同一次进入不重复） */
  private emitTransitions(t: Tracked): void {
    const m = t.machine;
    if (m.state !== "waiting" && m.state !== "failed") return;
    const episode = `${m.tool}:${m.sessionId}:${m.state}:${m.waitingKind ?? ""}:${m.stateSince}`;
    if (this.notified.has(episode)) return;
    this.notified.add(episode);
    this.deps.notify(m.state === "waiting" ? "waiting" : "failed", this.viewOf(m.tool, m.sessionId)!);
  }

  // ---- 用户操作 ----

  ignoreWaiting(tool: string, sid: string): void {
    const t = this.tracked.get(this.key(tool, sid));
    if (!t || t.machine.state !== "waiting" || !t.machine.ignorable) return;
    if (t.machine.waitingKind === "trailing_question") {
      this.deps.marks.set(markKey.ignore(tool, sid, t.lastStopTs), String(this.deps.clock()));
    }
    t.machine.ignoreWaiting(this.deps.clock());
  }

  acknowledgeFailure(tool: string, sid: string): void {
    const t = this.tracked.get(this.key(tool, sid));
    if (!t || t.machine.state !== "failed") return;
    this.deps.marks.set(markKey.ack(tool, sid, t.lastStopTs), String(this.deps.clock()));
    t.machine.acknowledgeFailure(this.deps.clock());
  }

  clearMissedMark(tool: string, sid: string): void {
    this.deps.marks.delete(markKey.missed(tool, sid));
  }

  /**
   * 冷启动回放后调用：历史遗留的等待黄灯降级为灰点。
   * 回放会复活几小时前的 approval/trailing_question——用户早已在工具里处理过，且会话进程
   * 多半不在了（按工具粒度的存活检测清不掉），重现只会制造一排来历不明的黄灯。
   * failed 红灯不动：需要用户显式知悉，跨重启保留是既有设计（ack 标记去重）。
   */
  expireStaleWaiting(olderThanMs: number): void {
    const now = this.deps.clock();
    for (const t of this.tracked.values()) {
      if (t.machine.state !== "waiting") continue;
      if (now - t.machine.lastEventAt < olderThanMs) continue;
      t.machine.handle({ v: 1, tool: t.machine.tool, sessionId: t.machine.sessionId, event: "stop", ts: t.machine.lastEventAt, meta: { status: "unknown" } });
    }
  }

  /** 睡眠唤醒后重置进行中的等待/卡死/无活动计时，防止睡眠时长虚增误报 */
  resetTimersOnWake(): void {
    const now = this.deps.clock();
    for (const t of this.tracked.values()) {
      if (t.pendingExec) t.pendingExec.ts = now;
      if (t.stuckSince !== null) t.stuckSince = now;
      t.wakeResetAt = now;
    }
  }

  // ---- 查询 ----

  /** 探针通道降级：指定 tool 查单通道（设置页分区显示），缺省查任一通道（灯体降级角标） */
  dbDegraded(tool?: string): boolean {
    return tool ? this.degradedTools.has(tool) : this.degradedTools.size > 0;
  }

  private viewOf(tool: string, sid: string): SessionView | null {
    const t = this.tracked.get(this.key(tool, sid));
    if (!t) return null;
    return {
      tool,
      sessionId: sid,
      state: t.machine.state,
      waitingKind: t.machine.waitingKind,
      waitingCause: t.waitingCause,
      missedQuestion: this.deps.marks.has(markKey.missed(tool, sid)),
      missedReason: this.missedReasonOf(tool, sid),
      note: t.note,
      stateSince: t.machine.stateSince,
      lastEventAt: t.machine.lastEventAt,
    };
  }

  sessions(): SessionView[] {
    return [...this.tracked.values()].map((t) => this.viewOf(t.machine.tool, t.machine.sessionId)!);
  }

  aggregate(): { color: "yellow" | "red" | "green" | "off"; counts: Record<SessionState, number> } {
    const counts: Record<SessionState, number> = { running: 0, waiting: 0, failed: 0, idle: 0, removed: 0 };
    for (const t of this.tracked.values()) counts[t.machine.state]++;
    const color = counts.waiting > 0 ? "yellow" : counts.failed > 0 ? "red" : counts.running > 0 ? "green" : "off";
    return { color, counts };
  }
}
