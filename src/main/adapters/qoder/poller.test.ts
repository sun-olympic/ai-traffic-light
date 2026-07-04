import { beforeEach, describe, expect, test } from "vitest";
import { QoderPoller } from "./poller";
import type { QoderSnapshot, QoderTask } from "./snapshot-reader";
import type { TrafficEvent } from "../../../shared/events";

let now: number;
let snap: QoderSnapshot | null;
let emitted: TrafficEvent[];
let poller: QoderPoller;

function task(overrides: Partial<QoderTask>): QoderTask {
  return {
    taskId: "task-1",
    canonicalId: "task-1.session.execution",
    status: "running",
    updatedAt: 1000,
    workspacePath: "/tmp/ws",
    displayName: "synthetic-display",
    ...overrides,
  };
}

beforeEach(() => {
  now = 1_783_150_000_000;
  snap = { tasks: [] };
  emitted = [];
  poller = new QoderPoller({
    read: () => snap,
    emit: (ev) => emitted.push(ev),
    clock: () => now,
  });
});

describe("启动基线（D2：历史任务不制造新提醒）", () => {
  test("历史 running 恢复为绿（activity），历史 user_action 恢复为黄（user_action_required）", () => {
    snap = { tasks: [task({ canonicalId: "a", status: "running" }), task({ canonicalId: "b", taskId: "task-2", status: "user_action" })] };
    poller.poll();
    expect(emitted.map((e) => [e.sessionId, e.event])).toEqual([
      ["a", "activity"],
      ["b", "user_action_required"],
    ]);
    expect(emitted.every((e) => e.tool === "qoder")).toBe(true);
  });

  test("历史终态（completed/stopped/error/unknown）静默，不发事件", () => {
    snap = {
      tasks: [
        task({ canonicalId: "c", status: "completed" }),
        task({ canonicalId: "s", status: "stopped" }),
        task({ canonicalId: "e", status: "error" }),
        task({ canonicalId: "u", status: "unknown" }),
      ],
    };
    poller.poll();
    expect(emitted).toEqual([]);
  });

  test("首次读取失败不建基线，恢复后第一次成功读取才建", () => {
    snap = null;
    poller.poll();
    snap = { tasks: [task({ canonicalId: "e", status: "error" })] };
    poller.poll(); // 此时才是基线：历史 error 仍静默
    expect(emitted).toEqual([]);
  });
});

describe("基线后状态转移", () => {
  beforeEach(() => {
    snap = { tasks: [task({ status: "running", updatedAt: 1000 })] };
    poller.poll(); // 基线：running → activity
    emitted = [];
  });

  test("running → user_action 发 user_action_required", () => {
    snap = { tasks: [task({ status: "user_action", updatedAt: 2000 })] };
    poller.poll();
    expect(emitted.map((e) => e.event)).toEqual(["user_action_required"]);
  });

  test("user_action → running 发 activity（用户处理后清黄）", () => {
    snap = { tasks: [task({ status: "user_action", updatedAt: 2000 })] };
    poller.poll();
    snap = { tasks: [task({ status: "running", updatedAt: 3000 })] };
    poller.poll();
    expect(emitted.map((e) => e.event)).toEqual(["user_action_required", "activity"]);
  });

  test("running → completed 发 stop(completed) 并带 transcriptPath（尾问检测）", () => {
    poller = new QoderPoller({
      read: () => snap,
      emit: (ev) => emitted.push(ev),
      clock: () => now,
      transcriptPath: (tid) => `/tmp/conv/${tid.slice(0, 8)}.jsonl`,
    });
    snap = { tasks: [task({ status: "running" })] };
    poller.poll();
    emitted = [];
    snap = { tasks: [task({ status: "completed", updatedAt: 2000 })] };
    poller.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("stop");
    expect(emitted[0].meta.status).toBe("completed");
    expect(emitted[0].meta.transcriptPath).toBe("/tmp/conv/task-1.jsonl");
  });

  test("running → stopped 发 stop(aborted)（能力声明不红）", () => {
    snap = { tasks: [task({ status: "stopped", updatedAt: 2000 })] };
    poller.poll();
    expect(emitted[0].event).toBe("stop");
    expect(emitted[0].meta.status).toBe("aborted");
  });

  test("running → error 发 stop(error)（基线后新错误要红）", () => {
    snap = { tasks: [task({ status: "error", updatedAt: 2000 })] };
    poller.poll();
    expect(emitted[0].meta.status).toBe("error");
  });

  test("running → unknown 保守不发事件", () => {
    snap = { tasks: [task({ status: "unknown", updatedAt: 2000 })] };
    poller.poll();
    expect(emitted).toEqual([]);
  });

  test("状态不变但 updatedAt 前进：running 发 activity 刷活性（防 inactive 误报）", () => {
    snap = { tasks: [task({ status: "running", updatedAt: 5000 })] };
    poller.poll();
    expect(emitted.map((e) => e.event)).toEqual(["activity"]);
  });

  test("user_action 状态下 updatedAt 前进不发事件（activity 会误清黄灯）", () => {
    snap = { tasks: [task({ status: "user_action", updatedAt: 2000 })] };
    poller.poll();
    snap = { tasks: [task({ status: "user_action", updatedAt: 9000 })] };
    poller.poll();
    expect(emitted.map((e) => e.event)).toEqual(["user_action_required"]);
  });

  test("完全无变化的重复轮询不发任何事件（去重通知的根基）", () => {
    snap = { tasks: [task({ status: "running", updatedAt: 1000 })] };
    poller.poll();
    poller.poll();
    expect(emitted).toEqual([]);
  });

  test("基线后新出现的任务按当前状态发事件", () => {
    snap = { tasks: [task({ status: "running", updatedAt: 1000 }), task({ canonicalId: "n", taskId: "task-9", status: "user_action", updatedAt: 2000 })] };
    poller.poll();
    expect(emitted.map((e) => [e.sessionId, e.event])).toEqual([["n", "user_action_required"]]);
  });

  test("任务从快照消失：不视为完成，不发事件（交给 inactive/GC 兜底）", () => {
    snap = { tasks: [] };
    poller.poll();
    expect(emitted).toEqual([]);
  });

  test("终态任务的 updatedAt 变化不复活会话（ai_tracker 类活动不算状态）", () => {
    snap = { tasks: [task({ status: "completed", updatedAt: 2000 })] };
    poller.poll();
    emitted = [];
    snap = { tasks: [task({ status: "completed", updatedAt: 9000 })] };
    poller.poll();
    expect(emitted).toEqual([]);
  });

  test("读取失败（degraded）期间不发事件、不丢基线", () => {
    snap = null;
    poller.poll();
    snap = { tasks: [task({ status: "user_action", updatedAt: 2000 })] };
    poller.poll();
    expect(emitted.map((e) => e.event)).toEqual(["user_action_required"]); // 转移仍被识别
  });
});

