import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarks, persistMarks } from "./marks-store";

describe("marks 持久化", () => {
  test("保存后可加载还原", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tl-marks-")), "marks.json");
    const marks = new Map([["ack:cursor:s1:123", "456"], ["missed:cursor:s2", "789"]]);
    persistMarks(file, marks);
    expect(loadMarks(file)).toEqual(marks);
  });

  test("文件不存在返回空 Map", () => {
    expect(loadMarks(join(tmpdir(), "nope", "marks.json")).size).toBe(0);
  });

  test("文件损坏返回空 Map（不抛异常）", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tl-marks-")), "marks.json");
    persistMarks(file, new Map());
    require("node:fs").writeFileSync(file, "corrupt{");
    expect(loadMarks(file).size).toBe(0);
  });
});
