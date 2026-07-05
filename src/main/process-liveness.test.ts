import { describe, expect, test } from "vitest";
import { antigravityBackendAlive, antigravityProcessAlive, anyProcessMatches, codexProcessAlive, cursorProcessAlive, parseTasklist, qoderProcessAlive, ANTIGRAVITY_PROCESS_PATTERNS, CODEX_PROCESS_PATTERNS, CURSOR_PROCESS_PATTERNS, QODER_PROCESS_PATTERNS } from "./process-liveness";

const PS_WITH_DESKTOP = [
  "/sbin/launchd",
  "/Applications/Codex.app/Contents/MacOS/Codex",
  "/usr/libexec/trustd",
].join("\n");

const PS_WITH_CLI = [
  "/sbin/launchd",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/usr/libexec/trustd",
].join("\n");

// 本机 ps 实况：存在 codex.system 无关系统路径，裸词 codex 会误配
const PS_ONLY_NOISE = [
  "/sbin/launchd",
  "/var/run/com.apple.security.cryptexd/codex.system/usr/libexec/foo",
  "/usr/libexec/trustd",
].join("\n");

describe("Qoder 进程存活匹配（主进程 comm 为 Electron，按包路径前缀）", () => {
  test("主进程存活 → true", () => {
    expect(anyProcessMatches("/sbin/launchd\n/Applications/Qoder.app/Contents/MacOS/Electron", QODER_PROCESS_PATTERNS)).toBe(true);
  });

  test("Qoder 已退出 → false", () => {
    expect(anyProcessMatches("/sbin/launchd\n/usr/libexec/trustd", QODER_PROCESS_PATTERNS)).toBe(false);
  });
});

describe("Codex 进程存活匹配（完整路径特征）", () => {
  test("桌面 App 单独存活 → true", () => {
    expect(anyProcessMatches(PS_WITH_DESKTOP, CODEX_PROCESS_PATTERNS)).toBe(true);
  });

  test("内嵌 CLI（app-server/exec 同二进制）→ true", () => {
    expect(anyProcessMatches(PS_WITH_CLI, CODEX_PROCESS_PATTERNS)).toBe(true);
  });

  test("codex.system 等无关系统路径不误配", () => {
    expect(anyProcessMatches(PS_ONLY_NOISE, CODEX_PROCESS_PATTERNS)).toBe(false);
  });

  test("全部前端退出 → false", () => {
    expect(anyProcessMatches("/sbin/launchd\n/usr/libexec/trustd", CODEX_PROCESS_PATTERNS)).toBe(false);
  });
});

describe("codexProcessAlive（覆盖 PATH 安装）", () => {
  test("Homebrew/PATH 二进制（basename=codex）→ true", () => {
    expect(codexProcessAlive("/sbin/launchd\n/opt/homebrew/bin/codex\n/usr/libexec/trustd")).toBe(true);
  });

  test("npm 原生二进制（codex-<arch>-<platform>）→ true", () => {
    expect(codexProcessAlive("/Users/x/.npm-global/lib/node_modules/@openai/codex/vendor/codex-aarch64-apple-darwin")).toBe(true);
  });

  test("App 包路径仍然命中", () => {
    expect(codexProcessAlive(PS_WITH_DESKTOP)).toBe(true);
  });

  test("codex.system 系统路径与普通进程不误配", () => {
    expect(codexProcessAlive(PS_ONLY_NOISE)).toBe(false);
    expect(codexProcessAlive("/sbin/launchd\n/usr/libexec/trustd")).toBe(false);
  });
});

