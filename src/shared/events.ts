// 工具无关的标准化事件 schema（design.md D3）
// v2: 新增 approval_request（Codex PermissionRequest 推送型精确审批信号）
// v3: 新增 user_action_required（Qoder ActionRequired 等泛化用户操作等待，非命令审批）
export const EVENT_SCHEMA_VERSION = 3;

export const EVENT_TYPES = [
  "prompt",
  "activity",
  "before_exec",
  "after_exec",
  "stop",
  "session_start",
  "session_end",
  "approval_request",
  "user_action_required",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface TrafficEvent {
  v: number;
  tool: string;
  sessionId: string;
  event: EventType;
  ts: number;
  /** 白名单裁剪后的附加字段：command / stop status / is_background_agent 等 */
  meta: Record<string, unknown>;
}

export function serializeEvent(ev: TrafficEvent): string {
  return JSON.stringify(ev);
}

/** 解析一行 JSONL 事件；非法输入返回 null（回放时跳过坏行）。v <= 当前版本均接受（向前兼容）。 */
export function parseEventLine(line: string): TrafficEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.v !== "number" || o.v > EVENT_SCHEMA_VERSION) return null;
  if (typeof o.tool !== "string" || typeof o.sessionId !== "string" || typeof o.ts !== "number") return null;
  if (!EVENT_TYPES.includes(o.event as EventType)) return null;
  return {
    v: o.v,
    tool: o.tool,
    sessionId: o.sessionId,
    event: o.event as EventType,
    ts: o.ts,
    meta: typeof o.meta === "object" && o.meta !== null ? (o.meta as Record<string, unknown>) : {},
  };
}
