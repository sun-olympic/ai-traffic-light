import { beforeEach, describe, expect, test } from "vitest";
import { SessionTracker, type TrackerDeps } from "./tracker";
import { DEFAULT_CONFIG, type AppConfig } from "../../shared/config";
import type { BubbleRow, ComposerHeader } from "../adapters/cursor/db-reader";
import { snapshotFromBubbles } from "../adapters/cursor/bubble-judge";
import type { TrafficEvent } from "../../shared/events";

let now: number;
let bubbles: BubbleRow[] | null;
let header: ComposerHeader | null;
let alive: boolean;
let transcript: string | null;
let notifications: Array<{ kind: string; sessionId: string }>;
let marks: Map<string, string>;
let externalUserAction: TrackerDeps["externalUserAction"];

function deps(config: Partial<AppConfig> = {}): TrackerDeps {
  return {
    config: { ...DEFAULT_CONFIG, ...config },
    clock: () => now,
    registry: { cursor: { yellow: "exact", red: "exact", metadata: true } },
    // Cursor 探针通路：气泡行 → 工具无关快照（判定器已下沉 Cursor adapter）
    probe: () => snapshotFromBubbles(bubbles, header),
    externalUserAction: () => externalUserAction?.() ?? null,
    isToolAlive: () => alive,
    readTranscript: () => transcript,
    notify: (kind, session) => notifications.push({ kind, sessionId: session.sessionId }),
    marks,
  };
}

function ev(event: TrafficEvent["event"], meta: Record<string, unknown> = {}, sessionId = "s1"): TrafficEvent {
  return { v: 1, tool: "cursor", sessionId, event, ts: now, meta };
}

function bubble(partial: Partial<BubbleRow>): BubbleRow {
  return { key: "k", toolName: null, status: null, userDecision: null, additionalStatus: null, blockReason: null, reviewStatus: null, result: null, ...partial };
}

const PENDING_ASK = [bubble({ toolName: "ask_question", status: "completed", additionalStatus: "pending" })];
const ANSWERED_ASK = [bubble({ toolName: "ask_question", status: "completed", userDecision: "accepted", additionalStatus: "submitted", result: '{"answers":[{"questionId":"q1","selectedOptionIds":["a"]}]}' })];
const EXPIRED_ASK = [bubble({ toolName: "ask_question", status: "completed", userDecision: null, additionalStatus: "expired" })];
/** 2026-07-06 实测事故样本：会话重建把挂起表单自动提交为 accepted，result 只剩 Other 占位无文本 */
const DISMISSED_ASK = [bubble({ toolName: "ask_question", status: "completed", userDecision: "accepted", additionalStatus: "submitted", result: '{"answers":[{"questionId":"q1","selectedOptionIds":["__freeform_other__"]}]}' })];
const PENDING_APPROVAL = [bubble({ toolName: "run_terminal_command_v2", status: "loading", additionalStatus: "pending", blockReason: "Not in allowlist: sudo" })];
const RUNNING_TOOL = [bubble({ toolName: "generate_image", status: "loading", additionalStatus: "cancelled" })];
const DONE_TOOL = [bubble({ toolName: "run_terminal_command_v2", status: "completed", additionalStatus: "success" })];

beforeEach(() => {
  now = 1_783_100_000_000;
  bubbles = [];
  header = null;
  alive = true;
  transcript = null;
  notifications = [];
  marks = new Map();
  externalUserAction = undefined;
});

