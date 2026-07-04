import { describe, expect, test } from "vitest";
import { t, MESSAGES } from "./i18n";

describe("i18n", () => {
  test("中文取中文文案", () => {
    expect(t("zh", "waiting_question")).toBe("等待提问确认");
  });

  test("英文取英文文案", () => {
    expect(t("en", "waiting_question")).toBe("Waiting for answer");
  });

  test("带插值参数", () => {
    expect(t("zh", "notif_missed_body", { name: "会话A" })).toBe("会话A 的提问已被自动处理");
    expect(t("en", "notif_missed_body", { name: "Chat A" })).toBe("A question in Chat A was auto-handled");
  });

  test("中英文案表键一致（防漏翻）", () => {
    expect(Object.keys(MESSAGES.zh).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });
});
