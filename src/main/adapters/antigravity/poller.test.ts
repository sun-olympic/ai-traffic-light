import { beforeEach, describe, expect, test } from "vitest";
import type { TrafficEvent } from "../../../shared/events";
import { AntigravityPoller, type AntigravitySnapshot, type SessionSnapshot } from "./poller";
import type { SessionStateKind } from "./derive-state";

const NOW = 1_800_000_000_000;
const FRESH_MS = 600_000;
const QUIET_MS = 30_000;
/** 已过写静默窗口的终态 mtime（D39：只有静默后的终态才被确认） */
const STALE = NOW - QUIET_MS - 1000;

let events: TrafficEvent[];
let snap: AntigravitySnapshot | null;
let tailText: string | null;
let now: number;

function session(id: string, kind: SessionStateKind, opts?: Partial<SessionSnapshot> & { evidenceIdx?: number; maxIdx?: number }): SessionSnapshot {
  return {
    sessionId: id,
    observation: { kind, maxIdx: opts?.maxIdx ?? 3, evidenceIdx: opts?.evidenceIdx ?? 3 },
    mtime: opts?.mtime ?? NOW - 1000,
    epoch: opts?.epoch ?? 1,
  };
}

function makePoller(): AntigravityPoller {
  return new AntigravityPoller({
    read: () => snap,
    emit: (ev) => events.push(ev),
    clock: () => now,
    freshWaitingMs: FRESH_MS,
    terminalQuietMs: QUIET_MS,
    transcriptTail: () => tailText,
  });
}

beforeEach(() => {
  events = [];
  snap = { sessions: [] };
  tailText = null;
  now = NOW;
});

describe("启动基线（D20/D31）", () => {
  test("running → activity；fresh waiting → user_action_required；历史终态/unknown 静默", () => {
    snap = {
      sessions: [
        session("s-run", "running"),
        session("s-wait", "waiting"),
        session("s-done", "completed", { mtime: STALE }),
        session("s-err", "error", { mtime: STALE }),
        session("s-unk", "unknown"),
      ],
    };
    makePoller().poll();
    expect(events.map((e) => [e.sessionId, e.event])).toEqual([
      ["s-run", "activity"],
      ["s-wait", "user_action_required"],
    ]);
    expect(events.every((e) => e.tool === "antigravity" && e.v === 3)).toBe(true);
  });

  test("陈旧 waiting（超出新鲜窗口）基线静默（D31）", () => {
    snap = { sessions: [session("s-old-wait", "waiting", { mtime: NOW - FRESH_MS - 1 })] };
    makePoller().poll();
    expect(events).toEqual([]);
  });

  test("基线 waiting 事件时间戳用 mtime（跨重启稳定，D37）", () => {
    snap = { sessions: [session("s-wait", "waiting", { mtime: NOW - 5000 })] };
    makePoller().poll();
    expect(events[0].ts).toBe(NOW - 5000);
  });

  test("read 返回 null（未检测到/降级）：不基线、无事件；恢复后再基线", () => {
    snap = null;
    const p = makePoller();
    p.poll();
    expect(events).toEqual([]);
    snap = { sessions: [session("s-run", "running")] };
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["activity"]);
  });
});

describe("状态转移 diff（D3/D10）", () => {
  function baselineRunning(id = "s1"): AntigravityPoller {
    snap = { sessions: [session(id, "running", { maxIdx: 3, evidenceIdx: 3 })] };
    const p = makePoller();
    p.poll();
    events = [];
    return p;
  }

  test("running → waiting 发 user_action_required", () => {
    const p = baselineRunning();
    snap = { sessions: [session("s1", "waiting", { maxIdx: 4, evidenceIdx: 4 })] };
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["user_action_required"]);
  });

  test("running → completed（已静默）发 stop(completed)，ts 用 mtime，带尾部文本，不带 transcriptPath", () => {
    const p = baselineRunning();
    tailText = "还需要我继续吗？";
    snap = { sessions: [session("s1", "completed", { maxIdx: 5, evidenceIdx: 5, mtime: STALE })] };
    p.poll();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.event).toBe("stop");
    expect(ev.ts).toBe(STALE);
    expect(ev.meta.status).toBe("completed");
    expect(ev.meta.resolvedLastMessage).toBe("还需要我继续吗？");
    expect("transcriptPath" in ev.meta).toBe(false);
  });

  test("completed 无尾部文本时 resolvedLastMessage 为 null（跳过尾问不走通用解析器，D38）", () => {
    const p = baselineRunning();
    snap = { sessions: [session("s1", "completed", { maxIdx: 5, evidenceIdx: 5, mtime: STALE })] };
    p.poll();
    expect(events[0].meta.resolvedLastMessage).toBeNull();
  });

  test("running → error（已静默）发 stop(error)；running → aborted 发 stop(aborted)（不亮红）", () => {
    const p = baselineRunning("sa");
    snap = { sessions: [session("sa", "error", { maxIdx: 4, evidenceIdx: 4, mtime: STALE })] };
    p.poll();
    expect(events[0].meta.status).toBe("error");
    events = [];
    const p2 = baselineRunning("sb");
    snap = { sessions: [session("sb", "aborted", { maxIdx: 4, evidenceIdx: 4, mtime: STALE })] };
    p2.poll();
    expect(events[0].meta.status).toBe("aborted");
  });

  test("waiting 不变不重发；running idx 前进发 activity（活性），不前进不发", () => {
    snap = { sessions: [session("w1", "waiting"), session("r1", "running", { maxIdx: 3 })] };
    const p = makePoller();
    p.poll();
    events = [];
    p.poll(); // 完全相同的快照
    expect(events).toEqual([]);
    snap = { sessions: [session("w1", "waiting"), session("r1", "running", { maxIdx: 4, evidenceIdx: 4 })] };
    p.poll();
    expect(events.map((e) => [e.sessionId, e.event])).toEqual([["r1", "activity"]]);
  });

  test("unknown 观测不改变已知状态（保守，D18）", () => {
    const p = baselineRunning();
    snap = { sessions: [session("s1", "unknown", { maxIdx: 3 })] };
    p.poll();
    expect(events).toEqual([]);
  });

  test("会话从快照消失：不发事件（消失≠完成，D13）", () => {
    const p = baselineRunning();
    snap = { sessions: [] };
    p.poll();
    expect(events).toEqual([]);
  });

  test("基线后新出现的会话：running 发 activity，终态静默（视同历史）", () => {
    const p = baselineRunning();
    snap = {
      sessions: [session("s1", "running", { maxIdx: 3 }), session("new-run", "running"), session("new-done", "completed", { mtime: STALE })],
    };
    p.poll();
    expect(events.map((e) => [e.sessionId, e.event])).toEqual([["new-run", "activity"]]);
  });
});