describe("qoder user_action 通路", () => {
  function qoderDeps(probe: TrackerDeps["probe"]): TrackerDeps {
    return {
      ...deps(),
      registry: { qoder: { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false } },
      probe,
    };
  }
  const qev = (event: TrafficEvent["event"], meta: Record<string, unknown> = {}): TrafficEvent => ({ v: 3, tool: "qoder", sessionId: "task-1.session.execution", event, ts: now, meta });

  test("user_action_required 事件 → waiting(user_action)，同一等待期只通知一次", () => {
    const t = new SessionTracker(qoderDeps(() => null));
    t.handleEvent(qev("activity"));
    t.handleEvent(qev("user_action_required"));
    expect(t.sessions()[0].waitingKind).toBe("user_action");
    t.handleEvent(qev("user_action_required")); // 重复推送不重复通知
    expect(notifications.filter((n) => n.kind === "waiting")).toHaveLength(1);
    t.handleEvent(qev("activity"));
    expect(t.sessions()[0].state).toBe("running");
  });

  test("探针保险丝：waiting(user_action) 但探针已无挂起 → 清灯回 running", () => {
    const t = new SessionTracker(qoderDeps(() => ({ pending: { kind: "none" }, executing: true, stuckCandidate: false, missedQuestion: false })));
    t.handleEvent(qev("user_action_required"));
    now += 1000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("探针保险丝：running 但探针报 user_action_pending → 补亮黄灯", () => {
    const t = new SessionTracker(qoderDeps(() => ({ pending: { kind: "user_action_pending" }, executing: false, stuckCandidate: false, missedQuestion: false })));
    t.handleEvent(qev("activity"));
    now += DEFAULT_CONFIG.quietBeforeProbeMs + 1000;
    t.tick();
    expect(t.sessions()[0].waitingKind).toBe("user_action");
  });

  test("stop(aborted) 按能力声明不红（Stopped 任务落灰）", () => {
    const t = new SessionTracker(qoderDeps(() => null));
    t.handleEvent(qev("activity"));
    t.handleEvent(qev("stop", { status: "aborted" }));
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("stop(error) 亮红灯", () => {
    const t = new SessionTracker(qoderDeps(() => null));
    t.handleEvent(qev("activity"));
    t.handleEvent(qev("stop", { status: "error" }));
    expect(t.sessions()[0].state).toBe("failed");
  });
});

describe("系统弹窗用户操作归属", () => {
  function multiToolDeps(probe: TrackerDeps["probe"]): TrackerDeps {
    return {
      ...deps({ quietBeforeProbeMs: 60_000 }),
      registry: {
        cursor: { yellow: "exact", red: "exact", metadata: true },
        codex: { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false },
      },
      probe,
    };
  }

  const neutralProbe = () => ({ pending: { kind: "none" as const }, executing: true, stuckCandidate: false, missedQuestion: false });
  const cev = (event: TrafficEvent["event"], sessionId: string, ts = now): TrafficEvent => ({ v: 2, tool: "codex", sessionId, event, ts, meta: {} });

  test("运行中的任意工具遇到系统输入弹窗时，从绿灯切到自身黄灯", () => {
    const t = new SessionTracker(multiToolDeps(neutralProbe));
    t.handleEvent(ev("prompt", {}, "cursor-1"));
    now += 1000;
    t.handleEvent(cev("prompt", "codex-1"));

    externalUserAction = () => ({ key: "macos-input-dialog", source: "system_dialog", title: "macOS input prompt" });
    t.tick();

    const rows = t.sessions();
    expect(rows.find((s) => s.tool === "codex")?.waitingKind).toBe("user_action");
    expect(rows.find((s) => s.tool === "codex")?.waitingCause).toBe("system_dialog");
    expect(rows.find((s) => s.tool === "cursor")?.state).toBe("running");
    expect(t.aggregate().color).toBe("yellow");

    externalUserAction = undefined;
    now += 2000;
    t.tick();
    expect(t.sessions().find((s) => s.tool === "codex")?.state).toBe("running");
  });

  test("系统弹窗打开后保持最初归属，不被其他会话后续活动抢走", () => {
    const t = new SessionTracker(multiToolDeps(neutralProbe));
    t.handleEvent(ev("prompt", {}, "cursor-1"));
    now += 1000;
    t.handleEvent(cev("prompt", "codex-1"));
    externalUserAction = () => ({ key: "macos-input-dialog", source: "system_dialog", title: "macOS input prompt" });
    t.tick();

    now += 1000;
    t.handleEvent(ev("activity", {}, "cursor-1"));
    t.tick();

    expect(t.sessions().find((s) => s.tool === "codex")?.waitingKind).toBe("user_action");
    expect(t.sessions().find((s) => s.tool === "cursor")?.state).toBe("running");
  });
});

describe("长时间无活动（inactive）", () => {
  test("running 超过阈值无事件 → waiting(inactive)，可忽略；新事件回 running", () => {
    const t = new SessionTracker(deps({ inactiveThresholdMs: 300_000 }));
    t.handleEvent(ev("prompt"));
    now += 300_001;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("inactive");
    t.ignoreWaiting("cursor", "s1");
    expect(t.sessions()[0].state).toBe("idle");
    t.handleEvent(ev("before_exec", { command: "ls" }));
    expect(t.sessions()[0].state).toBe("running");
  });

  test("阈值内不触发；idle 会话不触发", () => {
    const t = new SessionTracker(deps({ inactiveThresholdMs: 300_000 }));
    t.handleEvent(ev("prompt"));
    now += 299_000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
    t.handleEvent(ev("stop", { status: "completed" }));
    now += 400_000;
    t.tick();
    expect(t.sessions()[0].state).toBe("idle");
  });
});

describe("提问等待精确判定（3.2）", () => {
  test("running 静默 5s 后探测到 pending ask → waiting(question)", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("question");
  });

  test("过渡窗口（loading+null）需持续 2s 确认才亮黄，避免气泡早于弹窗建库导致提前变黄", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = [bubble({ toolName: "ask_question", status: "loading", additionalStatus: null })];
    now += 6000;
    t.tick(); // 首见 tentative：开始计时，不亮黄
    expect(t.sessions()[0].state).toBe("running");
    now += 1000;
    t.tick(); // 1s < 2s 确认期
    expect(t.sessions()[0].state).toBe("running");
    now += 1500;
    t.tick(); // 累计 2.5s > 2s → 亮黄
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("question");
  });

  test("静默不足 5s 不探测", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 3000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("作答后（pending 消失）回 running", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    bubbles = ANSWERED_ASK;
    now += 2000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("DB 不可用（null）→ 不进 waiting，保持 running", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = null;
    now += 6000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
    expect(t.dbDegraded()).toBe(true);
  });
});

describe("错过提问标记（3.2a）", () => {
  test("提问等待中气泡翻转非 accepted → 打标记并提醒，状态不滞留", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    bubbles = EXPIRED_ASK;
    now += 2000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("running");
    expect(s.missedQuestion).toBe(true);
    expect(s.missedReason).toBe("unanswered");
    expect(notifications.some((n) => n.kind === "missed_question")).toBe(true);
  });

  test("表单被意外关闭（accepted 但空答案，2026-07-06 事故回归）→ 打标记 reason=dismissed", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    bubbles = DISMISSED_ASK;
    now += 2000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("running");
    expect(s.missedQuestion).toBe(true);
    expect(s.missedReason).toBe("dismissed");
    expect(notifications.some((n) => n.kind === "missed_question")).toBe(true);
  });

  test("正常作答不打标记", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    bubbles = ANSWERED_ASK;
    now += 2000;
    t.tick();
    expect(t.sessions()[0].missedQuestion).toBe(false);
  });

  test("标记可清除且持久化", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    bubbles = EXPIRED_ASK;
    t.tick();
    t.clearMissedMark("cursor", "s1");
    expect(t.sessions()[0].missedQuestion).toBe(false);
    // 持久化：新 tracker 实例（共享 marks）重放后不复现
    const t2 = new SessionTracker(deps());
    t2.handleEvent(ev("prompt"));
    expect(t2.sessions()[0].missedQuestion).toBe(false);
  });
});

