import { beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QoderHooksInstaller, QODER_HOOK_EVENTS } from "./hooks-installer";

let qoderDir: string;
let appHome: string;
let installer: QoderHooksInstaller;

beforeEach(() => {
  qoderDir = mkdtempSync(join(tmpdir(), "tl-qoder-"));
  appHome = mkdtempSync(join(tmpdir(), "tl-home-"));
  installer = new QoderHooksInstaller({ qoderDir, appHome, scriptSource: join(__dirname, "../../../../hook-scripts/qoder-collect.cjs") });
});

describe("Qoder hooks installer", () => {
  test("registers PreToolUse so AskUserQuestion waits can be observed", () => {
    expect(QODER_HOOK_EVENTS).toContain("PreToolUse");
  });

  test("installs supported lifecycle events and preserves user settings", async () => {
    writeFileSync(join(qoderDir, "settings.json"), JSON.stringify({ model: "keep", hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-hook" }] }] } }));
    await installer.install();
    const settings = JSON.parse(readFileSync(join(qoderDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("keep");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("user-hook");
    for (const event of QODER_HOOK_EVENTS) {
      expect(settings.hooks[event].flatMap((group: { hooks: Array<{ command?: string }> }) => group.hooks).filter((hook) => hook.command?.includes("qoder-collect.cjs"))).toHaveLength(1);
    }
    expect(existsSync(join(appHome, "hooks", "qoder-collect.cjs"))).toBe(true);
  });

  test("installation is idempotent and uninstall only removes our hook groups", async () => {
    writeFileSync(join(qoderDir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] } }));
    await installer.install();
    await installer.install();
    await installer.uninstall();
    const settings = JSON.parse(readFileSync(join(qoderDir, "settings.json"), "utf8"));
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "user-hook" }] }]);
    for (const event of QODER_HOOK_EVENTS) expect(JSON.stringify(settings.hooks[event] ?? [])).not.toContain(appHome);
  });

  test("uninstall before installation does not create settings.json", async () => {
    await installer.uninstall();
    expect(existsSync(join(qoderDir, "settings.json"))).toBe(false);
  });
});
