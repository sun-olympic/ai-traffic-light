// Adapter 能力模型（design.md D7）：每个 AI 工具一个 adapter，状态机与 UI 按能力声明降级
import type { TrafficEvent } from "../../shared/events";

export type YellowCapability = "exact" | "heuristic" | "none";
export type RedCapability = "exact" | "none";

export interface CapabilityFlags {
  yellow: YellowCapability;
  red: RedCapability;
  metadata: boolean;
  /** yellow=exact 的信号来源是事件推送（如 codex approval_request）；此时不要求 probe()（v2 起 exact 与 probe 解绑） */
  yellowPush?: boolean;
  /**
   * aborted 终态是否亮红灯。默认 true（Cursor：手动停止与断网中止外部不可区分，统一亮红交用户决策）；
   * codex 声明 false（turn_aborted 明确是用户中断/拒绝审批，灭灯不算失败）。
   */
  redIncludesAborted?: boolean;
}

export interface CollectorStatus {
  installed: boolean;
  /** 安装损坏细节（条目缺失/脚本版本不符），UI 据此提示一键重装 */
  detail?: string;
}

export interface SessionMetadata {
  name?: string;
  createdAt?: number;
}

/** 工具外部的用户操作阻塞源，例如 macOS Keychain / SecurityAgent 弹窗。 */
export interface UserActionBlocker {
  key: string;
  source: "system_dialog";
  title?: string;
}

/** 精确黄灯探测结果；tentative=过渡窗口判定（气泡刚建、pending 未写），需持续确认后才亮黄 */
export type ProbeResult =
  | { kind: "question_pending"; tentative?: boolean }
  | { kind: "approval_pending"; blockReason?: string }
  | { kind: "user_action_pending" }
  | { kind: "none" }
  | { kind: "db_unavailable" };

/**
 * 错过提问的具体原因：
 * dismissed = 表单被界面重建等意外关闭，作答（含草稿）未提交（2026-07-06 实测事故）；
 * unanswered = 提问结束但用户从未作答（超时/自动处理）。
 */
export type MissedReason = "dismissed" | "unanswered";

/** 工具无关的探针快照（v2 探针通路）：判定器下沉 adapter 内部，tracker 只消费此结构 */
export interface ProbeSnapshot {
  /** 挂起等待判定（提问/审批/无） */
  pending: ProbeResult;
  /** 明确执行中（排除审批启发式误报） */
  executing: boolean;
  /** 疑似卡死候选（时长阈值由 tracker 计时） */
  stuckCandidate: boolean;
  /** 提问已结束且未被采纳（错过提问） */
  missedQuestion: boolean;
  /** 错过提问的具体原因（missedQuestion=true 时携带） */
  missedReason?: MissedReason;
  /** 工具自身的"阻塞对话框挂起"标志（Cursor composerHeaders）；undefined = 通道无此信号 */
  blockingPending?: boolean;
  /**
   * 状态库观测变更令牌（不透明字符串）：跨 tick 变化 = 工具状态库仍在产出
   * （思考文本分批落库也算活性）。tracker 据此实现作答即清、抑制无活动/卡死误报。
   */
  changeToken?: string;
  /**
   * 会话已达终态但状态机未收到 stop（D4 保险丝：codex 中断/错误/拒绝审批均无 Stop hook，
   * probe 读 rollout 尾行发现终态时带回）；tracker 据此注入合成 stop 事件。
   */
  terminal?: StopResolution;
}

/** 无状态 stop 的终态解析结果（design.md D4）：resolver 必须同时带回结尾文本，结尾提问判定不走 Cursor transcript 解析器 */
export interface StopResolution {
  status: "completed" | "aborted" | "error";
  lastAssistantMessage: string | null;
}

export interface ToolAdapter {
  readonly tool: string;
  readonly capabilities: CapabilityFlags;

  /** 采集安装/卸载/状态检测（Cursor: hooks.json 合并） */
  collector: {
    install(): Promise<void>;
    uninstall(): Promise<void>;
    status(): Promise<CollectorStatus>;
  };

  /** 工具进程存活检测 */
  isAlive(): Promise<boolean>;

  /** 精确黄灯探测（可选；yellow="exact" 时 probe 与 yellowPush 至少一路存在，见 validateAdapter） */
  probe?(sessionId: string): Promise<ProbeResult>;

  /** 会话元数据（可选，capabilities.metadata=true 时必须提供） */
  metadata?(sessionId: string): Promise<SessionMetadata | null>;

  /** stop 事件 meta 无 status 时的终态解析（可选；codex 回读 rollout 尾部） */
  stopStatusResolver?(sessionId: string, transcriptPath: string | undefined): Promise<StopResolution>;
}

/** 能力声明与实现一致性校验（注册时调用）；返回问题列表，空数组 = 通过 */
export function validateAdapter(a: ToolAdapter): string[] {
  const problems: string[] = [];
  if (a.capabilities.yellow === "exact" && !a.probe && !a.capabilities.yellowPush) {
    problems.push(`${a.tool}: yellow=exact 需要 probe() 或声明 yellowPush（推送来源）`);
  }
  if (a.capabilities.metadata && !a.metadata) {
    problems.push(`${a.tool}: metadata=true 但未提供 metadata()`);
  }
  return problems;
}

/** 事件流由统一的 events.jsonl 监听器提供，按 event.tool 路由到 adapter；此处仅约定类型 */
export type EventHandler = (ev: TrafficEvent) => void;
