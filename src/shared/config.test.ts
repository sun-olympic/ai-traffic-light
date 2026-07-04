import { describe, expect, test } from "vitest";
import { CONFIG_VERSION, DEFAULT_CONFIG, mergeConfig } from "./config";

describe("mergeConfig", () => {
  test("空输入返回完整默认配置（带版本）", () => {
    const cfg = mergeConfig(undefined);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.v).toBe(CONFIG_VERSION);
  });

  test("部分字段覆盖默认值，其余保留", () => {
    const cfg = mergeConfig({ approvalThresholdMs: 30000 });
    expect(cfg.approvalThresholdMs).toBe(30000);
    expect(cfg.stuckThresholdMs).toBe(DEFAULT_CONFIG.stuckThresholdMs);
  });

  test("旧版本配置合并后版本号提升为当前", () => {
    const cfg = mergeConfig({ v: 0, approvalThresholdMs: 20000 });
    expect(cfg.v).toBe(CONFIG_VERSION);
    expect(cfg.approvalThresholdMs).toBe(20000);
  });

  test("默认白名单包含常见长命令", () => {
    expect(DEFAULT_CONFIG.shellWhitelist.some((p) => "npm install".includes(p) || p.includes("install"))).toBe(true);
  });

  test("非法类型的字段回退默认值", () => {
    const cfg = mergeConfig({ approvalThresholdMs: "oops" as unknown as number });
    expect(cfg.approvalThresholdMs).toBe(DEFAULT_CONFIG.approvalThresholdMs);
  });
});
