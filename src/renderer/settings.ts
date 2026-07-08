// 设置页逻辑（无框架、无 import）
const I18N: Record<string, Record<string, string>> = {
  zh: {
    title: "AI 会话红绿灯 · 设置",
    sec_thresholds: "阈值",
    approval_threshold: "审批黄灯阈值",
    stuck_threshold: "疑似卡死阈值",
    sec_lists: "白名单与词表（逗号分隔）",
    shell_whitelist: "长命令白名单（Shell，子串匹配）",
    mcp_whitelist: "MCP 工具白名单（tool_name）",
    question_words: "结尾提问疑问词表",
    sec_behavior: "行为",
    include_bg: "跟踪背景 agent 会话",
    fast_green: "快速变绿（读文件活动信号，agent 每次读文件约 +70ms）",
    breathing: "黄灯呼吸动画",
    sys_notif: "系统通知",
    sound_alert: "声音提醒",
    language: "界面语言",
    sec_sounds: "提示音",
    yellow_sound: "黄灯提示音",
    red_sound: "红灯提示音",
    preview: "试听",
    upload: "自定义…",
    reset: "恢复默认",
    sec_health: "采集通道",
    install_hooks: "安装 hooks",
    uninstall_hooks: "卸载 hooks",
    h_hooks_ok: "hooks 已安装",
    h_hooks_bad: "hooks 未安装/损坏",
    h_db_ok: "DB 通道正常",
    h_db_bad: "DB 通道降级（黄灯启发式）",
    h_alive: "Cursor 运行中",
    h_dead: "Cursor 未运行",
    h_last_event: "最后收到事件",
    h_never: "从未",
    sec_codex: "Codex 采集",
    codex_open_terminal: "打开终端去信任",
    cx_not_installed: "未安装",
    cx_disabled: "hooks 引擎已禁用（config.toml [features].hooks=false），启用后本工具才能采集",
    cx_inactive: "已安装未生效：疑似未完成信任或 Codex 未重启",
    cx_ok: "采集正常",
    cx_alive: "Codex 运行中",
    cx_dead: "Codex 未运行",
    cx_guide: "信任步骤：\n1. 点击「打开终端去信任」启动 Codex\n2. 在 Codex 里输入 /hooks，审查并信任本工具的 hooks\n3. 重启 Codex（或新开会话）后生效",
    cx_installed_hint: "已写入 hooks.json。重启 Codex（或新开会话）后生效，并需完成信任：",
    sec_qoder: "Qoder 采集",
    qd_not_detected: "未检测到（未安装 Qoder 时无需处理）",
    qd_ok: "任务快照读取正常",
    qd_degraded: "快照读取降级（库不可读或结构变化），自动重试中",
    qd_alive: "Qoder 运行中",
    qd_dead: "Qoder 未运行",
    sec_antigravity: "Antigravity 采集",
    ag_not_detected: "未检测到（未安装 Antigravity 时无需处理）",
    ag_ok: "会话库读取正常",
    ag_degraded: "会话库读取降级（库不可读），自动重试中",
    ag_schema_mismatch: "结构不匹配（Antigravity 版本变化），已保守停用精确判定",
    ag_permission_denied: "无权限读取 Antigravity 本地数据",
    ag_alive: "Antigravity 运行中",
    ag_dead: "Antigravity 未运行",
    ag_backend_down: "后端 language_server 未运行（应用存活）",
    sec_codebuddy: "CodeBuddy 采集",
    cb_not_detected: "未检测到（未安装 CodeBuddy 时无需处理）",
    cb_ok: "会话读取正常",
    cb_degraded: "会话读取降级，自动重试中",
    cb_alive: "CodeBuddy 运行中",
    cb_dead: "CodeBuddy 未运行",
    sec_workbuddy: "WorkBuddy 采集",
    wb_not_detected: "未检测到（未安装 WorkBuddy 时无需处理）",
    wb_ok: "会话读取正常",
    wb_degraded: "会话读取降级，自动重试中",
    wb_alive: "WorkBuddy 运行中",
    wb_dead: "WorkBuddy 未运行",
  },
  en: {
    title: "AI Traffic Light · Settings",
    sec_thresholds: "Thresholds",
    approval_threshold: "Approval yellow threshold",
    stuck_threshold: "Stuck threshold",
    sec_lists: "Whitelists & words (comma separated)",
    shell_whitelist: "Long command whitelist (shell, substring)",
    mcp_whitelist: "MCP tool whitelist (tool_name)",
    question_words: "Trailing question words",
    sec_behavior: "Behavior",
    include_bg: "Track background agent sessions",
    fast_green: "Fast green (file-read activity signal, ~+70ms per agent file read)",
    breathing: "Yellow breathing animation",
    sys_notif: "System notifications",
    sound_alert: "Sound alerts",
    language: "Language",
    sec_sounds: "Sounds",
    yellow_sound: "Yellow sound",
    red_sound: "Red sound",
    preview: "Preview",
    upload: "Custom…",
    reset: "Reset",
    sec_health: "Collector health",
    install_hooks: "Install hooks",
    uninstall_hooks: "Uninstall hooks",
    h_hooks_ok: "hooks installed",
    h_hooks_bad: "hooks missing/broken",
    h_db_ok: "DB channel OK",
    h_db_bad: "DB degraded (heuristic yellow)",
    h_alive: "Cursor running",
    h_dead: "Cursor not running",
    h_last_event: "Last event",
    h_never: "never",
    sec_codex: "Codex collector",
    codex_open_terminal: "Open Terminal to trust",
    cx_not_installed: "Not installed",
    cx_disabled: "hooks engine disabled (config.toml [features].hooks=false); enable it so this tool can collect",
    cx_inactive: "Installed but inactive: trust likely not completed, or Codex not restarted",
    cx_ok: "Collecting OK",
    cx_alive: "Codex running",
    cx_dead: "Codex not running",
    cx_guide: "Trust steps:\n1. Click \u201cOpen Terminal to trust\u201d to launch Codex\n2. Type /hooks in Codex, review and trust this tool's hooks\n3. Restart Codex (or start a new session) to take effect",
    cx_installed_hint: "hooks.json written. Restart Codex (or start a new session), then complete trust:",
    sec_qoder: "Qoder collector",
    qd_not_detected: "Not detected (nothing to do if Qoder is not installed)",
    qd_ok: "Task snapshot readable",
    qd_degraded: "Snapshot degraded (DB unreadable or schema changed), retrying",
    qd_alive: "Qoder running",
    qd_dead: "Qoder not running",
    sec_antigravity: "Antigravity collector",
    ag_not_detected: "Not detected (nothing to do if Antigravity is not installed)",
    ag_ok: "Conversation store readable",
    ag_degraded: "Store degraded (DB unreadable), retrying",
    ag_schema_mismatch: "Schema mismatch (Antigravity version changed), exact tracking paused",
    ag_permission_denied: "No permission to read Antigravity local data",
    ag_alive: "Antigravity running",
    ag_dead: "Antigravity not running",
    ag_backend_down: "Backend language_server not running (app alive)",
    sec_codebuddy: "CodeBuddy collector",
    cb_not_detected: "Not detected (nothing to do if CodeBuddy is not installed)",
    cb_ok: "Session store readable",
    cb_degraded: "Session store degraded, retrying",
    cb_alive: "CodeBuddy running",
    cb_dead: "CodeBuddy not running",
    sec_workbuddy: "WorkBuddy collector",
    wb_not_detected: "Not detected (nothing to do if WorkBuddy is not installed)",
    wb_ok: "Session store readable",
    wb_degraded: "Session store degraded, retrying",
    wb_alive: "WorkBuddy running",
    wb_dead: "WorkBuddy not running",
  },
};

