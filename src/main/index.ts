import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, Tray } from "electron";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, mergeConfig, type AppConfig } from "../shared/config";
import { t, type Lang } from "../shared/i18n";
import { buildDetailModel, sanitizeSessionName } from "../shared/view-model";
import { HOOK_EVENTS, HooksInstaller } from "./adapters/cursor/hooks-installer";
import { CursorDbReader } from "./adapters/cursor/db-reader";
import { snapshotFromBubbles } from "./adapters/cursor/bubble-judge";
import { CodexHooksInstaller } from "./adapters/codex/hooks-installer";
import { codexCollectorState } from "./adapters/codex/collector-state";
import { codexProbeSnapshot, latestRolloutActivityAt, resolveCodexStop, scanRecentRollouts } from "./adapters/codex/rollout-reader";
import { BackgroundGraceFilter, CodexThreadsReader } from "./adapters/codex/threads-reader";
import { defaultQoderCacheDir, QoderSnapshotReader, qoderSafeName, qoderTranscriptPath } from "./adapters/qoder/snapshot-reader";
import { QoderPoller } from "./adapters/qoder/poller";
import { defaultAntigravityHome } from "./adapters/antigravity/store-locator";
import { antigravitySafeName, AntigravitySnapshotSource } from "./adapters/antigravity/snapshot-source";
import { AntigravityPoller } from "./adapters/antigravity/poller";
import { AntigravityTitleReader } from "./adapters/antigravity/summary-titles";
import { readAntigravityTranscriptTail } from "./adapters/antigravity/transcript-tail";
import { antigravityBackendAlive, anyProcessMatches, codexProcessAlive, ANTIGRAVITY_PROCESS_PATTERNS, CURSOR_PROCESS_PATTERNS, QODER_PROCESS_PATTERNS, readProcessTable } from "./process-liveness";
import { EventFileWatcher, ensureSecureDir, rotateIfNeeded } from "./event-file";
import { loadMarks, persistMarks } from "./state/marks-store";
import { SessionTracker, type NotifyKind, type SessionView } from "./state/tracker";

const APP_HOME = path.join(os.homedir(), ".ai-traffic-light");
const CONFIG_FILE = path.join(APP_HOME, "config.json");
const MARKS_FILE = path.join(APP_HOME, "marks.json");
const WINDOW_FILE = path.join(APP_HOME, "window.json");
const SOUND_EXTS = [".wav", ".mp3", ".aiff"];

// ---- 配置与持久化 ----
let config: AppConfig = loadConfig();

function loadConfig(): AppConfig {
  try {
    return mergeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")));
  } catch {
    return mergeConfig(undefined);
  }
}

