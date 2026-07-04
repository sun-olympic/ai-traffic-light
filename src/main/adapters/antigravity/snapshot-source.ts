// Antigravity 快照源（add-antigravity-support D12/D24/D34/D35）。
// 单一职责：组合 store-locator + db-reader + derive-state 产出 AntigravitySnapshot，
// 汇总健康态并做逐文件读取退避；diff/事件语义在 poller，不在这里。
import * as fs from "node:fs";
import { discoverCandidates } from "./store-locator";
import { readSteps, type ReadFailure } from "./db-reader";
import { deriveObservation } from "./derive-state";
import type { AntigravitySnapshot, SessionSnapshot } from "./poller";

export type AntigravityHealth = "not_detected" | "ok" | "degraded" | "schema_mismatch" | "permission_denied";

/** 隐私安全显示/通知名（D21/D32）：只用短 id，绝不用 prompt 类标题；标题展示需未来显式 opt-in */
export function antigravitySafeName(sessionId: string): string {
  return `Antigravity ${sessionId.slice(0, 8)}`;
}

/** 失败原因 → 健康态；多库失败时取最严重（permission > schema > degraded） */
const FAILURE_HEALTH: Record<ReadFailure, AntigravityHealth> = {
  permission_denied: "permission_denied",
  schema_mismatch: "schema_mismatch",
  unreadable: "degraded",
};
const HEALTH_SEVERITY: Record<AntigravityHealth, number> = { ok: 0, not_detected: 0, degraded: 1, schema_mismatch: 2, permission_denied: 3 };

export interface SnapshotSourceOpts {
  /** 每轮候选上限（透传 locator） */
  cap?: number;
  /** 失败库的重试退避窗口 */
  retryMs?: number;
  clock?: () => number;
}

const DEFAULT_RETRY_MS = 30_000;

export class AntigravitySnapshotSource {
  private readonly home: string | null;
  private readonly cap?: number;
  private readonly retryMs: number;
  private readonly clock: () => number;
  /** 逐文件退避（D35）：某个库失败不拖累其他库 */
  private readonly nextRetryAt = new Map<string, number>();
  private lastHealth: AntigravityHealth = "not_detected";

  constructor(home: string | null, opts: SnapshotSourceOpts = {}) {
    this.home = home;
    this.cap = opts.cap;
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
    this.clock = opts.clock ?? Date.now;
  }

  health(): AntigravityHealth {
    return this.lastHealth;
  }

  /** 读取当前快照；null = 未检测到（中性）。部分库失败时返回成功部分并降级健康（D28 安全：缺失会话不清灯） */
  read(): AntigravitySnapshot | null {
    if (this.home === null || !fs.existsSync(this.home)) {
      this.lastHealth = "not_detected";
      return null;
    }
    const now = this.clock();
    const sessions: SessionSnapshot[] = [];
    let worst: AntigravityHealth = "ok";
    for (const cand of discoverCandidates(this.home, this.cap)) {
      const retryAt = this.nextRetryAt.get(cand.dbPath);
      if (retryAt !== undefined && now < retryAt) {
        worst = worse(worst, "degraded"); // 退避中的库视为仍在降级
        continue;
      }
      const r = readSteps(cand); // DatabaseSync 同步读，天然一次一个库（D12）
      if (!r.ok) {
        this.nextRetryAt.set(cand.dbPath, now + this.retryMs);
        worst = worse(worst, FAILURE_HEALTH[r.reason]);
        continue;
      }
      this.nextRetryAt.delete(cand.dbPath);
      sessions.push({ sessionId: cand.sessionId, observation: deriveObservation(r.rows), mtime: cand.mtime, epoch: cand.ino });
    }
    this.lastHealth = worst;
    return { sessions };
  }
}

function worse(a: AntigravityHealth, b: AntigravityHealth): AntigravityHealth {
  return HEALTH_SEVERITY[b] > HEALTH_SEVERITY[a] ? b : a;
}
