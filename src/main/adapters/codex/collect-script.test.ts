import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../../../../hook-scripts/codex-collect.cjs");

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
  session_id: "019f-abc",
  transcript_path: "/Users/x/.codex/sessions/2026/07/04/rollout-2026-07-04T09-14-02-019f-abc.jsonl",
  cwd: "/Users/x/proj",
  model: "gpt-5.5",
  permission_mode: "default",
};

describe("codex hook 采集脚本", () => {
  test("PermissionRequest → approval_request（v2），meta 仅含 toolName 与命令文本", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    const out = runHook(
      JSON.stringify({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build", junk: "机密路径" } }),
      dir,
    );
    expect(out.trim()).toBe("{}");
    const evs = eventsOf(dir);
    expect(evs).toHaveLength(1);
    expect(evs[0].v).toBe(2);
    expect(evs[0].tool).toBe("codex");
    expect(evs[0].sessionId).toBe("019f-abc");
    expect(evs[0].event).toBe("approval_request");
    const meta = evs[0].meta as Record<string, unknown>;
    expect(meta.toolName).toBe("Bash");
    expect(meta.command).toBe("rm -rf build");
    expect(JSON.stringify(evs[0])).not.toContain("机密路径");
  });

  test("UserPromptSubmit → prompt，不落盘 prompt 全文，meta 带 transcriptPath（probe 定位用）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "机密需求全文" }), dir);
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("prompt");
    expect((evs[0].meta as Record<string, unknown>).transcriptPath).toBe(base.transcript_path);
    expect(JSON.stringify(evs[0])).not.toContain("机密需求");
  });

  test("Stop → stop 无 status（resolver 回读补齐），丢弃 last_assistant_message 全文", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "Stop", last_assistant_message: "机密回答全文" }), dir);
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("stop");
    const meta = evs[0].meta as Record<string, unknown>;
    expect(meta.status).toBeUndefined();
    expect(meta.transcriptPath).toBe(base.transcript_path);
    expect(JSON.stringify(evs[0])).not.toContain("机密回答");
  });

  test("SessionStart → session_start，保留 source（resume 复活规则用）与 transcriptPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(JSON.stringify({ ...base, hook_event_name: "SessionStart", source: "resume" }), dir);
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("session_start");
    const meta = evs[0].meta as Record<string, unknown>;
    expect(meta.source).toBe("resume");
    expect(meta.transcriptPath).toBe(base.transcript_path);
  });

  test("PostToolUse → after_exec，meta 含 toolName/command，丢弃 tool_response", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    runHook(
      JSON.stringify({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "机密输出" }),
      dir,
    );
    const evs = eventsOf(dir);
    expect(evs[0].event).toBe("after_exec");
    expect((evs[0].meta as Record<string, unknown>).toolName).toBe("Bash");
    expect(JSON.stringify(evs[0])).not.toContain("机密输出");
  });

  test("SubagentStart/SubagentStop/PreToolUse 不落事件", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    for (const name of ["SubagentStart", "SubagentStop", "PreToolUse"]) {
      const out = runHook(JSON.stringify({ ...base, hook_event_name: name, tool_name: "Bash" }), dir);
      expect(out.trim()).toBe("{}");
    }
    expect(eventsOf(dir)).toHaveLength(0);
  });

  test("非法 JSON / 缺 session_id → 静默且输出 {}，不写事件", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-"));
    expect(runHook("not-json{", dir).trim()).toBe("{}");
    expect(runHook(JSON.stringify({ hook_event_name: "Stop" }), dir).trim()).toBe("{}");
    expect(eventsOf(dir)).toHaveLength(0);
  });
});