describe("probeSnapshot（探针通路）", () => {
  test("running 任务返回执行中快照（防审批/卡死误报）", () => {
    snap = { tasks: [task({ status: "running" })] };
    poller.poll();
    const ps = poller.probeSnapshot("task-1.session.execution");
    expect(ps).toEqual({ pending: { kind: "none" }, executing: true, stuckCandidate: false, missedQuestion: false });
  });

  test("终态任务带 terminal 保险丝（diff 丢失兜底）", () => {
    snap = { tasks: [task({ status: "running" })] };
    poller.poll();
    snap = { tasks: [task({ status: "error", updatedAt: 2000 })] };
    // 不 poll：模拟 diff 事件丢失，probe 直接读最新快照
    const ps = poller.probeSnapshot("task-1.session.execution");
    expect(ps?.terminal?.status).toBe("error");
  });

  test("user_action 任务返回专属挂起类型（事件丢失时 probe 兜底补黄）", () => {
    snap = { tasks: [task({ status: "user_action" })] };
    poller.poll();
    const ps = poller.probeSnapshot("task-1.session.execution");
    expect(ps?.pending.kind).toBe("user_action_pending");
  });

  test("任务缺失返回中性快照（不误标降级）；读取失败返回 null（真降级）", () => {
    snap = { tasks: [] };
    poller.poll();
    expect(poller.probeSnapshot("ghost")?.pending.kind).toBe("none");
    snap = null;
    expect(poller.probeSnapshot("ghost")).toBeNull();
  });
});

describe("隐私边界（D6）", () => {
  test("poller 产出的所有事件不含 prompt 类字段（query/title/name/userRequirements/aiModifiedContent）", () => {
    snap = { tasks: [task({ status: "running" })] };
    poller.poll();
    snap = { tasks: [task({ status: "user_action", updatedAt: 2000 })] };
    poller.poll();
    snap = { tasks: [task({ status: "error", updatedAt: 3000 })] };
    poller.poll();
    expect(emitted.length).toBeGreaterThan(0);
    for (const ev of emitted) {
      for (const banned of ["query", "title", "name", "userRequirements", "aiModifiedContent"]) {
        expect(Object.keys(ev.meta)).not.toContain(banned);
      }
    }
  });
});

describe("taskInfo（显示名信息）", () => {
  test("最近轮询命中返回 taskId/workspacePath/displayName，未知会话返回 null", () => {
    snap = { tasks: [task({ status: "running" })] };
    poller.poll();
    expect(poller.taskInfo("task-1.session.execution")).toEqual({ taskId: "task-1", workspacePath: "/tmp/ws", displayName: "synthetic-display" });
    expect(poller.taskInfo("ghost")).toBeNull();
  });
});
