// 明细面板视图模型（纯函数）：SessionView[] → 渲染行（spec traffic-light-ui「展开明细列表」）
import type { SessionView } from "../main/state/tracker";
import { t, type Lang } from "./i18n";

export interface DetailRow {
  tool: string;
  sessionId: string;
  name: string;
  state: SessionView["state"];
  statusLabel: string;
  duration: string;
  highlight: boolean;
  canIgnore: boolean;
  canAcknowledge: boolean;
  missedQuestion: boolean;
  /** 错过提问的本地化原因文案（红灯明细行与圆环提示用）；无标记为 null */
  missedLabel: string | null;
}

export interface DetailModel {
  rows: DetailRow[];
}

const STATE_ORDER: Record<SessionView["state"], number> = { waiting: 0, failed: 1, running: 2, idle: 3, removed: 4 };

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

const TOOL_DISPLAY: Record<string, string> = { cursor: "Cursor", codex: "Codex", qoder: "Qoder", antigravity: "Antigravity", codebuddy: "CodeBuddy", workbuddy: "WorkBuddy" };

export function toolDisplayName(tool: string): string {
  return TOOL_DISPLAY[tool] ?? tool;
}

/**
 * 会话名清洗为单行纯文本：codex 的 threads.title 常是原始首条 prompt，
 * 可能带 markdown 链接/格式符/换行，窄行截断后形似乱码（如 "帮我对 [ai-traffic-l…"）。
 */
export function sanitizeSessionName(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown 链接只留文字
    .replace(/[`*_~#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function statusLabel(v: SessionView, lang: Lang): string {
  if (v.note === "tool_exited") return t(lang, "tool_exited", { tool: toolDisplayName(v.tool) });
  switch (v.state) {
    case "running":
      return t(lang, "state_running");
    case "failed":
      return t(lang, "state_failed");
    case "idle":
      return t(lang, "state_idle");
    case "waiting":
      switch (v.waitingKind) {
        case "approval":
          // codex 批准瞬间无任何 hook（spike 1.3），黄灯可能滞留到 PostToolUse——标注消解"已批准还亮黄"的困惑
          return t(lang, v.tool === "codex" ? "waiting_approval_codex" : "waiting_approval");
        case "user_action":
          return t(lang, v.waitingCause === "system_dialog" ? "waiting_system_dialog" : "waiting_user_action");
        case "trailing_question":
          return t(lang, "waiting_trailing");
        case "stuck":
          return t(lang, "waiting_stuck");
        case "inactive":
          return t(lang, "waiting_inactive");
        default:
          return t(lang, "waiting_question");
      }
    default:
      return "";
  }
}

function toRow(v: SessionView, lang: Lang, now: number, name?: string): DetailRow {
  const soft = v.waitingKind === "trailing_question" || v.waitingKind === "stuck" || v.waitingKind === "inactive";
  return {
    tool: v.tool,
    sessionId: v.sessionId,
    name: name ?? v.sessionId.slice(0, 8),
    state: v.state,
    statusLabel: statusLabel(v, lang),
    duration: formatDuration(Math.max(0, now - v.stateSince)),
    highlight: v.state === "waiting",
    canIgnore: v.state === "waiting" && soft,
    canAcknowledge: v.state === "failed",
    missedQuestion: v.missedQuestion,
    missedLabel: v.missedQuestion ? t(lang, v.missedReason === "dismissed" ? "missed_dismissed" : "missed_unanswered") : null,
  };
}

export function buildDetailModel(sessions: SessionView[], lang: Lang, now: number, names?: Map<string, string>): DetailModel {
  const sorted = [...sessions].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.stateSince - a.stateSince);
  return { rows: sorted.map((v) => toRow(v, lang, now, names?.get(`${v.tool}:${v.sessionId}`))) };
}