let lang = "zh";

function applyI18n(): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = I18N[lang][el.dataset.i18n!] ?? el.dataset.i18n!;
  }
}

const $id = (id: string) => document.getElementById(id) as HTMLInputElement;

function fillForm(cfg: Record<string, unknown>): void {
  lang = String(cfg.language ?? "zh");
  applyI18n();
  $id("approvalThresholdSec").value = String(Number(cfg.approvalThresholdMs) / 1000);
  $id("stuckThresholdMin").value = String(Number(cfg.stuckThresholdMs) / 60000);
  ($id("shellWhitelist") as unknown as HTMLTextAreaElement).value = (cfg.shellWhitelist as string[]).join(", ");
  ($id("mcpWhitelist") as unknown as HTMLTextAreaElement).value = (cfg.mcpWhitelist as string[]).join(", ");
  ($id("questionWords") as unknown as HTMLTextAreaElement).value = (cfg.questionWords as string[]).join(", ");
  $id("includeBackgroundAgents").checked = !!cfg.includeBackgroundAgents;
  $id("fastGreenReadSignal").checked = !!cfg.fastGreenReadSignal;
  $id("breathingAnimation").checked = !!cfg.breathingAnimation;
  $id("systemNotification").checked = !!cfg.systemNotification;
  $id("soundAlert").checked = !!cfg.soundAlert;
  ($id("language") as unknown as HTMLSelectElement).value = lang;
}

