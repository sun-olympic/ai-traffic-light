#!/usr/bin/env node
// AI Traffic Light — Cursor hook 采集脚本（单文件，无依赖）
// 职责：读 stdin 的 Cursor hook JSON → 白名单裁剪 → 追加 ~/.ai-traffic-light/events.jsonl → 输出 {}
// 任何内部错误静默吞掉且仍输出 {}，绝不干预 agent 行为。
// 版本号供安装器校验刷新（design.md D4）。
const SCRIPT_VERSION = 2;
const SCHEMA_VERSION = 1;

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// hook_event_name → 标准化事件类型 + meta 白名单提取器
const MAPPING = {
  beforeSubmitPrompt: (p) => ({ event: "prompt", meta: {} }),
  stop: (p) => ({ event: "stop", meta: { status: p.status, transcriptPath: p.transcript_path } }),
  sessionStart: (p) => ({ event: "session_start", meta: { isBackgroundAgent: !!p.is_background_agent } }),
  sessionEnd: (p) => ({ event: "session_end", meta: {} }),
  beforeShellExecution: (p) => ({ event: "before_exec", meta: { kind: "shell", command: p.command } }),
  afterShellExecution: (p) => ({ event: "after_exec", meta: { kind: "shell", command: p.command, duration: p.duration } }),
  beforeMCPExecution: (p) => ({ event: "before_exec", meta: { kind: "mcp", toolName: p.tool_name } }),
  afterMCPExecution: (p) => ({ event: "after_exec", meta: { kind: "mcp", toolName: p.tool_name } }),
  // 读/写文件是 agent 恢复活动最早的可观测信号（AskQuestion 作答本身无 hook，DB 写入有 ~15s 延迟）
  afterFileEdit: () => ({ event: "activity", meta: {} }),
  beforeReadFile: () => ({ event: "activity", meta: {} }),
};

function main(raw) {
  const payload = JSON.parse(raw);
  const mapper = MAPPING[payload.hook_event_name];
  if (!mapper) return;
  const sessionId = payload.conversation_id || payload.session_id;
  if (!sessionId) return;
  const { event, meta } = mapper(payload);
  // 裁剪 undefined 字段，保持行紧凑
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  const line = JSON.stringify({ v: SCHEMA_VERSION, tool: "cursor", sessionId, event, ts: Date.now(), meta });

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
    // 静默：采集失败绝不影响 agent
  }
  process.stdout.write("{}\n");
  process.exit(0);
});
