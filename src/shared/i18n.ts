// 中英双语文案表（design.md D6），运行时按 config.language 即时切换
export type Lang = "zh" | "en";

export const MESSAGES = {
  zh: {
    waiting_question: "等待提问确认",
    waiting_approval: "等待命令审批",
    waiting_approval_codex: "等待审批（或已批准执行中）",
    waiting_user_action: "等待用户操作",
    waiting_trailing: "结尾在提问",
    waiting_stuck: "疑似卡死",
    waiting_inactive: "长时间无活动",
    state_running: "运行中",
    state_failed: "已中断",
    state_idle: "已完成",
    tool_exited: "{tool} 已退出",
    notif_waiting_title: "会话等待处理",
    notif_failed_title: "会话已中断",
    notif_missed_title: "错过提问",
    notif_missed_body: "{name} 的提问已被自动处理",
    notif_dismissed_body: "{name} 的提问表单被意外关闭，作答未提交",
    missed_unanswered: "提问未作答被自动处理",
    missed_dismissed: "提问表单被意外关闭，作答未提交",
    settings: "设置",
    pause_alerts: "暂停提醒",
    quit: "退出",
  },
  en: {
    waiting_question: "Waiting for answer",
    waiting_approval: "Waiting for approval",
    waiting_approval_codex: "Waiting for approval (may be running)",
    waiting_user_action: "Waiting for user action",
    waiting_trailing: "Ended with a question",
    waiting_stuck: "Possibly stuck",
    waiting_inactive: "Inactive for a while",
    state_running: "Running",
    state_failed: "Interrupted",
    state_idle: "Done",
    tool_exited: "{tool} exited",
    notif_waiting_title: "Session needs attention",
    notif_failed_title: "Session interrupted",
    notif_missed_title: "Missed question",
    notif_missed_body: "A question in {name} was auto-handled",
    notif_dismissed_body: "A question form in {name} was dismissed; your answer was not submitted",
    missed_unanswered: "Question auto-handled without answer",
    missed_dismissed: "Question form dismissed, answer not submitted",
    settings: "Settings",
    pause_alerts: "Pause alerts",
    quit: "Quit",
  },
} as const;

export type MessageKey = keyof typeof MESSAGES.zh;

export function t(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = MESSAGES[lang][key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}
