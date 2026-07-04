import { describe, expect, test } from "vitest";
import { isTrailingQuestion, lastAssistantText } from "./trailing-question";
import { DEFAULT_CONFIG } from "../../shared/config";

const words = DEFAULT_CONFIG.questionWords;

describe("isTrailingQuestion", () => {
  test("结尾句带中文问号 → 命中", () => {
    expect(isTrailingQuestion("方案已列出。\n\n接下来做哪个方案？", words)).toBe(true);
  });

  test("结尾句带英文问号 → 命中", () => {
    expect(isTrailingQuestion("Done. Which option do you prefer?", words)).toBe(true);
  });

  test("命中疑问词表（无问号）→ 命中", () => {
    expect(isTrailingQuestion("修改完成。请确认是否合并到主分支", words)).toBe(true);
  });

  test("纯陈述结尾 → 不命中", () => {
    expect(isTrailingQuestion("已完成全部修改并通过测试。", words)).toBe(false);
  });

  test("问号在中间、结尾是陈述 → 不命中", () => {
    expect(isTrailingQuestion("你问的是什么？我已经处理完了。全部完成。", words)).toBe(false);
  });

  test("空文本 → 不命中", () => {
    expect(isTrailingQuestion("", words)).toBe(false);
  });
});

describe("lastAssistantText（cursor transcript JSONL 尾部解析）", () => {
  test("取最后一条 assistant 消息文本", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "帮我修 bug" }),
      JSON.stringify({ role: "assistant", content: "修好了。要不要跑一遍测试？" }),
    ].join("\n");
    expect(lastAssistantText(jsonl)).toBe("修好了。要不要跑一遍测试？");
  });

  test("content 为分段数组时拼接 text 段", () => {
    const jsonl = JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text: "第一段。" },
        { type: "tool_use", name: "Shell" },
        { type: "text", text: "选哪个方案？" },
      ],
    });
    expect(lastAssistantText(jsonl)).toBe("第一段。\n选哪个方案？");
  });

  test("无 assistant 消息返回 null", () => {
    expect(lastAssistantText(JSON.stringify({ role: "user", content: "hi" }))).toBeNull();
  });

  test("坏行被跳过", () => {
    const jsonl = ["not-json{", JSON.stringify({ role: "assistant", content: "好了吗？" })].join("\n");
    expect(lastAssistantText(jsonl)).toBe("好了吗？");
  });

  test("真实 Cursor 格式：content 嵌套在 message 下", () => {
    const jsonl = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "介绍快排" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "……需要的话告诉我用什么语言。" }] } }),
    ].join("\n");
    expect(lastAssistantText(jsonl)).toBe("……需要的话告诉我用什么语言。");
  });
});