describe("episode 与 epoch（D29/D37）", () => {
  function baselineTerminal(kind: SessionStateKind = "error"): AntigravityPoller {
    snap = { sessions: [session("s1", kind, { maxIdx: 5, evidenceIdx: 5, mtime: STALE })] };
    const p = makePoller();
    p.poll();
    events = [];
    return p;
  }

  test("终态后更高 idx 的新进展 → 新 episode 发 activity", () => {
    const p = baselineTerminal();
    snap = { sessions: [session("s1", "running", { maxIdx: 6, evidenceIdx: 6 })] };
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["activity"]);
  });

  test("终态后 idx 未前进的 running 观测 → 迟到写入忽略，不复活（D37）", () => {
    const p = baselineTerminal();
    snap = { sessions: [session("s1", "running", { maxIdx: 5, evidenceIdx: 5 })] };
    p.poll();
    expect(events).toEqual([]);
  });

  test("终态后 idx 未前进的 waiting 观测 → 忽略（历史等待不亮黄）", () => {
    const p = baselineTerminal();
    snap = { sessions: [session("s1", "waiting", { maxIdx: 5, evidenceIdx: 5 })] };
    p.poll();
    expect(events).toEqual([]);
  });

  test("同一终态重复观测不重发 stop（稳定时间戳下 marks 不被打破）", () => {
    const p = baselineTerminal();
    snap = { sessions: [session("s1", "error", { maxIdx: 5, evidenceIdx: 5, mtime: STALE })] };
    p.poll();
    p.poll();
    expect(events).toEqual([]);
  });

  test("epoch 变化（库替换/迁移）→ 重新基线：终态静默、running 恢复", () => {
    const p = baselineTerminal();
    // 同 id 新 epoch，idx 从头开始且是终态 → 静默（重新基线，不误报新红灯）
    snap = { sessions: [session("s1", "error", { maxIdx: 1, evidenceIdx: 1, epoch: 2, mtime: STALE })] };
    p.poll();
    expect(events).toEqual([]);
    // 新 epoch 内出现进展 → 正常 diff
    snap = { sessions: [session("s1", "running", { maxIdx: 2, evidenceIdx: 2, epoch: 2 })] };
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["activity"]);
  });

  test("idx 回退（无 epoch 字段变化的压缩/重置）也按新 epoch 重新基线", () => {
    const p = baselineTerminal();
    snap = { sessions: [session("s1", "running", { maxIdx: 2, evidenceIdx: 2, epoch: 1 })] };
    p.poll();
    expect(events).toEqual([]); // maxIdx 5 → 2 视为 store 重置，重新基线（running 静默恢复由下轮 diff 接管）
    snap = { sessions: [session("s1", "waiting", { maxIdx: 3, evidenceIdx: 3, epoch: 1 })] };
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["user_action_required"]);
  });
});

