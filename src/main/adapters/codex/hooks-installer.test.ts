import { beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_HOOK_EVENTS, CodexHooksInstaller } from "./hooks-installer";

let appHome: string;
let codexDir: string;
let installer: CodexHooksInstaller;

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), "tl-home-"));
  codexDir = mkdtempSync(join(tmpdir(), "tl-codex-"));
  installer = new CodexHooksInstaller({
    appHome,
    codexDir,
    scriptSource: join(__dirname, "../../../../hook-scripts/codex-collect.cjs"),
  });
});

function hooksFile(): { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> } {
  return JSON.parse(readFileSync(join(codexDir, "hooks.json"), "utf-8"));
}

describe("安装", () => {
  test("全新安装：创建 hooks.json，5 个事件各一条 command 条目且带 timeout", async () => {
    await installer.install();
    const f = hooksFile();
    expect(Object.keys(f.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    for (const ev of CODEX_HOOK_EVENTS) {
      const groups = f.hooks[ev];
      expect(groups).toHaveLength(1);
      const h = groups[0].hooks[0];
      expect(h.type).toBe("command");
      expect(String(h.command)).toContain(join(appHome, "hooks", "codex-collect.cjs"));
      expect(h.timeout).toBe(5);
    }
    expect(existsSync(join(appHome, "hooks", "codex-collect.cjs"))).toBe(true);
  });

  test("PreToolUse 不在安装事件表中（spike 1.3 定案）", () => {
    expect(CODEX_HOOK_EVENTS).not.toContain("PreToolUse");
  });

  test("保留用户已有条目并备份原文件", async () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook.sh", timeout: 30 }] }] } };
    writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(user));
    await installer.install();
    const f = hooksFile();
    expect(f.hooks.Stop[0].hooks[0].command).toBe("my-own-hook.sh");
    expect(f.hooks.Stop).toHaveLength(2);
    expect(readdirSync(codexDir).some((n) => n.startsWith("hooks.json.bak-"))).toBe(true);
  });

  test("幂等：重复安装不产生重复条目且定义不变（信任哈希口径）", async () => {
    await installer.install();
    const first = readFileSync(join(codexDir, "hooks.json"), "utf-8");
    await installer.install();
    const second = readFileSync(join(codexDir, "hooks.json"), "utf-8");
    expect(second).toBe(first);
  });

  test("不触碰 config.toml", async () => {
    const toml = 'notify = ["some-app"]\n[features]\nhooks = true\n';
    writeFileSync(join(codexDir, "config.toml"), toml);
    await installer.install();
    expect(readFileSync(join(codexDir, "config.toml"), "utf-8")).toBe(toml);
  });
});

describe("卸载", () => {
  test("卸载幂等：hooks.json 不存在时不抛错、不新建文件", async () => {
    await expect(installer.uninstall()).resolves.toBeUndefined();
    expect(existsSync(join(codexDir, "hooks.json"))).toBe(false);
  });

  test("命令中脚本路径带引号（home 含空格不被 shell 拆分）", async () => {
    await installer.install();
    const f = hooksFile();
    expect(f.hooks.Stop.at(-1)!.hooks[0].command).toBe(`node "${join(appHome, "hooks", "codex-collect.cjs")}"`);
  });

  test("精确移除本工具条目，用户条目不受影响", async () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook.sh" }] }] } };
    writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(user));
    await installer.install();
    await installer.uninstall();
    const f = hooksFile();
    expect(f.hooks.Stop).toHaveLength(1);
    expect(f.hooks.Stop[0].hooks[0].command).toBe("my-own-hook.sh");
    for (const ev of CODEX_HOOK_EVENTS) {
      for (const g of f.hooks[ev] ?? []) {
        expect(JSON.stringify(g)).not.toContain(appHome);
      }
    }
  });
});

describe("状态检测", () => {
  test("未安装 → installed=false", async () => {
    expect((await installer.status()).installed).toBe(false);
  });

  test("安装后 → installed=true", async () => {
    await installer.install();
    expect((await installer.status()).installed).toBe(true);
  });

  test("条目缺失（用户手动删了一个事件）→ installed=false 带 detail", async () => {
    await installer.install();
    const f = hooksFile();
    delete (f.hooks as Record<string, unknown>).Stop;
    writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(f));
    const st = await installer.status();
    expect(st.installed).toBe(false);
    expect(st.detail).toContain("Stop");
  });

  test("hooks 引擎禁用检测：[features] hooks = false", async () => {
    writeFileSync(join(codexDir, "config.toml"), "[features]\nhooks = false\n");
    expect(await installer.hooksFeatureDisabled()).toBe(true);
    writeFileSync(join(codexDir, "config.toml"), "[features]\nhooks = true\n");
    expect(await installer.hooksFeatureDisabled()).toBe(false);
    writeFileSync(join(codexDir, "config.toml"), "");
    expect(await installer.hooksFeatureDisabled()).toBe(false);
  });
});

describe("信任态检测（只读 config.toml [hooks.state]）", () => {
  test("全部事件的信任 key 存在 → trusted=true", async () => {
    await installer.install();
    const keys = installer.expectedTrustKeys(hooksFile().hooks);
    const toml = keys.map((k) => `[hooks.state."${k}"]\ntrusted_hash = "sha256:abc"`).join("\n") + "\n";
    writeFileSync(join(codexDir, "config.toml"), toml);
    expect(await installer.trustStatus()).toEqual({ trusted: true, missing: [] });
  });

  test("部分 key 缺失 → trusted=false 且列出缺失事件", async () => {
    await installer.install();
    const keys = installer.expectedTrustKeys(hooksFile().hooks);
    const toml = `[hooks.state."${keys[0]}"]\ntrusted_hash = "sha256:abc"\n`;
    writeFileSync(join(codexDir, "config.toml"), toml);
    const st = await installer.trustStatus();
    expect(st.trusted).toBe(false);
    expect(st.missing.length).toBe(keys.length - 1);
  });

  test("信任 key 按实际组序计算（用户条目在前时我们的组序为 1）", async () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook.sh" }] }] } };
    writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(user));
    await installer.install();
    const keys = installer.expectedTrustKeys(hooksFile().hooks);
    const stopKey = keys.find((k) => k.includes(":stop:"))!;
    expect(stopKey).toContain(":stop:1:0");
  });

  test("config.toml 无 [hooks.state] → 全部缺失", async () => {
    await installer.install();
    const st = await installer.trustStatus();
    expect(st.trusted).toBe(false);
  });
});
