// 工具进程存活检测（design.md D8）：
// - macOS/Linux：ps comm 完整路径特征匹配。不用裸词匹配——本机 ps 存在 /var/run/.../codex.system/
//   等无关系统路径字样；不用 pgrep——-x/-f 依赖读进程 argv，受限环境漏报，ps 的 comm 列始终可读。
// - Windows：tasklist 只给镜像名（无路径），按行大小写不敏感精确匹配。
// ponytail: Windows 镜像名（Cursor.exe/Qoder.exe/codex-*.exe）为合理推测，无真机实样，待实测校正
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

export function anyProcessMatches(psComm: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => psComm.includes(p));
}

/** Windows：表内容为镜像名每行一个，逐行大小写不敏感精确匹配 */
function imageLineMatches(table: string, names: readonly string[]): boolean {
  const wanted = names.map((n) => n.toLowerCase());
  return table.split("\n").some((line) => wanted.includes(line.trim().toLowerCase()));
}

export function cursorProcessAlive(table: string, platform: string = process.platform): boolean {
  if (platform === "win32") return imageLineMatches(table, ["Cursor.exe"]);
  return anyProcessMatches(table, CURSOR_PROCESS_PATTERNS);
}

export function qoderProcessAlive(table: string, platform: string = process.platform): boolean {
  if (platform === "win32") return imageLineMatches(table, ["Qoder.exe"]);
  return anyProcessMatches(table, QODER_PROCESS_PATTERNS);
}

/** Antigravity 仅支持 macOS（store-locator 同样只认 darwin），Windows 恒 false */
export function antigravityProcessAlive(table: string, platform: string = process.platform): boolean {
  if (platform === "win32") return false;
  return anyProcessMatches(table, ANTIGRAVITY_PROCESS_PATTERNS);
}

/** 后端单独判定（D14 健康分层）：app 壳活着但后端挂了时健康页可区分展示 */
export function antigravityBackendAlive(table: string, platform: string = process.platform): boolean {
  if (platform === "win32") return false;
  return table.includes(ANTIGRAVITY_BACKEND_PATTERN);
}

/**
 * Codex 存活：App 包路径特征之外，还要覆盖 PATH 安装（Homebrew/npm）——按行取 basename 精确匹配
 * `codex` 或 `codex-*`（npm 包实际 spawn 的是 codex-<arch>-<platform> 原生二进制）。
 * 精确到 basename 而非裸词 includes：/var/run/.../codex.system/ 等系统路径字样不误配。
 * Windows：镜像名 codex.exe 或 codex-*.exe。
 */
export function codexProcessAlive(table: string, platform: string = process.platform): boolean {
  if (platform === "win32") {
    return table.split("\n").some((line) => {
      const l = line.trim().toLowerCase();
      return l === "codex.exe" || (l.startsWith("codex-") && l.endsWith(".exe"));
    });
  }
  if (anyProcessMatches(table, CODEX_PROCESS_PATTERNS)) return true;
  return table.split("\n").some((line) => {
    const l = line.trim();
    const base = l.slice(l.lastIndexOf("/") + 1);
    return base === "codex" || base.startsWith("codex-");
  });
}

// CodeBuddy CN（VS Code 派生）：主进程 comm 为 <App>/Contents/MacOS/Electron，用包路径前缀匹配
export const CODEBUDDY_PROCESS_PATTERNS = ["CodeBuddy CN.app/Contents/MacOS/"] as const;

export function codebuddyProcessAlive(table: string, platform: string = process.platform): boolean {
  if (platform === "win32") return imageLineMatches(table, ["CodeBuddy CN.exe"]);
  return anyProcessMatches(table, CODEBUDDY_PROCESS_PATTERNS);
}

// ponytail: WorkBuddy 进程名待真机确认，推测为 "Tencent WorkBuddy.app" 或 "WorkBuddy.app"
export const WORKBUDDY_PROCESS_PATTERNS = ["WorkBuddy.app/Contents/MacOS/"] as const;

export function workbuddyProcessAlive(table: string, platform: string = process.platform): boolean {
  if (platform === "win32") return imageLineMatches(table, ["WorkBuddy.exe", "Tencent WorkBuddy.exe"]);
  return anyProcessMatches(table, WORKBUDDY_PROCESS_PATTERNS);
}

/** tasklist /fo csv /nh 输出 → 镜像名每行一个（畸形行/提示行安全跳过） */
export function parseTasklist(csv: string): string {
  const names: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) names.push(m[1]);
  }
  return names.join("\n");
}

export function processTablePsArgs(includeArgs: boolean): string[] {
  return includeArgs ? ["-axo", "pid,etime,comm,args"] : ["-axo", "comm"];
}

export function readProcessTable(platform: string = process.platform): string {
  try {
    if (platform === "win32") {
      return parseTasklist(execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf-8" }));
    }
    return execFileSync("ps", processTablePsArgs(false), { encoding: "utf-8" });
  } catch {
    return "";
  }
}

export function readProcessArgsTable(platform: string = process.platform): string {
  try {
    if (platform === "win32") {
      return parseTasklist(execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf-8" }));
    }
    return execFileSync("ps", processTablePsArgs(true), { encoding: "utf-8" });
  } catch {
    return "";
  }
}