describe("终态写静默确认（D39：活跃轨迹的 steps 全 DONE，落行只在步骤完成时发生）", () => {
  test("基线：终态观测但库仍在写（mtime 新鲜）→ 视为 running 发 activity（真机盲区修复）", () => {
    snap = { sessions: [session("s-active", "completed", { mtime: NOW - 500 })] };
    makePoller().poll();
    expect(events.map((e) => [e.sessionId, e.event])).toEqual([["s-active", "activity"]]);
  });

  test("diff：running → 终态观测但 mtime 新鲜 → 不发 stop；静默超窗后才确认 stop(ts=mtime)", () => {
    snap = { sessions: [session("s1", "running", { maxIdx: 3, evidenceIdx: 3 })] };
    const p = makePoller();
    p.poll();
    events = [];
    const terminalMtime = NOW + 2000;
    snap = { sessions: [session("s1", "completed", { maxIdx: 5, evidenceIdx: 5, mtime: terminalMtime })] };
    now = NOW + 3000; // 静默窗口内：视为 running，idx 前进是活性证据
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["activity"]);
    events = [];
    now = terminalMtime + QUIET_MS + 1; // 静默超窗
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["stop"]);
    expect(events[0].meta.status).toBe("completed");
    expect(events[0].ts).toBe(terminalMtime);
  });

  test("中途 error 行随后被新进展覆盖 → 全程无红灯闪烁", () => {
    snap = { sessions: [session("s1", "running", { maxIdx: 3, evidenceIdx: 3 })] };
    const p = makePoller();
    p.poll();
    events = [];
    // agent 中途一步报错但库还在写 → 视为 running（不发 stop(error)，idx 前进照发活性）
    snap = { sessions: [session("s1", "error", { maxIdx: 4, evidenceIdx: 4, mtime: NOW - 100 })] };
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["activity"]);
    events = [];
    // agent 恢复：更高 idx 的 active 步 → 继续 running，无 stop(error) 出现过
    snap = { sessions: [session("s1", "running", { maxIdx: 5, evidenceIdx: 5, mtime: NOW })] };
    p.poll();
    expect(events.map((e) => e.event)).toEqual(["activity"]);
  });

  test("probe：终态观测但 mtime 新鲜 → executing（不带 terminal 保险丝，防误清活跃会话）", () => {
    snap = { sessions: [session("s1", "completed", { mtime: NOW - 500 })] };
    const p = makePoller();
    p.poll();
    const probe = p.probeSnapshot("s1");
    expect(probe?.executing).toBe(true);
    expect(probe?.terminal).toBeUndefined();
  });
});

describe("隐私边界（D6/D21/D38 防回归断言）", () => {
  test("完整生命周期产出的所有事件 meta 只含白名单键（status/resolvedLastMessage），绝无 transcriptPath/prompt 类字段", () => {
    tailText = "尾部问题？";
    snap = { sessions: [session("s1", "running", { maxIdx: 1, evidenceIdx: 1 })] };
    const p = makePoller();
    p.poll();
    snap = { sessions: [session("s1", "waiting", { maxIdx: 2, evidenceIdx: 2 })] };
    p.poll();
    snap = { sessions: [session("s1", "completed", { maxIdx: 3, evidenceIdx: 3, mtime: STALE })] };
    p.poll();
    snap = { sessions: [session("s1", "error", { maxIdx: 4, evidenceIdx: 4, mtime: STALE })] };
    p.poll();
    expect(events.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set(["status", "resolvedLastMessage"]);
    for (const ev of events) {
      expect(ev.tool).toBe("antigravity");
      for (const key of Object.keys(ev.meta)) expect(allowed.has(key)).toBe(true);
    }
  });
});

describe("probeSnapshot（D28 探针与轮询同代快照）", () => {
  test("running → executing；waiting → user_action_pending", () => {
    snap = { sessions: [session("r1", "running"), session("w1", "waiting")] };
    const p = makePoller();
    p.poll();
    expect(p.probeSnapshot("r1")).toMatchObject({ executing: true, pending: { kind: "none" } });
    expect(p.probeSnapshot("w1")).toMatchObject({ executing: false, pending: { kind: "user_action_pending" } });
  });

  test("已静默终态 → terminal 保险丝（completed 带尾部文本）", () => {
    tailText = "done?";
    snap = { sessions: [session("d1", "completed", { mtime: STALE }), session("e1", "error", { mtime: STALE })] };
    const p = makePoller();
    p.poll();
    expect(p.probeSnapshot("d1")?.terminal).toEqual({ status: "completed", lastAssistantMessage: "done?" });
    expect(p.probeSnapshot("e1")?.terminal).toEqual({ status: "error", lastAssistantMessage: null });
  });

  test("会话缺失/unknown/从未成功读取 → null（保留既有状态并降级，D28）", () => {
    const p = makePoller();
    expect(p.probeSnapshot("nope")).toBeNull(); // 从未 poll 成功
    snap = { sessions: [session("u1", "unknown")] };
    p.poll();
    expect(p.probeSnapshot("u1")).toBeNull();
    expect(p.probeSnapshot("missing")).toBeNull();
  });

  test("probe 用最近一次成功快照（read 挂掉时不清黄灯）", () => {
    snap = { sessions: [session("w1", "waiting")] };
    const p = makePoller();
    p.poll();
    snap = null; // 库临时不可读
    p.poll();
    expect(p.probeSnapshot("w1")).toMatchObject({ pending: { kind: "user_action_pending" } });
  });
});
