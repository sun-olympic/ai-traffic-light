import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../../../../hook-scripts/qoder-collect.cjs");

function runHook(payload: Record<string, unknown>, dir: string): string {
  return execFileSync("node", [SCRIPT], { input: JSON.stringify(payload), env: { ...process.env, AI_TRAFFIC_LIGHT_HOME: dir }, encoding: "utf8" });
}

function events(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("Qoder hook collector", () => {
  test("maps task lifecycle events without persisting prompt or tool output", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-qoder-hook-"));
    const base = { session_id: "qoder-session", cwd: "/work/project" };
    for (const payload of [
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "private prompt" },
      { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "private output" },
      { ...base, hook_event_name: "Stop" },
      { ...base, hook_event_name: "QueryEnd" },
      { ...base, hook_event_name: "StopFailure" },
    ]) expect(runHook(payload, dir).trim()).toBe("");
    const evs = events(dir);
    expect(evs.map((event) => event.event)).toEqual(["prompt", "activity", "stop", "stop"]);
    expect(evs.map((event) => (event.meta as Record<string, unknown>).status)).toEqual([undefined, undefined, "completed", "error"]);
    expect(JSON.stringify(evs)).not.toContain("private");
  });

  test("permission request becomes user-action state and ignores malformed or child-agent payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-qoder-hook-"));
    runHook({ session_id: "q1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push" } }, dir);
    runHook({ session_id: "q1", hook_event_name: "SubagentStop" }, dir);
    expect(events(dir).map((event) => event.event)).toEqual(["user_action_required"]);
  });

  test("AskUserQuestion pre-tool hook becomes user-action state but ordinary tools stay silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-qoder-hook-"));
    runHook({ session_id: "q1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }, dir);
    runHook({ session_id: "q1", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Pick one?" }] } }, dir);
    expect(events(dir).map((event) => event.event)).toEqual(["user_action_required"]);
    expect(events(dir)[0].meta).toEqual({ source: "question" });
    expect(JSON.stringify(events(dir))).not.toContain("Pick one?");
  });
});
