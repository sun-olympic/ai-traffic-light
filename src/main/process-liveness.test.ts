import { describe, expect, test } from "vitest";
import { antigravityBackendAlive, anyProcessMatches, codexProcessAlive, ANTIGRAVITY_PROCESS_PATTERNS, CODEX_PROCESS_PATTERNS, CURSOR_PROCESS_PATTERNS, QODER_PROCESS_PATTERNS } from "./process-liveness";

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
