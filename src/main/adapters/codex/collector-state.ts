// Codex 采集三态判定（design.md D6）：未安装 / 引擎禁用 / 已安装未生效 / 采集正常。
// 纯函数：证据由 App 层采集（installer/liveness/rollout mtime/最后事件时间）注入。
export type CodexCollectorState = "not_installed" | "disabled" | "installed_inactive" | "ok";

export interface CodexCollectorEvidence {
  installed: boolean;
  /** config.toml [features].hooks=false（明确提示，不落模糊态） */
  featureDisabled: boolean;
  /** [hooks.state] 信任记账齐全（key 存在≠哈希有效，盲区靠活跃迹象兜底） */
  trusted: boolean;
  codexAlive: boolean;
  /** 近 24h rollout 目录最新文件 mtime，0 = 无活动 */
  rolloutActivityAt: number;
  /** 最后收到 codex 事件的事件时间戳，0 = 从未 */
  lastEventAt: number;
}

/** 活跃迹象窗口：rollout 有活动但事件落后超过此值才判未生效（给安装/信任后的首次生效留窗口） */
const INACTIVE_GAP_MS = 120_000;

export function codexCollectorState(e: CodexCollectorEvidence): CodexCollectorState {
  if (!e.installed) return "not_installed";
  if (e.featureDisabled) return "disabled";
  // 精确检测：信任记账缺失 = 必然未生效（安装后未跑 /hooks 信任）
  if (!e.trusted) return "installed_inactive";
  // 盲区兜底（活跃迹象前置）：Codex 存活 + rollout 在动、事件却断流 → 疑似信任哈希失配/未重启
  if (e.codexAlive && e.rolloutActivityAt > 0 && e.rolloutActivityAt - e.lastEventAt > INACTIVE_GAP_MS) {
    return "installed_inactive";
  }
  return "ok";
}