describe("作答即清与令牌活性（Thinking 误报修复）", () => {
  /** 进入 waiting(question)：pending ask + headers 尚未写入（blocking=false、旧 checkpoint） */
  function toQuestionYellow(t: SessionTracker): void {
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    header = { blocking: false, checkpointAt: 100 };
    now += 6000;
    t.tick(); // 令牌基线在本 tick 建立
    expect(t.sessions()[0].waitingKind).toBe("question");
  }

  test("作答即清：气泡仍 pending（落盘滞后），但 blocking=false 且令牌在黄灯后变过 → 立即回 running", () => {
    const t = new SessionTracker(deps());
    toQuestionYellow(t);
    // 弹窗挂起被 headers 观测到（token 变化但 blocking=true → 不清）
    header = { blocking: true, checkpointAt: 100 };
    now += 2000;
    t.tick();
    expect(t.sessions()[0].waitingKind).toBe("question");
    // 作答：blocking 翻 false + checkpoint 前进；气泡仍是 pending（尚未落盘）
    header = { blocking: false, checkpointAt: 200 };
    now += 2000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("headers 未写入窗口不误清：blocking=false 但令牌无变化 → 黄灯保持", () => {
    const t = new SessionTracker(deps());
    toQuestionYellow(t);
    now += 2000;
    t.tick(); // 气泡与 headers 均无变化
    now += 2000;
    t.tick();
    expect(t.sessions()[0].waitingKind).toBe("question");
  });

  test("作答即清后补查错过提问：气泡落盘为非 accepted → 打标记并提醒", () => {
    const t = new SessionTracker(deps());
    toQuestionYellow(t);
    header = { blocking: false, checkpointAt: 200 };
    now += 2000;
    t.tick(); // 作答即清
    expect(t.sessions()[0].state).toBe("running");
    bubbles = EXPIRED_ASK; // 落盘揭示：其实是自动跳过
    now += 2000;
    t.tick();
    expect(t.sessions()[0].missedQuestion).toBe(true);
    expect(notifications.some((n) => n.kind === "missed_question")).toBe(true);
  });

  test("作答即清后补查：正常 accepted 落盘不打标记", () => {
    const t = new SessionTracker(deps());
    toQuestionYellow(t);
    header = { blocking: false, checkpointAt: 200 };
    now += 2000;
    t.tick();
    bubbles = ANSWERED_ASK;
    now += 2000;
    t.tick();
    expect(t.sessions()[0].missedQuestion).toBe(false);
    expect(notifications.some((n) => n.kind === "missed_question")).toBe(false);
  });

  test("长思考不误报无活动：令牌持续变化（思考分批落库）→ 超阈值不亮 inactive", () => {
    const t = new SessionTracker(deps({ inactiveThresholdMs: 10_000 }));
    t.handleEvent(ev("prompt"));
    for (let i = 0; i < 10; i++) {
      bubbles = [bubble({ key: `k${i}`, toolName: null })]; // 思考文本气泡分批落库
      now += 2000;
      t.tick();
    }
    expect(t.sessions()[0].state).toBe("running"); // 20s > 10s 阈值，但令牌一直在动
    // 令牌冻结（真无产出）→ 从最后一次变更起算超阈值才亮
    for (let i = 0; i < 6; i++) {
      now += 2000;
      t.tick();
    }
    expect(t.sessions()[0].waitingKind).toBe("inactive");
  });

  test("思考落库活性重置卡死计时：令牌变化期间 loading 气泡不定罪，冻结后才亮 stuck", () => {
    const t = new SessionTracker(deps({ stuckThresholdMs: 10_000, inactiveThresholdMs: 3600_000 }));
    t.handleEvent(ev("prompt"));
    for (let i = 0; i < 10; i++) {
      // 最新工具气泡 loading（卡死候选）+ 会话 checkpoint 持续前进（仍在产出）
      bubbles = RUNNING_TOOL;
      header = { blocking: false, checkpointAt: 100 + i };
      now += 2000;
      t.tick();
    }
    expect(t.sessions()[0].state).toBe("running");
    for (let i = 0; i < 6; i++) {
      now += 2000;
      t.tick(); // 令牌冻结，12s > 10s 阈值
    }
    expect(t.sessions()[0].waitingKind).toBe("stuck");
  });
});

describe("审批等待判定（3.3）", () => {
  test("before_exec 静默超 15s 且非白名单 → 探测 pending → waiting(approval)", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "sudo rm -rf /tmp/x" }));
    bubbles = PENDING_APPROVAL;
    now += 16000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("approval");
  });

  test("DB 可用但附加状态未写入（证据不足）→ 启发式亮黄（宁可误报不漏报）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "sudo something" }));
    bubbles = [bubble({ toolName: "run_terminal_command_v2", status: "loading", additionalStatus: null })];
    now += 16000;
    t.tick();
    expect(t.sessions()[0].state).toBe("waiting");
    expect(t.sessions()[0].waitingKind).toBe("approval");
  });

  test("白名单命令超阈值不亮黄", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "npm install lodash" }));
    bubbles = RUNNING_TOOL;
    now += 60000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("MCP 按 tool_name 白名单豁免", () => {
    const t = new SessionTracker(deps({ mcpWhitelist: ["slow_search"] }));
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "mcp", toolName: "slow_search" }));
    now += 60000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("慢命令误报排除：气泡明确执行中不亮黄，翻转 pending 后下个 tick 亮黄", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "python3 slow-experiment.py" }));
    bubbles = RUNNING_TOOL; // loading + 非 pending 附加状态 = 确实在执行
    now += 16000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
    bubbles = PENDING_APPROVAL; // 审批 pending 延迟写入后
    now += 2000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("approval");
  });

  // 2026-07-05 实测误报：自动运行的长命令（CI 轮询循环）hooks 静默 + 附加状态未落盘，
  // 15s 后被启发式判成审批。headers 的弹窗标志明确 false = 没有任何弹窗，不应亮黄
  test("自动运行长命令（blocking=false、附加状态未落盘）不亮审批黄", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "for i in $(seq 1 60); do curl ci; sleep 30; done" }));
    bubbles = [bubble({ toolName: "run_terminal_command_v2", status: "loading", additionalStatus: null })];
    header = { blocking: false, checkpointAt: 1 };
    now += 16000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("弹窗标志 true 时启发式照亮（真审批弹窗 ~3s 内翻 true，远小于 15s 阈值）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "sudo something" }));
    bubbles = [bubble({ toolName: "run_terminal_command_v2", status: "loading", additionalStatus: null })];
    header = { blocking: true, checkpointAt: 1 };
    now += 16000;
    t.tick();
    expect(t.sessions()[0].waitingKind).toBe("approval");
  });

  test("blocking=false 但气泡明确 approval_pending → 精确路径仍亮（弹窗标志误报兜底）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "sudo x" }));
    bubbles = PENDING_APPROVAL;
    header = { blocking: false, checkpointAt: 1 };
    now += 16000;
    t.tick();
    expect(t.sessions()[0].waitingKind).toBe("approval");
  });

  test("慢命令复查 tick 内探针只查一次（审批分支结果复用）", () => {
    let probeCalls = 0;
    const d = deps();
    const base = d.probe;
    d.probe = (tool, sid) => {
      probeCalls++;
      return base(tool, sid);
    };
    const t = new SessionTracker(d);
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "python3 slow.py" }));
    bubbles = RUNNING_TOOL;
    now += 16000;
    probeCalls = 0;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
    expect(probeCalls).toBe(1);
  });

  test("任何新事件清除审批等待（覆盖拒绝场景）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "sudo x" }));
    bubbles = PENDING_APPROVAL;
    now += 16000;
    t.tick();
    expect(t.sessions()[0].state).toBe("waiting");
    now += 1000;
    t.handleEvent(ev("after_exec", { kind: "shell", command: "sudo x" }));
    expect(t.sessions()[0].state).toBe("running");
  });

  test("stop 清空等待计时：stop 后不再因旧 before_exec 亮黄", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "sudo x" }));
    now += 2000;
    t.handleEvent(ev("stop", { status: "completed" }));
    bubbles = DONE_TOOL;
    now += 60000;
    t.tick();
    expect(t.sessions()[0].state).toBe("idle");
  });
});

