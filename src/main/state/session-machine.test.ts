import { describe, expect, test } from "vitest";
import { SessionMachine } from "./session-machine";
import type { CapabilityFlags } from "../adapters/adapter";
import type { TrafficEvent } from "../../shared/events";

const FULL: CapabilityFlags = { yellow: "exact", red: "exact", metadata: true };

function ev(event: TrafficEvent["event"], meta: Record<string, unknown> = {}, ts = Date.now()): TrafficEvent {
  return { v: 1, tool: "cursor", sessionId: "s1", event, ts, meta };
}

function machine(caps: CapabilityFlags = FULL): SessionMachine {
  return new SessionMachine("cursor", "s1", caps);
}

describe("user_action_required 事件（qoder 用户操作等待）", () => {
  test("user_action_required → waiting/user_action，精确黄灯不可忽略", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("user_action_required"));
    expect(m.state).toBe("waiting");
    expect(m.waitingKind).toBe("user_action");
    expect(m.ignorable).toBe(false);
    m.ignoreWaiting(); // 不可忽略：无效
    expect(m.state).toBe("waiting");
  });

  test("后续活动事件清除 user_action 等待", () => {
    const m = machine();
    m.handle(ev("user_action_required"));
    m.handle(ev("activity"));
    expect(m.state).toBe("running");
    expect(m.waitingKind).toBeNull();
  });

  test("stop 清除 user_action 等待并落终态", () => {
    const m = machine();
    m.handle(ev("user_action_required"));
    m.handle(ev("stop", { status: "completed" }));
    expect(m.state).toBe("idle");
  });

  test("yellow=none 能力降级：user_action_required 不进 waiting", () => {
    const m = machine({ yellow: "none", red: "none", metadata: false });
    m.handle(ev("user_action_required"));
    expect(m.state).toBe("idle");
  });
});

describe("单会话状态机（任务 3.1）", () => {
  test("初始为 idle", () => {
    expect(machine().state).toBe("idle");
  });

  test("prompt → running", () => {
    const m = machine();
    m.handle(ev("prompt"));
    expect(m.state).toBe("running");
  });

  test("session_start → 保持 idle 灰点（新建页签未必开始干活），不重置已有状态", () => {
    const m = machine();
    m.handle(ev("session_start", {}, 1000));
    expect(m.state).toBe("idle");
    expect(m.stateSince).toBe(1000);
    m.handle(ev("stop", { status: "error" }));
    m.handle(ev("session_start")); // Cursor 重载场景：不清红灯
    expect(m.state).toBe("failed");
  });

  test("stop(error) → failed", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "error" }));
    expect(m.state).toBe("failed");
  });

  test("stop(completed) → idle", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "completed" }));
    expect(m.state).toBe("idle");
  });

  test("stop(aborted) → failed（手动停止与自动中止不可区分，统一亮红可知悉）", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "aborted" }));
    expect(m.state).toBe("failed");
    m.acknowledgeFailure();
    expect(m.state).toBe("idle");
  });

  test("stop(unknown，冷启动兜底注入) → idle", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "unknown" }));
    expect(m.state).toBe("idle");
  });

  test("failed 遇任何新活动事件 → running", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "error" }));
    m.handle(ev("before_exec", { kind: "shell", command: "ls" }));
    expect(m.state).toBe("running");
  });

  test("session_end → removed", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("session_end"));
    expect(m.state).toBe("removed");
  });

  test("removed 后新事件复活为 running", () => {
    const m = machine();
    m.handle(ev("session_end"));
    m.handle(ev("prompt"));
    expect(m.state).toBe("running");
  });

  test("red 能力为 none 时 stop(error) 不进 failed（降级为 idle）", () => {
    const m = machine({ yellow: "exact", red: "none", metadata: false });
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "error" }));
    expect(m.state).toBe("idle");
  });

  test("waiting 由外部判定器设置；yellow=none 时拒绝进入 waiting", () => {
    const full = machine();
    full.handle(ev("prompt"));
    full.setWaiting("question");
    expect(full.state).toBe("waiting");
    expect(full.waitingKind).toBe("question");

    const none = machine({ yellow: "none", red: "exact", metadata: false });
    none.handle(ev("prompt"));
    none.setWaiting("question");
    expect(none.state).toBe("running");
  });

  test("waiting 会话收到新事件回 running", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.setWaiting("approval");
    m.handle(ev("after_exec", { kind: "shell" }));
    expect(m.state).toBe("running");
    expect(m.waitingKind).toBeNull();
  });

  test("waiting 会话 stop(completed) → idle（清空等待）", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.setWaiting("approval");
    m.handle(ev("stop", { status: "completed" }));
    expect(m.state).toBe("idle");
    expect(m.waitingKind).toBeNull();
  });

  test("记录状态进入时间与最后事件时间", () => {
    const m = machine();
    const t = 1783000000000;
    m.handle(ev("prompt", {}, t));
    expect(m.lastEventAt).toBe(t);
    expect(m.stateSince).toBe(t);
  });

  test("软黄灯（结尾提问）可被忽略转 idle；精确黄灯不可忽略", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "completed" }));
    m.setWaiting("trailing_question");
    expect(m.state).toBe("waiting");
    expect(m.ignorable).toBe(true);
    m.ignoreWaiting();
    expect(m.state).toBe("idle");

    const m2 = machine();
    m2.handle(ev("prompt"));
    m2.setWaiting("question");
    expect(m2.ignorable).toBe(false);
    m2.ignoreWaiting();
    expect(m2.state).toBe("waiting");
  });

  test("failed 手动知悉 → idle", () => {
    const m = machine();
    m.handle(ev("prompt"));
    m.handle(ev("stop", { status: "error" }));
    m.acknowledgeFailure();
    expect(m.state).toBe("idle");
  });
});
