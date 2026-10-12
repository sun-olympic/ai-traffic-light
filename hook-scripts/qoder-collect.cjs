#!/usr/bin/env node
// AI Traffic Light — Qoder hook collector. Only allowlisted status metadata is persisted.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAPPING = {
  SessionStart: (p) => ({ event: "session_start", meta: {} }),
  UserPromptSubmit: () => ({ event: "prompt", meta: {} }),
  PreToolUse: (p) => String(p.tool_name || "").toLowerCase() === "askuserquestion"
    ? ({ event: "user_action_required", meta: { source: "question" } })
    : null,
  PermissionRequest: () => ({ event: "user_action_required", meta: {} }),
  PostToolUse: () => ({ event: "activity", meta: {} }),
  PostToolUseFailure: () => ({ event: "activity", meta: {} }),
  Stop: () => ({ event: "stop", meta: { status: "completed" } }),
  StopFailure: () => ({ event: "stop", meta: { status: "error" } }),
  SessionEnd: () => ({ event: "session_end", meta: {} }),
};

function main(raw) {
  const payload = JSON.parse(raw);
  const mapper = MAPPING[payload.hook_event_name];
  if (!mapper || !payload.session_id) return;
  const mapped = mapper(payload);
  if (!mapped) return;
  const { event, meta } = mapped;
  const line = JSON.stringify({ v: 3, tool: "qoder", sessionId: payload.session_id, event, ts: Date.now(), meta });
  const home = process.env.AI_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), ".ai-traffic-light");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(home, "events.jsonl"), line + "\n", { mode: 0o600 });
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try { main(input); } catch { /* collector must never interfere with Qoder */ }
  process.stdout.write("\n");
  process.exit(0);
});
