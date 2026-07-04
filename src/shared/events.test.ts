import { describe, expect, test } from "vitest";
import { EVENT_SCHEMA_VERSION, parseEventLine, serializeEvent, type TrafficEvent } from "./events";

const valid: TrafficEvent = {
  v: EVENT_SCHEMA_VERSION,
  tool: "cursor",
  sessionId: "abc-123",
  event: "prompt",
  ts: 1783070000000,
  meta: {},
};

describe("parseEventLine", () => {
  test("解析合法事件行", () => {
    const line = JSON.stringify(valid);
    expect(parseEventLine(line)).toEqual(valid);
  });

  test("serialize 后可 parse 回原事件", () => {
    expect(parseEventLine(serializeEvent(valid))).toEqual(valid);
  });

  test("非法 JSON 返回 null", () => {
    expect(parseEventLine("not-json{")).toBeNull();
  });

  test("缺少必填字段返回 null", () => {
    const { sessionId: _drop, ...rest } = valid;
    expect(parseEventLine(JSON.stringify(rest))).toBeNull();
  });

  test("未知事件类型返回 null", () => {
    expect(parseEventLine(JSON.stringify({ ...valid, event: "weird" }))).toBeNull();
  });

  test("旧版本事件（v=0）仍可解析（向前兼容）", () => {
    const old = { ...valid, v: 0 };
    const parsed = parseEventLine(JSON.stringify(old));
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe("abc-123");
  });

  test("meta 缺失时补空对象", () => {
    const { meta: _drop, ...rest } = valid;
    const parsed = parseEventLine(JSON.stringify(rest));
    expect(parsed?.meta).toEqual({});
  });
});

describe("schema v3: user_action_required", () => {
  test("当前 schema 版本为 3", () => {
    expect(EVENT_SCHEMA_VERSION).toBe(3);
  });

  test("解析 v3 user_action_required 事件", () => {
    const ev = {
      v: 3,
      tool: "qoder",
      sessionId: "task-1.session.execution",
      event: "user_action_required",
      ts: 1783150000000,
      meta: {},
    };
    expect(parseEventLine(JSON.stringify(ev))).toEqual(ev);
  });

  test("v2 codex 事件回放不受影响（向前兼容）", () => {
    const v2 = {
      v: 2,
      tool: "codex",
      sessionId: "th-1",
      event: "approval_request",
      ts: 1783124000000,
      meta: { toolName: "Bash" },
    };
    expect(parseEventLine(JSON.stringify(v2))).toEqual(v2);
  });
});

describe("schema v2: approval_request", () => {

  test("解析 v2 approval_request 事件", () => {
    const ev = {
      v: 2,
      tool: "codex",
      sessionId: "th-1",
      event: "approval_request",
      ts: 1783124000000,
      meta: { toolName: "Bash", command: "rm -rf build" },
    };
    const parsed = parseEventLine(JSON.stringify(ev));
    expect(parsed).toEqual(ev);
  });

  test("v1 cursor 事件回放不受影响（向前兼容）", () => {
    const v1 = { ...valid, v: 1 };
    expect(parseEventLine(JSON.stringify(v1))).toEqual(v1);
  });

  test("超过当前版本的事件拒收", () => {
    expect(parseEventLine(JSON.stringify({ ...valid, v: 4 }))).toBeNull();
  });
});