describe("结尾提问判定（3.3a）", () => {
  test("stop(completed) 且结尾提问 → waiting(trailing_question)", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    transcript = JSON.stringify({ role: "assistant", content: "改完了。要不要我继续优化性能？" });
    t.handleEvent(ev("stop", { status: "completed", transcriptPath: "/tmp/t.jsonl" }));
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("trailing_question");
  });

  test("结尾陈述 → idle", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    transcript = JSON.stringify({ role: "assistant", content: "全部完成。" });
    t.handleEvent(ev("stop", { status: "completed", transcriptPath: "/tmp/t.jsonl" }));
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("transcript 读取失败回退 idle", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    transcript = null;
    t.handleEvent(ev("stop", { status: "completed", transcriptPath: "/tmp/t.jsonl" }));
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("忽略后转 idle 且回放不复亮（标记持久化）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    transcript = JSON.stringify({ role: "assistant", content: "选哪个方案？" });
    const stopEv = ev("stop", { status: "completed", transcriptPath: "/tmp/t.jsonl" });
    t.handleEvent(stopEv);
    t.ignoreWaiting("cursor", "s1");
    expect(t.sessions()[0].state).toBe("idle");
    // 回放同一 stop 事件（App 重启）
    const t2 = new SessionTracker(deps());
    t2.handleEvent(ev("prompt"));
    t2.handleEvent(stopEv);
    expect(t2.sessions()[0].state).toBe("idle");
  });

  test("忽略仅对本次 stop 生效：再次活动后新 stop 重新判定", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    transcript = JSON.stringify({ role: "assistant", content: "选哪个方案？" });
    t.handleEvent(ev("stop", { status: "completed", transcriptPath: "/tmp/t.jsonl" }));
    t.ignoreWaiting("cursor", "s1");
    now += 10000;
    t.handleEvent(ev("prompt"));
    now += 5000;
    t.handleEvent(ev("stop", { status: "completed", transcriptPath: "/tmp/t.jsonl" }));
    expect(t.sessions()[0].state).toBe("waiting");
  });
});