function saveConfig(): void {
  ensureSecureDir(APP_HOME);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

const marks = loadMarks(MARKS_FILE);
const saveMarks = () => persistMarks(MARKS_FILE, marks);

// ---- 依赖组装 ----
const reader = new CursorDbReader();
const installer = new HooksInstaller({ appHome: APP_HOME, cursorDir: path.join(os.homedir(), ".cursor") });

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
const codexInstaller = new CodexHooksInstaller({ appHome: APP_HOME, codexDir: CODEX_DIR });
const codexThreads = new CodexThreadsReader(CODEX_DIR);
/** codex 会话 → rollout 路径缓存（事件 meta 的 transcriptPath，probe/resolver 定位用） */
const codexTranscripts = new Map<string, string>();
const codexBgFilter = new BackgroundGraceFilter({
  graceMs: 60_000,
  clock: () => Date.now(),
  heartbeatIds: () => codexThreads.heartbeatIds(),
  threadKnown: (id) => codexThreads.threadKnown(id),
});
/** 已进入跟踪的 codex 会话（宽限期 sweep 的复查范围） */
const codexSeen = new Set<string>();

// Qoder：无 hooks，本地任务快照轮询 diff（add-qoder-support D1/D2）；事件内存直投，不写 events.jsonl（隐私边界 D6）
// TL_QODER_DB：调试用库路径覆盖（沙箱快照冒烟黄灯/红灯流转，不碰真实 Qoder 数据）
const qoderReader = new QoderSnapshotReader(process.env.TL_QODER_DB ?? undefined);
const QODER_CACHE_DIR = defaultQoderCacheDir();

// Antigravity：无 hooks，本地会话库轮询 diff（add-antigravity-support D1/D6）；事件内存直投，不写 events.jsonl
// home 支持 TL_ANTIGRAVITY_HOME 覆盖（沙箱冒烟/非默认安装，D33）
const AGY_HOME = defaultAntigravityHome();
const agySource = new AntigravitySnapshotSource(AGY_HOME);
const agyTitles = new AntigravityTitleReader(AGY_HOME);

/** 当前配置下应启用的 hook 事件集（快速变绿开关控制 beforeReadFile） */
function enabledHookEvents(): readonly string[] {
  return config.fastGreenReadSignal ? HOOK_EVENTS : HOOK_EVENTS.filter((e) => e !== "beforeReadFile");
}

// 进程存活缓存：一次 ps 输出喂所有工具的特征匹配（不用 pgrep：-x/-f 依赖读进程 argv，受限环境漏报）
const TOOL_MATCHERS: Record<string, (psComm: string) => boolean> = {
  cursor: (t) => anyProcessMatches(t, CURSOR_PROCESS_PATTERNS),
  // codex 需覆盖 PATH 安装（Homebrew/npm），不能只认 App 包路径
  codex: codexProcessAlive,
  qoder: (t) => anyProcessMatches(t, QODER_PROCESS_PATTERNS),
  antigravity: (t) => anyProcessMatches(t, ANTIGRAVITY_PROCESS_PATTERNS),
  // 伪工具通道：Antigravity 后端单独判定（D14 健康分层），复用同一份 ps 缓存
  antigravity_backend: antigravityBackendAlive,
};
let aliveCache: { at: number; byTool: Record<string, boolean> } = { at: 0, byTool: {} };
function isToolAlive(tool: string): boolean {
  const now = Date.now();
  if (now - aliveCache.at > config.livenessIntervalMs) {
    const table = readProcessTable();
    const byTool: Record<string, boolean> = {};
    for (const [t, matches] of Object.entries(TOOL_MATCHERS)) byTool[t] = matches(table);
    aliveCache = { at: now, byTool };
  }
  return aliveCache.byTool[tool] ?? false;
}

let alertsPaused = false;

function soundFile(color: "yellow" | "red"): string {
  for (const ext of SOUND_EXTS) {
    const custom = path.join(APP_HOME, "sounds", `${color}.custom${ext}`);
    if (fs.existsSync(custom)) return custom;
  }
  return path.join(app.getAppPath(), "assets/sounds", `${color}.wav`);
}

function onNotify(kind: NotifyKind, session: SessionView): void {
  if (alertsPaused) return;
  const lang = config.language as Lang;
  // qoder/antigravity 通知强制隐私安全名（D6/D21）：任务标题可能含 prompt 文本，只允许面板本地展示
  const name =
    (session.tool === "qoder"
      ? qoderNotifyName(session.sessionId)
      : session.tool === "antigravity"
        ? antigravitySafeName(session.sessionId)
        : metaName(session.tool, session.sessionId)) ?? session.sessionId.slice(0, 8);
  if (config.systemNotification && Notification.isSupported()) {
    const title = kind === "failed" ? t(lang, "notif_failed_title") : kind === "missed_question" ? t(lang, "notif_missed_title") : t(lang, "notif_waiting_title");
    const body = kind === "missed_question" ? t(lang, "notif_missed_body", { name }) : name;
    new Notification({ title, body }).show();
  }
  if (config.soundAlert) {
    widget?.webContents.send("sound:play", soundFile(kind === "failed" ? "red" : "yellow"));
  }
}

/** Codex 采集健康块：三态判定 + 信任态 + 断流时间（settings 页 Codex 区块数据源） */
async function codexHealth() {
  const [st, disabled, trust] = await Promise.all([codexInstaller.status(), codexInstaller.hooksFeatureDisabled(), codexInstaller.trustStatus()]);
  const alive = isToolAlive("codex");
  const state = codexCollectorState({
    installed: st.installed,
    featureDisabled: disabled,
    trusted: trust.trusted,
    codexAlive: alive,
    rolloutActivityAt: st.installed ? latestRolloutActivityAt(CODEX_SESSIONS_DIR) : 0,
    lastEventAt: lastCodexEventAt,
  });
  return { state, installed: st.installed, detail: st.detail, disabled, trusted: trust.trusted, alive, lastEventAt: lastCodexEventAt };
}

/** codex CLI 启动命令：PATH 里有用短名，否则回落桌面 App 内置二进制（design D6） */
function codexCliCommand(): string {
  try {
    execFileSync("/bin/zsh", ["-lc", "command -v codex"], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return "codex";
  } catch {
    const bundled = "/Applications/Codex.app/Contents/Resources/codex";
    return fs.existsSync(bundled) ? bundled : "codex";
  }
}

/** codex rollout 定位：事件 meta 缓存优先，threads 表 rollout_path 次之（目录扫描兜底在 reader 内） */
function codexRolloutPath(sessionId: string): string | undefined {
  return codexTranscripts.get(sessionId) ?? codexThreads.metadata(sessionId)?.rolloutPath ?? undefined;
}

const tracker = new SessionTracker({
  config,
  clock: () => Date.now(),
  registry: {
    cursor: { yellow: "exact", red: "exact", metadata: true },
    // codex：黄灯推送型（approval_request），aborted 明确是用户中断/拒绝 → 不亮红（design D2/D4）
    codex: { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false },
    // qoder：黄灯推送型（快照 diff 出 user_action_required），Stopped 是用户主动停止 → 不亮红（add-qoder-support D3/D4）
    qoder: { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false },
    // antigravity：黄灯推送型（结构 waiting diff），取消/中止不红（add-antigravity-support D7/D10）
    antigravity: { yellow: "exact", red: "exact", metadata: true, yellowPush: true, redIncludesAborted: false },
  },
  probe: (tool, sessionId) =>
    tool === "codex"
      ? codexProbeSnapshot(CODEX_SESSIONS_DIR, sessionId, codexRolloutPath(sessionId))
      : tool === "qoder"
        ? qoderPoller.probeSnapshot(sessionId)
        : tool === "antigravity"
          ? agyPoller.probeSnapshot(sessionId)
          : snapshotFromBubbles(reader.isAvailable() ? reader.latestBubbles(sessionId, 6) : null),
  resolveStop: (tool, sessionId, transcriptPath) =>
    tool === "codex" ? resolveCodexStop(CODEX_SESSIONS_DIR, sessionId, transcriptPath ?? codexRolloutPath(sessionId)) : null,
  isToolAlive,
  readTranscript: (p) => {
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  },
  notify: onNotify,
  marks,
});

// qoder 轮询 diff 管道：事件直投 tracker（推送来源），probe 走同一快照（保险丝）
const qoderPoller = new QoderPoller({
  read: () => qoderReader.read(),
  emit: (ev) => {
    tracker.handleEvent(ev);
    pushState();
  },
  clock: () => Date.now(),
  transcriptPath: (taskId) => qoderTranscriptPath(QODER_CACHE_DIR, taskId),
});

// antigravity 轮询 diff 管道：事件直投 tracker，probe 与 poll 同代快照（D28）；尾问文本走专用有界尾部解析（D38）
const agyPoller = new AntigravityPoller({
  read: () => agySource.read(),
  emit: (ev) => {
    tracker.handleEvent(ev);
    pushState();
  },
  clock: () => Date.now(),
  transcriptTail: (sessionId) => (AGY_HOME ? readAntigravityTranscriptTail(AGY_HOME, sessionId) : null),
});

// 会话名缓存（cursor: composerData；codex: threads.title；qoder: 隐私安全合成名），1 分钟过期：改名后最多 1 分钟内更新到面板
const nameCache = new Map<string, { name: string | null; at: number }>();
/** qoder 通知专用安全名（D6）：workspace 目录名 + 短 id，不含 prompt 类内容 */
function qoderNotifyName(sessionId: string): string | null {
  const info = qoderPoller.taskInfo(sessionId);
  return info ? qoderSafeName(info.taskId, info.workspacePath) : null;
}

function metaName(tool: string, sessionId: string): string | null {
  // antigravity 面板显示界面同源标题（tasks 7.0.2 用户决策，Qoder 先例）；通知仍走安全名（onNotify 强制）
  if (tool === "antigravity") {
    const title = agyTitles.title(sessionId);
    return title ? sanitizeSessionName(title) || antigravitySafeName(sessionId) : antigravitySafeName(sessionId);
  }
  if (tool === "qoder") {
    // 面板显示任务标题（Qoder 界面同源，D6 允许本地展示）；无标题回退安全名
    const info = qoderPoller.taskInfo(sessionId);
    if (!info) return null;
    return info.displayName ? sanitizeSessionName(info.displayName) || qoderSafeName(info.taskId, info.workspacePath) : qoderSafeName(info.taskId, info.workspacePath);
  }
  if (tool !== "cursor" && tool !== "codex") return null;
  const k = `${tool}:${sessionId}`;
  const hit = nameCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.name;
  // 常驻进程防泄漏：条目随历史会话累积，超限时甩掉过期项
  if (nameCache.size > 300) {
    const cutoff = Date.now() - 60_000;
    for (const [key, v] of nameCache) if (v.at < cutoff) nameCache.delete(key);
  }
  const raw = (tool === "codex" ? codexThreads.metadata(sessionId)?.name : reader.sessionMetadata(sessionId)?.name) ?? null;
  const name = raw ? sanitizeSessionName(raw) || null : null;
  nameCache.set(k, { name, at: Date.now() });
  return name;
}

// ---- 窗口 ----
const COLLAPSED_W = 92;
const MAX_PANEL_W = 360;
let widget: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 当前锚定方向：left=灯体在窗口左缘，right=灯体在窗口右缘（展开面板向左长） */
let anchorSide: "left" | "right" = "left";
/** 灯体屏幕 x 坐标，唯一锚点。只在用户拖动窗口时刷新，resize 期间恒定，杜绝交错 IPC 读中间态 bounds 导致的漂移 */
let lampX: number | null = null;
let programmaticMove = false;

function currentLampX(): number {
  if (lampX === null) {
    const b = widget!.getBounds();
    lampX = anchorSide === "left" ? b.x : b.x + b.width - COLLAPSED_W;
  }
  return lampX;
}

function loadWindowPos(): { x?: number; y?: number } {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function createWidget(): void {
  const pos = loadWindowPos();
  widget = new BrowserWindow({
    width: 92,
    height: 250,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  widget.setAlwaysOnTop(true, "floating");
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void widget.loadFile(path.join(__dirname, "../renderer/static/index.html"));
  // 渲染器就绪前的推送会被去重吞掉，加载完成后强制重推首帧
  widget.webContents.on("did-finish-load", () => {
    lastPushed = "";
    pushState();
  });
  widget.on("moved", () => {
    const [x, y] = widget!.getPosition();
    // 程序内 setBounds 也会触发 moved；只有用户拖动（非 resize 期间）才刷新灯体锚点
    if (!programmaticMove) lampX = null;
    ensureSecureDir(APP_HOME);
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({ x, y }));
  });
  widget.on("closed", () => (widget = null));
}

function openSettings(): void {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 640,
    title: t(config.language as Lang, "settings"),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  void settingsWin.loadFile(path.join(__dirname, "../renderer/static/settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

function buildTray(): void {
  // 彩色托盘图（用户决策：与定稿 App 图标位图一致，非 template）：scripts/gen-tray-icon.mjs
  // 从 icon-1024.png 抠背景+下采样生成，@2x 由 createFromPath 自动加载
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets/icons/tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  if (icon.isEmpty()) tray.setTitle("🚦");
  tray.setToolTip("AI Traffic Light");
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  const lang = config.language as Lang;
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: t(lang, "pause_alerts"), type: "checkbox", checked: alertsPaused, click: (item) => (alertsPaused = item.checked) },
      { label: t(lang, "settings"), click: openSettings },
      { type: "separator" },
      { label: t(lang, "quit"), click: () => app.quit() },
    ]),
  );
}

// ---- 状态推送 ----
let lastPushed = "";
function pushState(): void {
  if (!widget) return;
  const sessions = tracker.sessions();
  const names = new Map(sessions.map((s) => [`${s.tool}:${s.sessionId}`, metaName(s.tool, s.sessionId) ?? s.sessionId.slice(0, 8)]));
  const payload = {
    aggregate: tracker.aggregate(),
    detail: buildDetailModel(sessions, config.language as Lang, Date.now(), names),
    dbDegraded: tracker.dbDegraded(),
    breathing: config.breathingAnimation,
    lang: config.language,
  };
  const s = JSON.stringify(payload);
  if (s === lastPushed) return;
  lastPushed = s;
  widget.webContents.send("state:update", payload);
}

// ---- 事件管道与冷启动 ----
let watcher: EventFileWatcher | null = null;

/** 最后收到 codex 事件的事件时间（断流健康度 + 已安装未生效判定证据） */
let lastCodexEventAt = 0;

/** codex 事件预处理：背景线程宽限期过滤 + rollout 路径缓存；返回 false = 丢弃该事件 */
function admitCodexEvent(ev: { tool: string; sessionId: string; event?: string; meta: Record<string, unknown>; ts?: number }): boolean {
  if (ev.tool !== "codex") return true;
  if (typeof ev.ts === "number" && ev.ts > lastCodexEventAt) lastCodexEventAt = ev.ts;
  if (ev.event === "session_end") {
    // 会话结束即清缓存（常驻进程防泄漏）；bgIgnored 保留（复活事件仍需过滤）
    codexTranscripts.delete(ev.sessionId);
    codexSeen.delete(ev.sessionId);
    return !codexBgIgnored.has(ev.sessionId);
  }
  const tp = ev.meta.transcriptPath;
  if (typeof tp === "string" && tp) codexTranscripts.set(ev.sessionId, tp);
  if (!codexSeen.has(ev.sessionId)) {
    codexSeen.add(ev.sessionId);
    if (codexBgFilter.onFirstEvent(ev.sessionId) === "filter") {
      codexSeen.delete(ev.sessionId);
      codexBgIgnored.add(ev.sessionId);
      return false;
    }
  }
  return !codexBgIgnored.has(ev.sessionId);
}
const codexBgIgnored = new Set<string>();

async function startPipeline(): Promise<void> {
  ensureSecureDir(APP_HOME);
  // 事件路径不落盘标记：handleEvent 不写 marks（写点只在 tick 探测与用户操作，各自已带 saveMarks）
  watcher = new EventFileWatcher(APP_HOME, (ev) => {
    if (!admitCodexEvent(ev)) return;
    tracker.handleEvent(ev);
    pushState();
  });
  await watcher.start(); // start 内部先回放历史事件（冷启动重建）
  // 回放复活的陈旧黄灯降级为灰点（30 分钟前的等待用户早已在工具里处理过）；红灯保留待知悉
  tracker.expireStaleWaiting(30 * 60_000);

  // qoder 启动基线：活跃任务恢复可见状态，历史终态静默（add-qoder-support D2）
  qoderPoller.poll();

  // antigravity 启动基线：running 恢复、新鲜 waiting 恢复、历史终态静默（add-antigravity-support D20/D31）
  agyPoller.poll();

  // composerData 兜底：发现事件文件之外的近期会话，注入为灰点（design.md D5）
  const known = new Set(tracker.sessions().map((s) => s.sessionId));
  for (const row of reader.recentSessions(20)) {
    if (known.has(row.sessionId)) continue;
    if (!row.lastUpdatedAt || Date.now() - row.lastUpdatedAt > 3600_000) continue;
    const ts = row.lastUpdatedAt;
    // ponytail: 兜底会话状态未知，注入 start+unknown 落为 idle 灰点（不能用 aborted，会误亮红灯），真实状态靠后续事件/探测校正
    tracker.handleEvent({ v: 1, tool: "cursor", sessionId: row.sessionId, event: "session_start", ts, meta: {} });
    tracker.handleEvent({ v: 1, tool: "cursor", sessionId: row.sessionId, event: "stop", ts, meta: { status: "unknown" } });
  }

  // codex 冷启动兜底：扫近 7 天 rollout 重建终态（未终态恢复 running 待 tick 校正，已完成仅近 24h）
  const knownAfter = new Set(tracker.sessions().map((s) => `${s.tool}:${s.sessionId}`));
  for (const s of scanRecentRollouts(CODEX_SESSIONS_DIR)) {
    if (knownAfter.has(`codex:${s.sessionId}`)) continue;
    if (codexThreads.metadata(s.sessionId)?.archived) continue; // archived → 不重建（等价 removed）
    codexTranscripts.set(s.sessionId, s.transcriptPath);
    if (!admitCodexEvent({ tool: "codex", sessionId: s.sessionId, meta: {} })) continue;
    tracker.handleEvent({ v: 2, tool: "codex", sessionId: s.sessionId, event: "session_start", ts: s.lastActiveAt, meta: {} });
    if (s.status !== "running") {
      // ponytail: 重建的历史终态一律落灰点（unknown），不复亮红灯/结尾提问——冷启动前的旧状态用户已在 Codex 里看过
      tracker.handleEvent({ v: 2, tool: "codex", sessionId: s.sessionId, event: "stop", ts: s.lastActiveAt, meta: { status: "unknown" } });
    } else {
      tracker.handleEvent({ v: 2, tool: "codex", sessionId: s.sessionId, event: "activity", ts: s.lastActiveAt, meta: {} });
    }
  }
  pushState();
}

// ---- IPC ----
function registerIpc(): void {
  ipcMain.handle("action", (_e, type: string, tool: string, sessionId: string) => {
    if (type === "ignore") tracker.ignoreWaiting(tool, sessionId);
    else if (type === "ack") tracker.acknowledgeFailure(tool, sessionId);
    else if (type === "clearMark") tracker.clearMissedMark(tool, sessionId);
    saveMarks();
    lastPushed = "";
    pushState();
  });
  ipcMain.handle("window:resize", (_e, w: number, h: number): "left" | "right" => {
    if (!widget) return "left";
    const b = widget.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.round(w);
    const height = Math.round(h);
    // 以灯体屏幕位置为唯一锚点判定（与当前窗口宽度无关），避免展开/收起时判定翻转导致横跳
    const anchor = currentLampX();
    const side: "left" | "right" = anchor + MAX_PANEL_W > area.x + area.width - 8 ? "right" : "left";
    anchorSide = side;
    const x = side === "left" ? anchor : Math.max(area.x + 8, anchor + COLLAPSED_W - width);
    if (process.env.TL_DEBUG_SHOT)
      console.log(`[shot] resize in=${width}x${height} before=${JSON.stringify(b)} lampX=${anchor} side=${side} -> x=${x}`);
    programmaticMove = true;
    widget.setBounds({ x, y: b.y, width, height });
    setTimeout(() => (programmaticMove = false), 100);
    return side;
  });
  ipcMain.handle("config:get", () => config);
  ipcMain.handle("config:set", async (_e, partial: Partial<AppConfig>) => {
    const before = config.fastGreenReadSignal;
    config = mergeConfig({ ...config, ...partial });
    saveConfig();
    Object.assign(tracker["deps"].config, config); // tracker 持有引用，字段级同步即时生效
    // 快速变绿开关变化时同步 hooks.json（仅在已安装时动它）
    if (before !== config.fastGreenReadSignal && (await installer.everInstalled())) {
      await installer.install(enabledHookEvents());
    }
    refreshTrayMenu();
    lastPushed = "";
    pushState();
    return config;
  });
  ipcMain.handle("hooks", async (_e, op: string) => {
    if (op === "install") await installer.install(enabledHookEvents());
    else if (op === "uninstall") await installer.uninstall();
    return installer.status(enabledHookEvents());
  });
  ipcMain.handle("codexHooks", async (_e, op: string) => {
    if (op === "install") await codexInstaller.install();
    else if (op === "uninstall") await codexInstaller.uninstall();
    return codexHealth();
  });
  // 一键打开终端预填 codex 启动命令，用户在 TUI 内跑 /hooks 完成信任（App 无法代跑，design D6）
  ipcMain.handle("codexTrust:terminal", () => {
    const cmd = codexCliCommand();
    execFile("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, "-e", 'tell application "Terminal" to activate']);
    return { command: cmd };
  });
  ipcMain.handle("health:get", async () => ({
    hooks: await installer.status(enabledHookEvents()),
    dbAvailable: reader.isAvailable(),
    // 设置页此行是 Cursor DB 健康：只看 cursor 通道，避免被其他工具的探测结果掩盖
    dbDegraded: tracker.dbDegraded("cursor"),
    lastEventAt: watcher?.lastEventAt() ?? 0,
    cursorAlive: isToolAlive("cursor"),
    codex: await codexHealth(),
    // qoder 三态健康（add-qoder-support D9）：not_detected 中性不告警
    qoder: { state: qoderReader.health(), alive: isToolAlive("qoder") },
    // antigravity 多态健康（add-antigravity-support D14/D24）：app 与后端分层
    antigravity: { state: agySource.health(), alive: isToolAlive("antigravity"), backendAlive: isToolAlive("antigravity_backend") },
  }));
  ipcMain.handle("sound", async (_e, op: string, color: "yellow" | "red", filePath?: string) => {
    const dir = path.join(APP_HOME, "sounds");
    if (op === "preview") {
      widget?.webContents.send("sound:play", soundFile(color));
      return { ok: true };
    }
    if (op === "reset") {
      for (const ext of SOUND_EXTS) fs.rmSync(path.join(dir, `${color}.custom${ext}`), { force: true });
      return { ok: true };
    }
    // setCustom：无路径时弹文件选择
    let src = filePath;
    if (!src) {
      const r = await dialog.showOpenDialog({ filters: [{ name: "Audio", extensions: ["wav", "mp3", "aiff"] }], properties: ["openFile"] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      src = r.filePaths[0];
    }
    const ext = path.extname(src).toLowerCase();
    if (!SOUND_EXTS.includes(ext)) return { ok: false, error: "unsupported format" };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const e of SOUND_EXTS) fs.rmSync(path.join(dir, `${color}.custom${e}`), { force: true });
    fs.copyFileSync(src, path.join(dir, `${color}.custom${ext}`));
    return { ok: true };
  });
}

// ---- 启动 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    widget?.show();
    widget?.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform === "darwin") app.dock?.hide();
    registerIpc();
    createWidget();
    buildTray();
    // hooks 已安装时校验脚本版本自动刷新；新版本增加了 hook 事件时自动补齐条目（App 升级场景）
    const st = await installer.status(enabledHookEvents());
    if (st.installed) await installer.ensureFresh();
    else if (await installer.everInstalled()) await installer.install(enabledHookEvents());
    // codex 同理：脚本内容刷新不破坏信任（哈希只锁 hooks.json 条目定义）
    if ((await codexInstaller.status()).installed) await codexInstaller.ensureFresh();
    await startPipeline();

    setInterval(() => {
      // 背景线程宽限期定罪：期满仍不在 threads 表 → 注入 session_end 移除会话
      for (const id of codexBgFilter.sweep()) {
        codexBgIgnored.add(id);
        tracker.handleEvent({ v: 2, tool: "codex", sessionId: id, event: "session_end", ts: Date.now(), meta: {} });
      }
      watcher?.poll(); // fsevents 丢事件（睡眠唤醒等）的轮询兜底
      qoderPoller.poll(); // qoder 无 hooks，靠快照轮询 diff 产事件
      agyPoller.poll(); // antigravity 无 hooks，靠会话库轮询 diff 产事件
      tracker.tick();
      saveMarks();
      pushState();
    }, 2000);
    setInterval(() => rotateIfNeeded(APP_HOME, 10 * 1024 * 1024, 2), 60_000);
    powerMonitor.on("resume", () => tracker.resetTimersOnWake());
  });

  app.on("window-all-closed", () => {
    // tray 常驻，不随窗口关闭退出
  });
}

// ---- 自检模式（TL_DEBUG_SETTINGS_SHOT=1）：打开设置窗截图后退出 ----
if (process.env.TL_DEBUG_SETTINGS_SHOT) {
  app.whenReady().then(() => {
    setTimeout(async () => {
      openSettings();
      await new Promise((r) => setTimeout(r, 1500));
      const img = await settingsWin!.webContents.capturePage();
      fs.writeFileSync("/tmp/tl-settings.png", img.toPNG());
      await settingsWin!.webContents.executeJavaScript(`document.getElementById("codex-health").scrollIntoView({block:"center"})`);
      await new Promise((r) => setTimeout(r, 300));
      const img2 = await settingsWin!.webContents.capturePage();
      fs.writeFileSync("/tmp/tl-settings-codex.png", img2.toPNG());
      app.quit();
    }, 3000);
  });
}

// ---- 自检模式（TL_DEBUG_STATE_DUMP=路径）：每秒把聚合与会话状态写入 JSON（端到端验证断言用） ----
if (process.env.TL_DEBUG_STATE_DUMP) {
  const out = process.env.TL_DEBUG_STATE_DUMP;
  app.whenReady().then(() => {
    setInterval(() => {
      try {
        fs.writeFileSync(out, JSON.stringify({ at: Date.now(), aggregate: tracker.aggregate(), sessions: tracker.sessions() }, null, 1));
      } catch {
        /* 忽略写失败 */
      }
    }, 1000);
  });
}

// ---- 自检模式（TL_DEBUG_MIXED_SHOT=1）：注入 cursor+codex 混合会话（仅内存），截明细面板 ----
if (process.env.TL_DEBUG_MIXED_SHOT) {
  app.whenReady().then(() => {
    setTimeout(async () => {
      // 钉住存活缓存：演示会话不被 tick 的 tool_exited 清场
      aliveCache = { at: Date.now() + 1e9, byTool: { cursor: true, codex: true, qoder: true } };
      const ts = Date.now();
      tracker.handleEvent({ v: 1, tool: "cursor", sessionId: "demo-cursor-1", event: "prompt", ts, meta: {} });
      tracker.handleEvent({ v: 2, tool: "codex", sessionId: "demo-codex-1", event: "prompt", ts, meta: {} });
      tracker.handleEvent({ v: 2, tool: "codex", sessionId: "demo-codex-2", event: "prompt", ts, meta: {} });
      tracker.handleEvent({ v: 2, tool: "codex", sessionId: "demo-codex-2", event: "approval_request", ts, meta: {} });
      tracker.handleEvent({ v: 3, tool: "qoder", sessionId: "demo-qoder-1.session.execution", event: "activity", ts, meta: {} });
      tracker.handleEvent({ v: 3, tool: "qoder", sessionId: "demo-qoder-1.session.execution", event: "user_action_required", ts, meta: {} });
      lastPushed = "";
      pushState();
      await new Promise((r) => setTimeout(r, 600));
      const click = (color: string) =>
        widget!.webContents.executeJavaScript(`document.getElementById('lamp-${color}').onclick(new MouseEvent('click', {bubbles: true}))`);
      const shot = async (tag: string) => {
        const img = await widget!.webContents.capturePage();
        fs.writeFileSync(`/tmp/tl-mixed-${tag}.png`, img.toPNG());
      };
      await click("green");
      await new Promise((r) => setTimeout(r, 800));
      await shot("green");
      await click("yellow");
      await new Promise((r) => setTimeout(r, 800));
      await shot("yellow");
      app.quit();
    }, 4000);
  });
}

// ---- 自检模式（TL_DEBUG_SHOT=1）：把窗口贴右缘，模拟点灯珠展开/收起，逐帧截图到 /tmp ----
if (process.env.TL_DEBUG_SHOT) {
  const shot = async (tag: string) => {
    if (!widget) return;
    const img = await widget.webContents.capturePage();
    fs.writeFileSync(`/tmp/tl-shot-${tag}.png`, img.toPNG());
    const b = widget.getBounds();
    console.log(`[shot] ${tag} bounds=${JSON.stringify(b)}`);
  };
  const fire = (color: string, type: string) =>
    widget!.webContents.executeJavaScript(
      `document.getElementById('lamp-${color}').on${type}(new MouseEvent('${type}', {clientX: 40, clientY: 60, bubbles: true}))`,
    );
  const clickLamp = (color: string) => fire(color, "click");
  app.whenReady().then(() => {
    setTimeout(async () => {
      const area = screen.getPrimaryDisplay().workArea;
      widget!.setBounds({ x: area.x + area.width - 92 - 4, y: area.y + 200, width: 92, height: 250 });
      await new Promise((r) => setTimeout(r, 500));
      await shot("1-collapsed-right");
      await clickLamp("green");
      await new Promise((r) => setTimeout(r, 120));
      await shot("2-expand-early"); // 展开后 120ms：检查是否截断
      await new Promise((r) => setTimeout(r, 800));
      await shot("3-expand-settled");
      await clickLamp("green");
      await new Promise((r) => setTimeout(r, 300));
      await shot("4-collapsed-again");
      await clickLamp("green");
      await new Promise((r) => setTimeout(r, 120));
      await shot("5-reexpand-early");
      await new Promise((r) => setTimeout(r, 800));
      await shot("6-reexpand-settled");
      await clickLamp("green"); // 收起，回到折叠态测悬停
      await new Promise((r) => setTimeout(r, 400));
      // 空灯珠悬停 toast：进入两次抓帧确认宽度/坐标稳定，离开后确认复原
      // 悬停期间以 50ms 高频采样窗口 bounds，覆盖多个 2s 状态推送周期，抓瞬时横跳
      const sample = async (ms: number, tag: string) => {
        const seen = new Set<string>();
        const until = Date.now() + ms;
        while (Date.now() < until) {
          const b = widget!.getBounds();
          seen.add(`x=${b.x},w=${b.width}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        console.log(`[shot] sample:${tag} -> ${[...seen].join(" | ")}`);
      };
      await fire("red", "mouseenter");
      await new Promise((r) => setTimeout(r, 150));
      await shot("7-hover-toast");
      await sample(5000, "hover-red-5s");
      // 相邻灯珠间快速移动：leave/enter 连发不应产生缩扩
      await fire("red", "mouseleave");
      await fire("yellow", "mouseenter");
      await sample(1500, "red-to-yellow");
      await fire("yellow", "mouseleave");
      await new Promise((r) => setTimeout(r, 600));
      await shot("9-hover-left");
      app.quit();
    }, 4000);
  });
}
