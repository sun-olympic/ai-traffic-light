import { beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAntigravityTranscriptTail } from "./transcript-tail";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tl-agy-tt-"));
});

function logsDir(sessionId: string): string {
  const d = join(home, "brain", sessionId, ".system_generated", "logs");
  mkdirSync(d, { recursive: true });
  return d;
}

// 全合成行（spec：Fixtures are sanitized）：content 只是占位问句/文本
function line(source: string, content: unknown): string {
  return JSON.stringify({ type: "message", status: "DONE", source, step_index: 1, created_at: 1, content });
}

describe("readAntigravityTranscriptTail（D38 有界尾部解析）", () => {
  test("brain 目录/transcript 缺失 → null（跳过尾问，不报错）", () => {
    expect(readAntigravityTranscriptTail(home, "nope")).toBeNull();
    logsDir("empty-s");
    expect(readAntigravityTranscriptTail(home, "empty-s")).toBeNull();
  });

  test("取最后一条 assistant 文本行（其后的非 assistant 行不干扰）", () => {
    const d = logsDir("s1");
    writeFileSync(join(d, "transcript.jsonl"), [line("assistant", "第一句"), line("assistant", "要继续吗？"), line("tool", "tool-output"), line("user", "ok")].join("\n"));
    expect(readAntigravityTranscriptTail(home, "s1")).toBe("要继续吗？");
  });

  test("无 assistant 行 / content 非字符串 → null（保守，D38）", () => {
    const d = logsDir("s2");
    writeFileSync(join(d, "transcript.jsonl"), [line("tool", "x"), line("assistant", { rich: "object" })].join("\n"));
    expect(readAntigravityTranscriptTail(home, "s2")).toBeNull();
  });

  test("坏 JSON 行忽略，不影响其余行", () => {
    const d = logsDir("s3");
    writeFileSync(join(d, "transcript.jsonl"), ["{broken", line("assistant", "好了吗？"), "also-broken"].join("\n"));
    expect(readAntigravityTranscriptTail(home, "s3")).toBe("好了吗？");
  });

  test("只读尾部窗口（maxBytes）：窗口外的 assistant 行不可见", () => {
    const d = logsDir("s4");
    const early = line("assistant", "很早的回答");
    const filler = line("tool", "y".repeat(200));
    writeFileSync(join(d, "transcript.jsonl"), [early, filler, line("tool", "tail-noise")].join("\n"));
    // 窗口只覆盖最后两行 → 无 assistant → null
    expect(readAntigravityTranscriptTail(home, "s4", 300)).toBeNull();
  });

  test("多个 transcript 文件取 mtime 最新的", () => {
    const d = logsDir("s5");
    const p1 = join(d, "transcript.jsonl");
    const p2 = join(d, "transcript_2.jsonl");
    writeFileSync(p1, line("assistant", "旧文件"));
    writeFileSync(p2, line("assistant", "新文件"));
    utimesSync(p1, 1000, 1000);
    utimesSync(p2, 2000, 2000);
    expect(readAntigravityTranscriptTail(home, "s5")).toBe("新文件");
  });
});