describe("疑似卡死判定（3.3b）", () => {
  test("气泡 loading 超 5min → waiting(stuck) + 提醒", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = RUNNING_TOOL;
    now += 6000;
    t.tick(); // 开始记录 loading
    now += 301_000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("stuck");
    expect(notifications.some((n) => n.kind === "waiting")).toBe(true);
  });

  test("事件流持续到达时卡死计时归零（活跃会话最新气泡常驻 loading 不误报）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = RUNNING_TOOL;
    // 每 60s 一条 activity，气泡始终 loading，累计远超 5min 也不该黄
    for (let i = 0; i < 10; i++) {
      now += 60_000;
      t.handleEvent(ev("activity"));
      now += 6000;
      t.tick();
    }
    expect(t.sessions()[0].state).toBe("running");
  });

  // 2026-07-05 实测误报：长命令执行期气泡常驻 loading + 令牌冻结，180s 后被判卡死。
  // hooks 已确认命令在执行（pendingExec 活跃）→ loading 是预期状态，不算卡死候选
  test("执行中的命令（pendingExec 活跃）不算卡死候选，超阈值不亮 stuck", () => {
    const t = new SessionTracker(deps({ stuckThresholdMs: 60_000 }));
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "curl poll-ci" }));
    bubbles = RUNNING_TOOL; // executing=true：审批分支不亮，走到卡死判定
    now += 6000;
    t.tick();
    now += 100_000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("真挂死兜底：执行中 hooks 静默超 inactive 阈值 → 无活动软黄灯", () => {
    const t = new SessionTracker(deps({ stuckThresholdMs: 60_000, inactiveThresholdMs: 300_000 }));
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "curl hang-forever" }));
    bubbles = RUNNING_TOOL;
    now += 6000;
    t.tick(); // 建令牌基线
    now += 301_000;
    t.tick();
    expect(t.sessions()[0].waitingKind).toBe("inactive");
  });

  test("气泡翻转 completed 回 running", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = RUNNING_TOOL;
    now += 6000;
    t.tick();
    now += 301_000;
    t.tick();
    bubbles = DONE_TOOL;
    now += 2000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("未超阈值不亮黄", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = RUNNING_TOOL;
    now += 6000;
    t.tick();
    now += 60_000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });
});

describe("多会话聚合（3.4）", () => {
  test("waiting > failed > running 优先级与计数", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt", {}, "s1"));
    t.handleEvent(ev("prompt", {}, "s2"));
    t.handleEvent(ev("stop", { status: "error" }, "s2"));
    t.handleEvent(ev("prompt", {}, "s3"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick(); // s1、s3 都探测到 pending？——每会话独立探测，都变 waiting
    const agg = t.aggregate();
    expect(agg.color).toBe("yellow");
    expect(agg.counts.failed).toBe(1);
    expect(agg.counts.waiting).toBeGreaterThanOrEqual(1);
  });

  test("全部 idle → 灯灭", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("stop", { status: "completed" }));
    expect(t.aggregate().color).toBe("off");
  });

  test("stop(aborted) → 红灯，知悉后回放不复亮", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    const stopEv = ev("stop", { status: "aborted" });
    t.handleEvent(stopEv);
    expect(t.aggregate().color).toBe("red");
    t.acknowledgeFailure("cursor", "s1");
    expect(t.aggregate().color).toBe("off");
    t.handleEvent(ev("prompt"));
    t.handleEvent(stopEv); // 冷启动回放同一 stop
    expect(t.aggregate().color).toBe("off");
  });

  test("无会话 → 灯灭", () => {
    expect(new SessionTracker(deps()).aggregate().color).toBe("off");
  });

  test("cursor/codex 混合：聚合计数按状态合并，不分工具（4.2 回归）", () => {
    const d = deps();
    d.registry.codex = { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false };
    const t = new SessionTracker(d);
    t.handleEvent(ev("prompt", {}, "cu1")); // cursor running
    t.handleEvent({ v: 2, tool: "codex", sessionId: "cx1", event: "prompt", ts: now, meta: {} });
    t.handleEvent({ v: 2, tool: "codex", sessionId: "cx1", event: "approval_request", ts: now, meta: {} }); // codex waiting
    const agg = t.aggregate();
    expect(agg.color).toBe("yellow");
    expect(agg.counts.running).toBe(1);
    expect(agg.counts.waiting).toBe(1);
    const tools = t.sessions().map((s) => s.tool).sort();
    expect(tools).toEqual(["codex", "cursor"]);
  });
});

