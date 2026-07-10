import { beforeEach, describe, expect, test } from "vitest";
import type { TrafficEvent } from "../../../shared/events";
import { WorkbuddyPoller } from "./poller";
import type { WorkbuddySnapshot, WorkbuddySession } from "./db-reader";

let now: number;
let snap: WorkbuddySnapshot | null;
let emitted: TrafficEvent[];
let poller: WorkbuddyPoller;
let inputPending: boolean;

function session(overrides: Partial<WorkbuddySession> = {}): WorkbuddySession {
  return {
    sessionId: "s1",
    status: "running",
    updatedAt: 1000,
    title: null,
    customTitle: null,
    cwd: "/tmp/project",
    ...overrides,
  };
}

beforeEach(() => {
  now = 1_783_578_600_000;
  snap = { sessions: [] };
  emitted = [];
  inputPending = false;
  poller = new WorkbuddyPoller({
    read: () => snap,
    emit: (ev) => emitted.push(ev),
    clock: () => now,
    userInputPending: () => inputPending,
  });
});

describe("WorkbuddyPoller", () => {
  test("running baseline with a WorkBuddy-owned input prompt emits user_action_required instead of activity", () => {
    inputPending = true;
    snap = { sessions: [session({ status: "running" })] };

    poller.poll();

    expect(emitted.map((ev) => [ev.event, ev.meta])).toEqual([
      ["session_start", {}],
      ["user_action_required", {}],
    ]);
    expect(poller.probeSnapshot("s1")).toMatchObject({
      pending: { kind: "user_action_pending" },
      executing: false,
    });
  });

  test("running session turns yellow when an input prompt appears without status change", () => {
    snap = { sessions: [session({ status: "running", updatedAt: 1000 })] };
    poller.poll();
    emitted = [];

    inputPending = true;
    poller.poll();

    expect(emitted.map((ev) => ev.event)).toEqual(["user_action_required"]);
  });

  test("fresh completed baseline emits stop instead of activity", () => {
    snap = { sessions: [session({ status: "completed", updatedAt: now - 5_000 })] };

    poller.poll();

    expect(emitted.map((ev) => [ev.event, ev.meta])).toEqual([
      ["session_start", {}],
      ["stop", { status: "completed", resolvedLastMessage: null }],
    ]);
  });

  test("heartbeat-only progress updates probe changeToken without emitting activity events", () => {
    snap = { sessions: [session({ runtimeUpdatedAt: 2000 })] };
    poller.poll();
    emitted = [];

    expect(poller.probeSnapshot("s1")).toMatchObject({
      executing: true,
      changeToken: "running:2000",
    });

    snap = { sessions: [session({ runtimeUpdatedAt: 3000 })] };
    poller.poll();

    expect(emitted).toEqual([]);
    expect(poller.probeSnapshot("s1")).toMatchObject({
      executing: true,
      changeToken: "running:3000",
    });
  });
});
