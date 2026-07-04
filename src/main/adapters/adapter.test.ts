import { describe, expect, test } from "vitest";
import { validateAdapter, type StopResolution, type ToolAdapter } from "./adapter";

function makeAdapter(overrides: Partial<ToolAdapter>): ToolAdapter {
  return {
    tool: "fake",
    capabilities: { yellow: "none", red: "none", metadata: false },
    collector: {
      install: async () => {},
      uninstall: async () => {},
      status: async () => ({ installed: false }),
    },
    isAlive: async () => false,
    ...overrides,
  };
}

describe("validateAdapter", () => {
  test("yellow=exact 且提供 probe（探针来源）→ 校验通过", () => {
    const a = makeAdapter({
      capabilities: { yellow: "exact", red: "none", metadata: false },
      probe: async () => ({ kind: "none" }),
    });
    expect(validateAdapter(a)).toEqual([]);
  });

  test("yellow=exact 且声明推送来源（无 probe）→ 校验通过", () => {
    const a = makeAdapter({
      capabilities: { yellow: "exact", red: "none", metadata: false, yellowPush: true },
    });
    expect(validateAdapter(a)).toEqual([]);
  });

  test("yellow=exact 但既无 probe 也未声明推送 → 校验失败", () => {
    const a = makeAdapter({
      capabilities: { yellow: "exact", red: "none", metadata: false },
    });
    expect(validateAdapter(a)).toHaveLength(1);
  });

  test("metadata=true 但未提供 metadata() → 校验失败", () => {
    const a = makeAdapter({
      capabilities: { yellow: "none", red: "none", metadata: true },
    });
    expect(validateAdapter(a)).toHaveLength(1);
  });

  test("yellow=none 无任何可选实现 → 校验通过（能力降级合法）", () => {
    expect(validateAdapter(makeAdapter({}))).toEqual([]);
  });
});

describe("stopStatusResolver 接口", () => {
  test("adapter 可声明 stopStatusResolver 并返回 status + lastAssistantMessage", async () => {
    const resolution: StopResolution = { status: "aborted", lastAssistantMessage: null };
    const a = makeAdapter({
      stopStatusResolver: async () => resolution,
    });
    const got = await a.stopStatusResolver!("sid-1", "/path/rollout.jsonl");
    expect(got).toEqual({ status: "aborted", lastAssistantMessage: null });
  });
});