describe("GC 与背景过滤与存活（3.5/3.6/3.7）", () => {
  test("超过 24h 无事件的会话被 GC", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    now += 25 * 3600_000;
    t.tick();
    expect(t.sessions()).toHaveLength(0);
  });

  test("背景 agent 默认过滤（session_start 与后续事件都忽略）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("session_start", { isBackgroundAgent: true }));
    t.handleEvent(ev("prompt"));
    expect(t.sessions()).toHaveLength(0);
  });

  test("配置纳入背景 agent 后正常跟踪", () => {
    const t = new SessionTracker(deps({ includeBackgroundAgents: true }));
    t.handleEvent(ev("session_start", { isBackgroundAgent: true }));
    expect(t.sessions()).toHaveLength(1);
  });

  test("Cursor 进程消失 → 全部会话转 idle 并标注", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    alive = false;
    now += 36_000; // 超过豁免窗口（livenessIntervalMs + 5s）
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("idle");
    expect(s.note).toBe("tool_exited");
  });

  test("工具退出不清红灯：failed 保留到用户知悉", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("stop", { status: "error" }));
    expect(t.sessions()[0].state).toBe("failed");
    alive = false;
    now += 36_000;
    t.tick();
    expect(t.sessions()[0].state).toBe("failed"); // 红灯不被 tool_exited 自动清掉
    t.acknowledgeFailure("cursor", "s1");
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("探针通道恢复后降级标记自动解除", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = null; // 探针不可用
    now += 6000;
    t.tick();
    expect(t.dbDegraded()).toBe(true);
    bubbles = []; // 通道恢复
    now += 2000;
    t.tick();
    expect(t.dbDegraded()).toBe(false);
  });

  test("冷启动回放的陈旧黄灯降级为灰点；新鲜黄灯与红灯保留", () => {
    const d = deps();
    const t = new SessionTracker(d);
    // 陈旧审批黄灯（2 小时前）
    t.handleEvent({ v: 2, tool: "cursor", sessionId: "old", event: "prompt", ts: now - 7200_000, meta: {} });
    t.handleEvent({ v: 2, tool: "cursor", sessionId: "old", event: "approval_request", ts: now - 7200_000, meta: {} });
    // 新鲜审批黄灯（1 分钟前）
    t.handleEvent({ v: 2, tool: "cursor", sessionId: "fresh", event: "prompt", ts: now - 60_000, meta: {} });
    t.handleEvent({ v: 2, tool: "cursor", sessionId: "fresh", event: "approval_request", ts: now - 60_000, meta: {} });
    // 陈旧红灯（2 小时前）
    t.handleEvent({ v: 2, tool: "cursor", sessionId: "red", event: "prompt", ts: now - 7200_000, meta: {} });
    t.handleEvent({ v: 2, tool: "cursor", sessionId: "red", event: "stop", ts: now - 7200_000, meta: { status: "error" } });
    t.expireStaleWaiting(30 * 60_000);
    const by = new Map(t.sessions().map((s) => [s.sessionId, s.state]));
    expect(by.get("old")).toBe("idle");
    expect(by.get("fresh")).toBe("waiting");
    expect(by.get("red")).toBe("failed");
  });

  test("混合工具降级互不掩盖：cursor 探针挂、codex 正常 → cursor 单通道仍标降级", () => {
    const d = deps();
    d.registry.codex = { yellow: "exact", red: "exact", metadata: true };
    d.probe = (tool) => (tool === "cursor" ? null : snapshotFromBubbles([]));
    const t = new SessionTracker(d);
    t.handleEvent(ev("prompt"));
    t.handleEvent({ v: 2, tool: "codex", sessionId: "c1", event: "prompt", ts: now, meta: {} });
    now += 6000;
    t.tick();
    expect(t.dbDegraded("cursor")).toBe(true);
    expect(t.dbDegraded("codex")).toBe(false);
    expect(t.dbDegraded()).toBe(true); // 任一通道降级 → 灯体角标仍亮
  });

  test("存活缓存竞态回归（5.1 实测）：刚收到事件的会话豁免 tool_exited，审批黄灯不被误清", () => {
    const d = deps();
    d.registry.codex = { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false };
    const t = new SessionTracker(d);
    alive = false; // codex CLI 刚启动，ps 缓存仍是上一周期的"未运行"
    t.handleEvent({ v: 2, tool: "codex", sessionId: "c1", event: "prompt", ts: now, meta: {} });
    t.handleEvent({ v: 2, tool: "codex", sessionId: "c1", event: "approval_request", ts: now, meta: {} });
    now += 2000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("approval");
  });

  test("睡眠唤醒重置审批计时", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "sudo x" }));
    now += 3600_000; // 长时间睡眠
    t.resetTimersOnWake();
    bubbles = RUNNING_TOOL;
    t.tick();
    expect(t.sessions()[0].state).toBe("running"); // 计时重置，未再过阈值
  });

  test("红灯知悉后回放不复亮（3.2b 持久化）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    const stopEv = ev("stop", { status: "error" });
    t.handleEvent(stopEv);
    t.acknowledgeFailure("cursor", "s1");
    expect(t.sessions()[0].state).toBe("idle");
    const t2 = new SessionTracker(deps());
    t2.handleEvent(ev("prompt"));
    t2.handleEvent(stopEv);
    expect(t2.sessions()[0].state).toBe("idle");
  });

  test("waiting 通知同会话同类等待不重复", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    now += 2000;
    t.tick();
    now += 2000;
    t.tick();
    expect(notifications.filter((n) => n.kind === "waiting").length).toBe(1);
  });
});