describe("Antigravity 进程存活匹配（D14 app 壳与 language_server 两层）", () => {
  test("app 壳存活 → true", () => {
    expect(anyProcessMatches("/sbin/launchd\n/Applications/Antigravity.app/Contents/MacOS/Antigravity", ANTIGRAVITY_PROCESS_PATTERNS)).toBe(true);
  });

  test("仅后端 language_server 存活也算存活", () => {
    expect(anyProcessMatches("/Applications/Antigravity.app/Contents/Resources/bin/language_server", ANTIGRAVITY_PROCESS_PATTERNS)).toBe(true);
  });

  test("Antigravity 已退出 → false", () => {
    expect(anyProcessMatches("/sbin/launchd\n/usr/libexec/trustd", ANTIGRAVITY_PROCESS_PATTERNS)).toBe(false);
  });

  test("backend 单独判定：只有 app 壳时 backend=false（健康分层用）", () => {
    expect(antigravityBackendAlive("/Applications/Antigravity.app/Contents/MacOS/Antigravity")).toBe(false);
    expect(antigravityBackendAlive("/Applications/Antigravity.app/Contents/Resources/bin/language_server")).toBe(true);
  });
});

describe("Cursor 进程匹配（既有行为回归）", () => {
  test("Cursor 主进程存活 → true", () => {
    expect(anyProcessMatches("/Applications/Cursor.app/Contents/MacOS/Cursor", CURSOR_PROCESS_PATTERNS)).toBe(true);
  });
});

describe("Windows 进程存活（tasklist 镜像名，逐行大小写不敏感精确匹配）", () => {
  const WIN_TABLE = ["System", "svchost.exe", "Cursor.exe", "node.exe"].join("\n");

  test("cursor：Cursor.exe 命中（大小写不敏感）", () => {
    expect(cursorProcessAlive(WIN_TABLE, "win32")).toBe(true);
    expect(cursorProcessAlive("system\ncursor.exe", "win32")).toBe(true);
    expect(cursorProcessAlive("System\nCursorHelper.exe", "win32")).toBe(false);
  });

  test("codex：codex.exe 与 npm 原生二进制 codex-*.exe 命中，噪音不误配", () => {
    expect(codexProcessAlive("svchost.exe\ncodex.exe", "win32")).toBe(true);
    expect(codexProcessAlive("codex-x86_64-pc-windows-msvc.exe", "win32")).toBe(true);
    expect(codexProcessAlive("svchost.exe\nnode.exe", "win32")).toBe(false);
    expect(codexProcessAlive("mycodex.exe", "win32")).toBe(false);
  });

  test("qoder：Qoder.exe 命中", () => {
    expect(qoderProcessAlive("Qoder.exe\nsvchost.exe", "win32")).toBe(true);
    expect(qoderProcessAlive(WIN_TABLE, "win32")).toBe(false);
  });

  test("antigravity：Windows 未支持，恒 false（含后端）", () => {
    expect(antigravityProcessAlive("Antigravity.exe", "win32")).toBe(false);
    expect(antigravityBackendAlive("language_server_windows_x64.exe", "win32")).toBe(false);
  });

  test("mac 平台走既有路径特征（默认参数回归）", () => {
    expect(cursorProcessAlive("/Applications/Cursor.app/Contents/MacOS/Cursor", "darwin")).toBe(true);
    expect(qoderProcessAlive("/Applications/Qoder.app/Contents/MacOS/Electron", "darwin")).toBe(true);
    expect(antigravityProcessAlive("/Applications/Antigravity.app/Contents/MacOS/Antigravity", "darwin")).toBe(true);
    expect(codexProcessAlive("/opt/homebrew/bin/codex", "darwin")).toBe(true);
  });
});

describe("parseTasklist（CSV 无表头 → 镜像名每行一个）", () => {
  test("取每行第一个引号字段", () => {
    const csv = ['"Cursor.exe","1234","Console","1","123,456 K"', '"svchost.exe","456","Services","0","9,876 K"'].join("\r\n");
    expect(parseTasklist(csv)).toBe("Cursor.exe\nsvchost.exe");
  });

  test("空输出与畸形行安全跳过", () => {
    expect(parseTasklist("")).toBe("");
    expect(parseTasklist("INFO: No tasks found.\n")).toBe("");
  });
});