function splitList(v: string): string[] {
  return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

async function save(): Promise<void> {
  const cfg = await tl.setConfig({
    approvalThresholdMs: Number($id("approvalThresholdSec").value) * 1000,
    stuckThresholdMs: Number($id("stuckThresholdMin").value) * 60000,
    shellWhitelist: splitList(($id("shellWhitelist") as unknown as HTMLTextAreaElement).value),
    mcpWhitelist: splitList(($id("mcpWhitelist") as unknown as HTMLTextAreaElement).value),
    questionWords: splitList(($id("questionWords") as unknown as HTMLTextAreaElement).value),
    includeBackgroundAgents: $id("includeBackgroundAgents").checked,
    fastGreenReadSignal: $id("fastGreenReadSignal").checked,
    breathingAnimation: $id("breathingAnimation").checked,
    systemNotification: $id("systemNotification").checked,
    soundAlert: $id("soundAlert").checked,
    language: ($id("language") as unknown as HTMLSelectElement).value,
  });
  fillForm(cfg);
}

async function refreshHealth(): Promise<void> {
  const h = await tl.health();
  const L = I18N[lang];
  const lastEv = h.lastEventAt ? new Date(h.lastEventAt).toLocaleTimeString() : L.h_never;
  // 采集断流：Cursor 存活但超过 10 分钟无事件
  const stale = h.cursorAlive && h.lastEventAt > 0 && Date.now() - h.lastEventAt > 600_000;
  document.getElementById("health")!.innerHTML = [
    `<div class="${h.hooks.installed ? "" : "bad"}">${h.hooks.installed ? L.h_hooks_ok : L.h_hooks_bad}${h.hooks.detail ? `: ${h.hooks.detail}` : ""}</div>`,
    `<div class="${h.dbAvailable && !h.dbDegraded ? "" : "bad"}">${h.dbAvailable && !h.dbDegraded ? L.h_db_ok : L.h_db_bad}</div>`,
    `<div>${h.cursorAlive ? L.h_alive : L.h_dead}</div>`,
    `<div class="${stale ? "bad" : ""}">${L.h_last_event}: ${lastEv}</div>`,
  ].join("");
  renderCodex(h.codex);
  renderCodebuddy(h.codebuddy);
  renderQoder(h.qoder);
  renderAntigravity(h.antigravity);
  renderWorkbuddy(h.workbuddy);
}

/** Qoder 三态健康（add-qoder-support D9）：not_detected 中性无告警，degraded 才标红 */
function renderQoder(q: QoderHealthView): void {
  const L = I18N[lang];
  const stateText = { not_detected: L.qd_not_detected, ok: L.qd_ok, degraded: L.qd_degraded }[q.state];
  const rows = [`<div class="${q.state === "degraded" ? "bad" : q.state === "ok" ? "ok" : ""}">${stateText}</div>`];
  if (q.state !== "not_detected") rows.push(`<div>${q.alive ? L.qd_alive : L.qd_dead}</div>`);
  document.getElementById("qoder-health")!.innerHTML = rows.join("");
}

/** Antigravity 多态健康（add-antigravity-support D14/D24）：not_detected 中性；其余异常态标红；后端分层展示 */
function renderAntigravity(a: AntigravityHealthView): void {
  const L = I18N[lang];
  const stateText = {
    not_detected: L.ag_not_detected,
    ok: L.ag_ok,
    degraded: L.ag_degraded,
    schema_mismatch: L.ag_schema_mismatch,
    permission_denied: L.ag_permission_denied,
  }[a.state];
  const rows = [`<div class="${a.state === "ok" ? "ok" : a.state === "not_detected" ? "" : "bad"}">${stateText}</div>`];
  if (a.state !== "not_detected") {
    rows.push(`<div>${a.alive ? L.ag_alive : L.ag_dead}</div>`);
    if (a.alive && !a.backendAlive) rows.push(`<div class="bad">${L.ag_backend_down}</div>`);
  }
  document.getElementById("antigravity-health")!.innerHTML = rows.join("");
}

/** 安装动作刚发生：下一次渲染补"重启 + 信任"提示（首次生效窗口内三态可能仍是 inactive） */
let codexJustInstalled = false;

function renderCodex(c: CodexHealth): void {
  const L = I18N[lang];
  const stateText = { not_installed: L.cx_not_installed, disabled: L.cx_disabled, installed_inactive: L.cx_inactive, ok: L.cx_ok }[c.state];
  const stateCls = c.state === "ok" ? "ok" : c.state === "not_installed" ? "" : "bad";
  const lastEv = c.lastEventAt ? new Date(c.lastEventAt).toLocaleTimeString() : L.h_never;
  document.getElementById("codex-health")!.innerHTML = [
    `<div class="${stateCls}">${stateText}</div>`,
    `<div>${c.alive ? L.cx_alive : L.cx_dead}</div>`,
    `<div>${L.h_last_event}: ${lastEv}</div>`,
  ].join("");
  // 指引展示时机：刚安装完 / 未生效（含未信任）时给分步指引；采集正常后收起
  const guide = document.getElementById("codex-guide")!;
  guide.textContent = c.state === "installed_inactive" || (codexJustInstalled && c.state !== "ok")
    ? (codexJustInstalled ? `${L.cx_installed_hint}\n` : "") + L.cx_guide
    : "";
}

function renderCodebuddy(c: CodebuddyHealthView): void {
  const L = I18N[lang];
  const stateText = { not_detected: L.cb_not_detected, ok: L.cb_ok, degraded: L.cb_degraded }[c.state];
  const rows = [`<div class="${c.state === "degraded" ? "bad" : c.state === "ok" ? "ok" : ""}">${stateText}</div>`];
  if (c.state !== "not_detected") rows.push(`<div>${c.alive ? L.cb_alive : L.cb_dead}</div>`);
  document.getElementById("codebuddy-health")!.innerHTML = rows.join("");
}

function renderWorkbuddy(w: WorkbuddyHealthView): void {
  const L = I18N[lang];
  const stateText = { not_detected: L.wb_not_detected, ok: L.wb_ok, degraded: L.wb_degraded }[w.state];
  const rows = [`<div class="${w.state === "degraded" ? "bad" : w.state === "ok" ? "ok" : ""}">${stateText}</div>`];
  if (w.state !== "not_detected") rows.push(`<div>${w.alive ? L.wb_alive : L.wb_dead}</div>`);
  document.getElementById("workbuddy-health")!.innerHTML = rows.join("");
}

async function init(): Promise<void> {
  fillForm(await tl.getConfig());
  await refreshHealth();
  setInterval(() => void refreshHealth(), 5000);

  for (const el of document.querySelectorAll("input, textarea, select")) {
    el.addEventListener("change", () => void save());
  }
  for (const color of ["yellow", "red"] as const) {
    document.getElementById(`preview-${color}`)!.onclick = () => void tl.sound("preview", color);
    document.getElementById(`custom-${color}`)!.onclick = () => void tl.sound("setCustom", color);
    document.getElementById(`reset-${color}`)!.onclick = () => void tl.sound("reset", color);
  }
  document.getElementById("hooks-install")!.onclick = async () => {
    await tl.hooks("install");
    await refreshHealth();
  };
  document.getElementById("hooks-uninstall")!.onclick = async () => {
    await tl.hooks("uninstall");
    await refreshHealth();
  };
  document.getElementById("codex-install")!.onclick = async () => {
    codexJustInstalled = true;
    renderCodex(await tl.codexHooks("install"));
  };
  document.getElementById("codex-uninstall")!.onclick = async () => {
    codexJustInstalled = false;
    renderCodex(await tl.codexHooks("uninstall"));
  };
  document.getElementById("codex-trust-terminal")!.onclick = () => void tl.codexTrustTerminal();
}

void init();