describe("推送式审批 approval_request（2.4）", () => {
  const codexDeps = (config: Partial<AppConfig> = {}) => {
    const d = deps(config);
    d.registry.codex = { yellow: "exact", red: "none", metadata: true, yellowPush: true };
    return d;
  };
  const cev = (event: TrafficEvent["event"], meta: Record<string, unknown> = {}, sessionId = "c1"): TrafficEvent => ({ v: 2, tool: "codex", sessionId, event, ts: now, meta });

  test("running 会话收到 approval_request → 立即 waiting(approval)，无阈值延迟", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("approval_request", { toolName: "Bash", command: "rm -rf build" }));
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("approval");
  });

  test("批准后 after_exec 清除等待回 running", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("approval_request"));
    now += 3000;
    t.handleEvent(cev("after_exec", { command: "rm -rf build" }));
    expect(t.sessions()[0].state).toBe("running");
  });

  test("拒绝后任何新事件清除等待（不残留黄灯）", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("approval_request"));
    now += 3000;
    t.handleEvent(cev("stop", { status: "aborted" }));
    // codex red=none → aborted 落 idle 而非红灯
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("白名单不作用于推送路径：白名单命令的 approval_request 仍亮黄", () => {
    const t = new SessionTracker(codexDeps({ shellWhitelist: ["npm install"] }));
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("approval_request", { command: "npm install lodash" }));
    expect(t.sessions()[0].state).toBe("waiting");
  });

  test("首事件为 approval_request 时自动建会话并立即 waiting（冷启动错过 session_start）", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("approval_request", { command: "sudo x" }));
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("approval");
  });

  test("精确审批不可忽略（非软黄灯）", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("approval_request"));
    t.ignoreWaiting("codex", "c1");
    expect(t.sessions()[0].state).toBe("waiting");
  });

  test("启发式路径并行不干扰：cursor before_exec 白名单豁免照旧", () => {
    const t = new SessionTracker(codexDeps({ shellWhitelist: ["npm install"] }));
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("before_exec", { kind: "shell", command: "npm install lodash" }));
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("approval_request"));
    now += 60000;
    t.tick();
    const cursor = t.sessions().find((s) => s.tool === "cursor")!;
    expect(cursor.state).toBe("running");
    const codex = t.sessions().find((s) => s.tool === "codex")!;
    expect(codex.state).toBe("waiting");
  });
});

