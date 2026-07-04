// 工具进程存活检测（design.md D8）：ps comm 完整路径特征匹配。
// 不用裸词匹配——本机 ps 存在 /var/run/.../codex.system/ 等无关系统路径字样；
// 不用 pgrep——-x/-f 依赖读进程 argv，受限环境漏报，ps 的 comm 列始终可读。
import { execFileSync } from "node:child_process";

export const CURSOR_PROCESS_PATTERNS = ["Cursor.app/Contents/MacOS/Cursor"] as const;

// spike 1.5 实样：桌面主进程 + 内嵌 CLI（app-server/exec/TUI 同一二进制）。
// ponytail: IDE 扩展 spawn 的进程路径本机未装无实样，留待实测后补充特征
export const CODEX_PROCESS_PATTERNS = ["Codex.app/Contents/MacOS/Codex", "Codex.app/Contents/Resources/codex"] as const;

// Qoder（VS Code 派生）主进程 comm 实测为 <App>/Contents/MacOS/Electron，用包路径前缀匹配即可覆盖主进程与 Helper
export const QODER_PROCESS_PATTERNS = ["Qoder.app/Contents/MacOS/"] as const;

// Antigravity 双层进程（add-antigravity-support D14）：app 壳 + language_server 后端，任一存活即算存活
const ANTIGRAVITY_BACKEND_PATTERN = "Antigravity.app/Contents/Resources/bin/language_server";
export const ANTIGRAVITY_PROCESS_PATTERNS = ["Antigravity.app/Contents/MacOS/", ANTIGRAVITY_BACKEND_PATTERN] as const;

/** 后端单独判定（D14 健康分层）：app 壳活着但后端挂了时健康页可区分展示 */
export function antigravityBackendAlive(psComm: string): boolean {
  return psComm.includes(ANTIGRAVITY_BACKEND_PATTERN);
}

export function anyProcessMatches(psComm: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => psComm.includes(p));
}

/**
 * Codex 存活：App 包路径特征之外，还要覆盖 PATH 安装（Homebrew/npm）——按行取 basename 精确匹配
 * `codex` 或 `codex-*`（npm 包实际 spawn 的是 codex-<arch>-<platform> 原生二进制）。
 * 精确到 basename 而非裸词 includes：/var/run/.../codex.system/ 等系统路径字样不误配。
 */
export function codexProcessAlive(psComm: string): boolean {
  if (anyProcessMatches(psComm, CODEX_PROCESS_PATTERNS)) return true;
  return psComm.split("\n").some((line) => {
    const l = line.trim();
    const base = l.slice(l.lastIndexOf("/") + 1);
    return base === "codex" || base.startsWith("codex-");
  });
}

export function readProcessTable(): string {
  try {
    return execFileSync("ps", ["-axo", "comm"], { encoding: "utf-8" });
  } catch {
    return "";
  }
}
