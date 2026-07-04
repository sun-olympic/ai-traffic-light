#!/usr/bin/env node
// AI Traffic Light — Codex hook 采集脚本（单文件，无依赖）
// 职责：读 stdin 的 Codex hook JSON → 白名单裁剪 → 追加 ~/.ai-traffic-light/events.jsonl → 输出 {}
// 任何内部错误静默吞掉且仍输出 {}，绝不干预 Codex 行为（不注入 decision）。
// 注意：本脚本内容可自由升级（信任哈希只锁 hooks.json 条目定义，spike 1.4 实证）。
const SCRIPT_VERSION = 1;
const SCHEMA_VERSION = 2;

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// hook_event_name → 标准化事件类型 + meta 白名单提取器。
// PreToolUse 不安装也不映射（spike 1.3：批准瞬间无重触发，装了无收益纯成本）；
// SubagentStart/SubagentStop 的 session_id 是父会话，落盘会干扰主 agent 判定 → 忽略。
// transcriptPath（rollout 全路径）随 session_start/prompt/stop 落盘，probe 与 stop 回读直接用。
const MAPPING = {
  SessionStart: (p) => ({ event: "session_start", meta: { source: p.source, transcriptPath: p.transcript_path } }),
  UserPromptSubmit: (p) => ({ event: "prompt", meta: { transcriptPath: p.transcript_path } }),
  PermissionRequest: (p) => ({ event: "approval_request", meta: { toolName: p.tool_name, command: p.tool_input && p.tool_input.command } }),
  PostToolUse: (p) => ({ event: "after_exec", meta: { toolName: p.tool_name, command: p.tool_input && p.tool_input.command } }),
  // 无 status：终态由 App 侧 stopStatusResolver 回读 rollout 尾部补齐（Stop hook 只在正常完成触发，spike 1.2）
  Stop: (p) => ({ event: "stop", meta: { transcriptPath: p.transcript_path } }),
};

function main(raw) {
  const payload = JSON.parse(raw);
  const mapper = MAPPING[payload.hook_event_name];
  if (!mapper) return;
  const sessionId = payload.session_id;
  if (!sessionId) return;
  const { event, meta } = mapper(payload);
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  const line = JSON.stringify({ v: SCHEMA_VERSION, tool: "codex", sessionId, event, ts: Date.now(), meta });

  const home = process.env.AI_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), ".ai-traffic-light");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(home, "events.jsonl"), line + "\n", { mode: 0o600 });
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    main(input);
  } catch {
    // 静默：采集失败绝不影响 Codex
  }
  // {} 对所有已装 hook 事件都是合法输出（Stop 要求合法 JSON 或空、PermissionRequest 无 decision 即不干预）
  process.stdout.write("{}\n");
  process.exit(0);
});