describe("无状态 stop 终态回读（2.5）", () => {
  let resolved: { status: "completed" | "aborted" | "error"; lastAssistantMessage: string | null } | null;
  const codexDeps = () => {
    const d = deps();
    // codex 能力声明（spec）：red=exact 但 aborted 不算失败（用户中断/拒绝审批 → 灭灯）
    d.registry.codex = { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false };
    d.resolveStop = () => resolved;
    return d;
  };
  const cev = (event: TrafficEvent["event"], meta: Record<string, unknown> = {}): TrafficEvent => ({ v: 2, tool: "codex", sessionId: "c1", event, ts: now, meta });

  beforeEach(() => {
    resolved = null;
  });

  test("resolver 返回 aborted → idle 灭灯（用户中断不算失败，区别于 cursor）", () => {
    const t = new SessionTracker(codexDeps());
    resolved = { status: "aborted", lastAssistantMessage: null };
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("stop", { transcriptPath: "/tmp/r.jsonl" }));
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("resolver 返回 error → failed 红灯", () => {
    const t = new SessionTracker(codexDeps());
    resolved = { status: "error", lastAssistantMessage: null };
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("stop", { transcriptPath: "/tmp/r.jsonl" }));
    expect(t.sessions()[0].state).toBe("failed");
  });

  test("resolver 返回 completed + 结尾提问文本 → waiting(trailing_question)，不走 Cursor transcript 解析器", () => {
    const t = new SessionTracker(codexDeps());
    resolved = { status: "completed", lastAssistantMessage: "改完了。要不要我继续优化？" };
    transcript = null; // Cursor 解析通路不可用也不影响
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("stop", { transcriptPath: "/tmp/r.jsonl" }));
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("trailing_question");
  });

  test("resolver 返回 completed + 结尾陈述 → idle", () => {
    const t = new SessionTracker(codexDeps());
    resolved = { status: "completed", lastAssistantMessage: "全部完成。" };
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("stop", { transcriptPath: "/tmp/r.jsonl" }));
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("resolver 解析失败（null）→ 丢弃 stop 保持 running，等 probe 兜底（5.1 实测 Stop hook 先于 task_complete 落盘）", () => {
    const d = codexDeps();
    d.probe = () => ({
      pending: { kind: "none" },
      executing: false,
      stuckCandidate: false,
      missedQuestion: false,
      ...(resolved ? { terminal: resolved } : {}),
    });
    const t = new SessionTracker(d);
    resolved = null; // rollout 终态尚未 flush
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("stop", { transcriptPath: "/tmp/r.jsonl" }));
    expect(t.sessions()[0].state).toBe("running"); // 不误落 idle 丢结尾提问
    // 下个探测周期 rollout 已落盘 → probe 合成带完整终态的 stop
    resolved = { status: "completed", lastAssistantMessage: "需要我把这个改动同步到文档吗？" };
    now += 6000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("trailing_question");
  });

  test("resolver 未声明（deps 缺席）→ 兜底 completed", () => {
    const d = codexDeps();
    delete d.resolveStop;
    const t = new SessionTracker(d);
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("stop", {}));
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("cursor 回归：stop(aborted) 仍亮红灯（redIncludesAborted）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("stop", { status: "aborted" }));
    expect(t.sessions()[0].state).toBe("failed");
  });
});

describe("probe 兜底合成 stop（3.4）", () => {
  let terminal: { status: "completed" | "aborted" | "error"; lastAssistantMessage: string | null } | null;
  const codexDeps = () => {
    const d = deps();
    d.registry.codex = { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false };
    d.probe = (tool) =>
      tool === "codex"
        ? { pending: { kind: "none" }, executing: false, stuckCandidate: false, missedQuestion: false, ...(terminal ? { terminal } : {}) }
        : snapshotFromBubbles(bubbles);
    return d;
  };
  const cev = (event: TrafficEvent["event"], meta: Record<string, unknown> = {}): TrafficEvent => ({ v: 2, tool: "codex", sessionId: "c1", event, ts: now, meta });

  beforeEach(() => {
    terminal = null;
  });

  test("running 静默会话探测到 turn_aborted 终态 → 合成 stop 落 idle（中断清灯，无 Stop hook 场景）", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    terminal = { status: "aborted", lastAssistantMessage: null };
    now += 6000;
    t.tick();
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("探测到 error 终态 → 合成 stop 亮红灯", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    terminal = { status: "error", lastAssistantMessage: null };
    now += 6000;
    t.tick();
    expect(t.sessions()[0].state).toBe("failed");
  });

  test("探测到 completed + 结尾提问 → 合成 stop 后 waiting(trailing_question)", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    terminal = { status: "completed", lastAssistantMessage: "要不要继续？" };
    now += 6000;
    t.tick();
    const s = t.sessions()[0];
    expect(s.state).toBe("waiting");
    expect(s.waitingKind).toBe("trailing_question");
  });

  test("审批等待中探测到终态也清灯（拒绝后无任何 hook 场景）", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    t.handleEvent(cev("approval_request", { command: "sudo x" }));
    expect(t.sessions()[0].state).toBe("waiting");
    terminal = { status: "aborted", lastAssistantMessage: null };
    now += 6000;
    t.tick();
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("无终态（回合进行中）→ 照常保持 running", () => {
    const t = new SessionTracker(codexDeps());
    t.handleEvent(cev("prompt"));
    now += 6000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });
});

describe("adapter 注册制（2.3）", () => {
  const mystery = (event: TrafficEvent["event"], meta: Record<string, unknown> = {}): TrafficEvent => ({ v: 2, tool: "mystery", sessionId: "m1", event, ts: now, meta });

  test("未注册工具按 none 能力兜底：stop(error) 不亮红灯", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(mystery("prompt"));
    t.handleEvent(mystery("stop", { status: "error" }));
    expect(t.sessions()[0].state).toBe("idle");
  });

  test("未注册工具 yellow=none：探测到 pending 也不进 waiting", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(mystery("prompt"));
    bubbles = PENDING_ASK;
    now += 6000;
    t.tick();
    expect(t.sessions()[0].state).toBe("running");
  });

  test("注册表中的工具按声明能力工作（cursor red=exact 回归）", () => {
    const t = new SessionTracker(deps());
    t.handleEvent(ev("prompt"));
    t.handleEvent(ev("stop", { status: "error" }));
    expect(t.sessions()[0].state).toBe("failed");
  });
});
