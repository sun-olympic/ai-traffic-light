// 应用配置（~/.ai-traffic-light/config.json），带版本字段（design.md D3）
export const CONFIG_VERSION = 1;

export interface AppConfig {
  v: number;
  /** 审批等待判定阈值（before_exec 后静默超时） */
  approvalThresholdMs: number;
  /** 疑似卡死判定阈值（气泡 loading 持续时长） */
  stuckThresholdMs: number;
  /** 运行中但长时间无任何事件的提醒阈值（turn 挂起等后台任务等场景，与卡死区分） */
  inactiveThresholdMs: number;
  /** 提问等待触发 DB 轮询前的事件静默时长 */
  quietBeforeProbeMs: number;
  /** 僵尸会话 GC 阈值 */
  sessionGcMs: number;
  /** Cursor 进程存活检测周期 */
  livenessIntervalMs: number;
  /** Shell 长命令白名单（子串匹配，命中不亮审批黄灯） */
  shellWhitelist: string[];
  /** MCP 工具名白名单 */
  mcpWhitelist: string[];
  /** 结尾提问判定的疑问词表 */
  questionWords: string[];
  /** 是否跟踪背景 agent（is_background_agent=true） */
  includeBackgroundAgents: boolean;
  /** 快速变绿：安装 beforeReadFile 活动信号 hook（代价：agent 每次读文件约 +70ms） */
  fastGreenReadSignal: boolean;
  /** 黄灯呼吸动画 */
  breathingAnimation: boolean;
  /** 系统通知 / 声音提醒（默认均关） */
  systemNotification: boolean;
  soundAlert: boolean;
  /** 界面语言 */
  language: "zh" | "en";
}

export const DEFAULT_CONFIG: AppConfig = {
  v: CONFIG_VERSION,
  approvalThresholdMs: 15_000,
  stuckThresholdMs: 300_000,
  inactiveThresholdMs: 300_000,
  quietBeforeProbeMs: 5_000,
  sessionGcMs: 24 * 3600_000,
  livenessIntervalMs: 30_000,
  shellWhitelist: ["npm install", "npm run build", "npm test", "yarn install", "pnpm install", "swift build", "cargo build", "mvn ", "gradle ", "pytest", "docker build"],
  mcpWhitelist: [],
  questionWords: ["请确认", "是否", "要不要", "选哪", "告诉我", "哪种方案", "哪个方案", "可以吗", "行吗", "如何选择"],
  includeBackgroundAgents: false,
  fastGreenReadSignal: true,
  breathingAnimation: true,
  systemNotification: false,
  soundAlert: false,
  language: "zh",
};

/** 合并用户配置与默认值：字段级类型校验，非法/缺失字段回退默认，版本号提升为当前。 */
export function mergeConfig(partial: Partial<AppConfig> | undefined): AppConfig {
  const out: AppConfig = { ...DEFAULT_CONFIG, shellWhitelist: [...DEFAULT_CONFIG.shellWhitelist], mcpWhitelist: [...DEFAULT_CONFIG.mcpWhitelist], questionWords: [...DEFAULT_CONFIG.questionWords] };
  if (!partial) return out;
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[]) {
    if (key === "v") continue;
    const val = partial[key];
    const def = DEFAULT_CONFIG[key];
    if (val === undefined) continue;
    if (Array.isArray(def)) {
      if (Array.isArray(val) && val.every((x) => typeof x === "string")) {
        (out as unknown as Record<string, unknown>)[key] = [...val];
      }
    } else if (typeof val === typeof def) {
      (out as unknown as Record<string, unknown>)[key] = val;
    }
  }
  return out;
}
