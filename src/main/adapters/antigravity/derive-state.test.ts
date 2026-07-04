import { describe, expect, test } from "vitest";
import { deriveObservation } from "./derive-state";
import type { StepRow } from "./db-reader";

// 全合成结构行：仅 idx/step_type/status/error_details（spec：Fixtures are sanitized）
function row(idx: number, status: number, errorDetails: string | null = null, stepType = 5): StepRow {
  return { idx, stepType, status, errorDetails };
}

describe("deriveObservation（D3/D7/D10/D26/D30 结构状态推导）", () => {
  test("空行 / 全 unknown / 全 cleared → unknown（保守，D18）", () => {
    expect(deriveObservation([]).kind).toBe("unknown");
    expect(deriveObservation([row(0, 0), row(1, 10)]).kind).toBe("unknown");
    expect(deriveObservation([row(0, 5)]).kind).toBe("unknown");
  });

  test("存在 active 步且不落后于 waiting/终态 → running", () => {
    const obs = deriveObservation([row(0, 3), row(1, 2)]);
    expect(obs.kind).toBe("running");
    expect(obs.maxIdx).toBe(1);
    expect(obs.evidenceIdx).toBe(1);
  });

  test("waiting 是最新证据 → waiting（等待用户操作，D7）", () => {
    const obs = deriveObservation([row(0, 3), row(1, 3), row(2, 9)]);
    expect(obs.kind).toBe("waiting");
    expect(obs.evidenceIdx).toBe(2);
  });

  test("waiting 之后有更新的 active 进展 → running（活动清黄，D30）", () => {
    expect(deriveObservation([row(0, 9), row(1, 2)]).kind).toBe("running");
  });

  test("waiting 之后有更新的终态 → 终态胜出（完成清黄，D30）", () => {
    expect(deriveObservation([row(0, 9), row(1, 3)]).kind).toBe("completed");
  });

  test("同 idx 平手时偏保守取 waiting（waiting beats running/terminal）", () => {
    expect(deriveObservation([row(2, 9), row(2, 2)]).kind).toBe("waiting");
    expect(deriveObservation([row(2, 9), row(2, 3)]).kind).toBe("waiting");
  });

  test("最新终态 DONE → completed；evidence 为该行 idx", () => {
    const obs = deriveObservation([row(0, 3), row(1, 3)]);
    expect(obs.kind).toBe("completed");
    expect(obs.evidenceIdx).toBe(1);
    expect(obs.maxIdx).toBe(1);
  });

  test("CANCELED 终态 → aborted（不红，D10）", () => {
    expect(deriveObservation([row(0, 3), row(1, 6)]).kind).toBe("aborted");
  });

  test("ERROR 终态 + 取消文案 → aborted（取消护栏，D10）", () => {
    expect(deriveObservation([row(0, 3), row(1, 7, "context canceled")]).kind).toBe("aborted");
    expect(deriveObservation([row(0, 3), row(1, 4, "user cancelled")]).kind).toBe("aborted");
  });

  test("ERROR 终态非取消 → error（红灯候选）", () => {
    const obs = deriveObservation([row(0, 3), row(1, 7, "quota exceeded")]);
    expect(obs.kind).toBe("error");
    expect(obs.evidenceIdx).toBe(1);
  });

  test("终态后只有 unknown/cleared 尾行 → 终态不被稀释（最后行不权威，D26）", () => {
    expect(deriveObservation([row(0, 3), row(1, 7, "boom"), row(2, 0), row(3, 5)]).kind).toBe("error");
  });

  test("历史 waiting 行 + 更晚 error → error（证据序比较，D30）", () => {
    expect(deriveObservation([row(0, 9), row(1, 7, "boom")]).kind).toBe("error");
  });

  test("maxIdx 始终是全表最大 idx（高水位，含 unknown 尾行）", () => {
    expect(deriveObservation([row(0, 3), row(5, 0)]).maxIdx).toBe(5);
  });
});
