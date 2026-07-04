import { describe, expect, it } from "vitest";
import { codexCollectorState, type CodexCollectorEvidence } from "./collector-state";

const NOW = 1_700_000_000_000;
const base: CodexCollectorEvidence = {
  installed: true,
  featureDisabled: false,
  trusted: true,
  codexAlive: true,
  rolloutActivityAt: NOW,
  lastEventAt: NOW - 5_000,
};

describe("codexCollectorState 三态判定", () => {
  it("未安装", () => {
    expect(codexCollectorState({ ...base, installed: false })).toBe("not_installed");
  });

  it("引擎禁用（明确态，优先于信任判定）", () => {
    expect(codexCollectorState({ ...base, featureDisabled: true, trusted: false })).toBe("disabled");
  });

  it("信任记账缺失 → 已安装未生效", () => {
    expect(codexCollectorState({ ...base, trusted: false })).toBe("installed_inactive");
  });

  it("采集正常：事件紧跟 rollout 活动", () => {
    expect(codexCollectorState(base)).toBe("ok");
  });

  it("盲区兜底：rollout 在动但事件断流超窗口 → 未生效", () => {
    expect(codexCollectorState({ ...base, lastEventAt: NOW - 600_000 })).toBe("installed_inactive");
  });

  it("活跃迹象前置：Codex 未运行时断流不算未生效（正常闲置）", () => {
    expect(codexCollectorState({ ...base, codexAlive: false, lastEventAt: 0 })).toBe("ok");
  });

  it("活跃迹象前置：无 rollout 活动（装完没用过）不误报", () => {
    expect(codexCollectorState({ ...base, rolloutActivityAt: 0, lastEventAt: 0 })).toBe("ok");
  });

  it("首次生效窗口：事件仅落后 rollout 几十秒不判未生效", () => {
    expect(codexCollectorState({ ...base, lastEventAt: NOW - 60_000 })).toBe("ok");
  });
});
