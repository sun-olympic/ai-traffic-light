import { describe, expect, test } from "vitest";
import { classifyStepStatus, isCancelText } from "./status-map";

describe("classifyStepStatus（D3 CortexStepStatus 数值映射）", () => {
  test("active 族：PENDING/RUNNING/GENERATING/QUEUED", () => {
    for (const v of [1, 2, 8, 11]) expect(classifyStepStatus(v)).toBe("active");
  });
  test("WAITING=9 → waiting", () => {
    expect(classifyStepStatus(9)).toBe("waiting");
  });
  test("DONE=3 → done", () => {
    expect(classifyStepStatus(3)).toBe("done");
  });
  test("CANCELED=6 → canceled", () => {
    expect(classifyStepStatus(6)).toBe("canceled");
  });
  test("ERROR=7 / INVALID=4 → error 候选", () => {
    expect(classifyStepStatus(7)).toBe("error");
    expect(classifyStepStatus(4)).toBe("error");
  });
  test("CLEARED=5 → cleared（终态但不算 active）", () => {
    expect(classifyStepStatus(5)).toBe("cleared");
  });
  test("保守 unknown：UNSPECIFIED=0、保留值 10/HALTED、INTERRUPTED=12、未来新值", () => {
    for (const v of [0, 10, 12, 13, 99, -1]) expect(classifyStepStatus(v)).toBe("unknown");
  });
});

describe("isCancelText（D10 取消护栏）", () => {
  test("取消/用户中止词命中（大小写与英式拼写变体）", () => {
    for (const s of [
      "context canceled",
      "Context Cancelled: rpc error",
      "user canceled the operation",
      "user cancelled",
      "task was cancelled by user",
      "canceled by user",
      "manage_task cancel requested",
      "operation aborted",
    ]) {
      expect(isCancelText(s)).toBe(true);
    }
  });
  test("非取消错误不命中", () => {
    for (const s of ["quota exceeded", "network unreachable", "model returned malformed output", ""]) {
      expect(isCancelText(s)).toBe(false);
    }
  });
});
