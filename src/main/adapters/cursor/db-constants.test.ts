import { describe, expect, test } from "vitest";
import { BUBBLE_RANGE_SQL, bubbleRangeParams, COMPOSER_DATA_SQL, composerDataParams } from "./db-constants";

describe("state.vscdb SQL 常量", () => {
  test("气泡查询走主键范围而非 LIKE 全表扫描", () => {
    expect(BUBBLE_RANGE_SQL).not.toMatch(/LIKE/i);
    expect(BUBBLE_RANGE_SQL).toContain("key > ?");
    expect(BUBBLE_RANGE_SQL).toContain("key < ?");
    expect(BUBBLE_RANGE_SQL).toMatch(/ORDER BY rowid DESC/i);
    expect(BUBBLE_RANGE_SQL).toContain("LIMIT ?");
  });

  test("气泡范围参数按 sessionId 拼出上下界", () => {
    expect(bubbleRangeParams("abc", 6)).toEqual(["bubbleId:abc:", "bubbleId:abc:zzzzzzzz", 6]);
  });

  test("composerData 查询按精确 key 取值", () => {
    expect(COMPOSER_DATA_SQL).toContain("key = ?");
    expect(composerDataParams("abc")).toEqual(["composerData:abc"]);
  });
});
