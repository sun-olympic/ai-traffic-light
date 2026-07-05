import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../../../../hook-scripts/cursor-collect.cjs");

function runHook(stdin: string, dir: string): string {
  return execFileSync("node", [SCRIPT], {
    input: stdin,
    env: { ...process.env, AI_TRAFFIC_LIGHT_HOME: dir },
    encoding: "utf-8",
  });
}

function eventsOf(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const base = {
  conversation_id: "conv-1",
  session_id: "conv-1",
  cursor_version: "3.5.38",
  transcript_path: "/tmp/t.jsonl",
};

describe("cursor hook 采集脚本", () => {
  test("beforeSubmitPrompt 映射为 prompt 事件且不落盘 prompt 全文", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    const out = runHook(
      JSON.stringify({ ...base, hook_event_name: "beforeSubmitPrompt", prompt: "机密内容不能落盘" }),
      dir,
    );
    expect(out.trim()).toBe("{}");
    const evs = eventsOf(dir);
    expect(evs).toHaveLength(1);
    expect(evs[0].event).toBe("prompt");
    expect(evs[0].sessionId).toBe("conv-1");
    expect(evs[0].tool).toBe("cursor");
    expect(JSON.stringify(evs[0])).not.toContain("机密内容");
  });

  test("stop 事件保留 status 与 transcriptPath（结尾提问判定用）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "stop", status: "error" }), dir);
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("stop");
    expect((evs[0].meta as Record<string, unknown>).status).toBe("error");
    expect((evs[0].meta as Record<string, unknown>).transcriptPath).toBe("/tmp/t.jsonl");
  });

  test("sessionStart 保留 is_background_agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "sessionStart", is_background_agent: true }), dir);
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("session_start");
    expect((evs[0].meta as Record<string, unknown>).isBackgroundAgent).toBe(true);
  });

  test("afterFileEdit/beforeReadFile 映射为 activity 且不落盘文件路径与内容", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "afterFileEdit", file_path: "/secret/a.ts", edits: [{ old_string: "机密" }] }), dir);
    runHook(JSON.stringify({ ...base, hook_event_name: "beforeReadFile", file_path: "/secret/b.ts", content: "机密内容" }), dir);
    const evs = eventsOf(dir);
    expect(evs.map((e) => e.event)).toEqual(["activity", "activity"]);
    expect(JSON.stringify(evs)).not.toContain("secret");
    expect(JSON.stringify(evs)).not.toContain("机密");
  });

  test("beforeShellExecution 保留命令文本，afterShellExecution 丢弃命令输出", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "beforeShellExecution", command: "npm install" }), dir);
    runHook(
      JSON.stringify({ ...base, hook_event_name: "afterShellExecution", command: "npm install", output: "超长输出不落盘", duration: 12 }),
      dir,
    );
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("before_exec");
    expect((evs[0].meta as Record<string, unknown>).command).toBe("npm install");
    expect(evs[1].event).toBe("after_exec");
    expect(JSON.stringify(evs[1])).not.toContain("超长输出");
  });

  test("beforeMCPExecution 保留 tool_name 与 kind=mcp", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "beforeMCPExecution", tool_name: "search", tool_input: { q: "secret" } }), dir);
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("before_exec");
    expect((evs[0].meta as Record<string, unknown>).kind).toBe("mcp");
    expect((evs[0].meta as Record<string, unknown>).toolName).toBe("search");
    expect(JSON.stringify(evs[0])).not.toContain("secret");
  });

  test("sessionEnd 映射为 session_end", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "sessionEnd" }), dir);
    expect(eventsOf(dir)[0].event).toBe("session_end");
  });

  test("非法 JSON stdin：仍输出 {} 且退出码 0，不写事件", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    const out = runHook("not-json{{{", dir);
    expect(out.trim()).toBe("{}");
    expect(eventsOf(dir)).toHaveLength(0);
  });

  test("未知 hook 事件：输出 {} 且不写事件", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    const out = runHook(JSON.stringify({ ...base, hook_event_name: "someFutureHook" }), dir);
    expect(out.trim()).toBe("{}");
    expect(eventsOf(dir)).toHaveLength(0);
  });

  // Windows 无 POSIX 权限位，chmod 400 不生效
  test.skipIf(process.platform === "win32")("目录不可写：仍输出 {} 且退出码 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    chmodSync(dir, 0o400);
    try {
      const out = runHook(JSON.stringify({ ...base, hook_event_name: "stop", status: "completed" }), dir);
      expect(out.trim()).toBe("{}");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("事件带 schema 版本号 v=1 与时间戳", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    const before = Date.now();
    runHook(JSON.stringify({ ...base, hook_event_name: "stop", status: "completed" }), dir);
    const ev = eventsOf(dir)[0];
    expect(ev.v).toBe(1);
    expect(ev.ts as number).toBeGreaterThanOrEqual(before);
  });
});
