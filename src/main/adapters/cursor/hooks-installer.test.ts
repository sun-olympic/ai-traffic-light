import { beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HooksInstaller, HOOK_EVENTS } from "./hooks-installer";

let home: string;
let cursorDir: string;
let installer: HooksInstaller;

function hooksJson(): { version: number; hooks: Record<string, Array<{ command: string }>> } {
  return JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf-8"));
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "tl-inst-"));
  home = join(base, ".ai-traffic-light");
  cursorDir = join(base, ".cursor");
  mkdirSync(cursorDir, { recursive: true });
  installer = new HooksInstaller({ appHome: home, cursorDir });
});

describe("hooks 合并式安装", () => {
  test("全新安装：8 类事件各有一条指向稳定路径的条目，脚本被复制", async () => {
    await installer.install();
    const hj = hooksJson();
    for (const ev of HOOK_EVENTS) {
      const entries = hj.hooks[ev];
      expect(entries?.length, ev).toBe(1);
      expect(entries[0].command).toContain(join(home, "hooks"));
      expect(entries[0].command).not.toContain(".app/");
    }
    expect(existsSync(join(home, "hooks", "cursor-collect.cjs"))).toBe(true);
  });

  test("已有 writeFileChanges.sh 条目原样保留", async () => {
    writeFileSync(
      join(cursorDir, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          beforeSubmitPrompt: [],
          afterFileEdit: [{ command: "/Users/x/.cursor/hooks/writeFileChanges.sh" }],
        },
      }),
    );
    await installer.install();
    const hj = hooksJson();
    // 用户已有条目原样保留，本工具条目追加在后
    expect(hj.hooks.afterFileEdit[0]).toEqual({ command: "/Users/x/.cursor/hooks/writeFileChanges.sh" });
    expect(hj.hooks.afterFileEdit.length).toBe(2);
    expect(hj.hooks.beforeSubmitPrompt.length).toBe(1);
  });

  test("按事件子集安装：排除的事件移除本工具条目，status 按子集判定", async () => {
    await installer.install(); // 全量安装
    const subset = HOOK_EVENTS.filter((e) => e !== "beforeReadFile");
    await installer.install(subset); // 关闭快速变绿开关
    const hj = hooksJson();
    expect(hj.hooks.beforeReadFile ?? []).toEqual([]);
    expect(hj.hooks.afterFileEdit.length).toBe(1);
    expect((await installer.status(subset)).installed).toBe(true);
    expect((await installer.status()).installed).toBe(false); // 全量视角缺 beforeReadFile
  });

  test("安装前创建备份文件", async () => {
    writeFileSync(join(cursorDir, "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
    await installer.install();
    const backups = readdirSync(cursorDir).filter((f) => f.startsWith("hooks.json.bak"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  test("重复安装幂等：不产生重复条目", async () => {
    await installer.install();
    await installer.install();
    const hj = hooksJson();
    for (const ev of HOOK_EVENTS) expect(hj.hooks[ev].length, ev).toBe(1);
  });

  test("卸载：仅移除本工具条目", async () => {
    writeFileSync(
      join(cursorDir, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: { afterFileEdit: [{ command: "/Users/x/.cursor/hooks/writeFileChanges.sh" }] },
      }),
    );
    await installer.install();
    await installer.uninstall();
    const hj = hooksJson();
    expect(hj.hooks.afterFileEdit).toEqual([{ command: "/Users/x/.cursor/hooks/writeFileChanges.sh" }]);
    for (const ev of HOOK_EVENTS) {
      if (ev === "afterFileEdit") continue; // 上面已断言：仅剩用户自己的条目
      expect(hj.hooks[ev] ?? []).toEqual([]);
    }
  });

  test("命令中脚本路径带引号（home 含空格不被 shell 拆分）", async () => {
    await installer.install();
    const hj = hooksJson();
    expect(hj.hooks.stop[0].command).toBe(`node "${join(home, "hooks", "cursor-collect.cjs")}"`);
  });

  test("卸载幂等：hooks.json 与目录不存在时不抛错、不新建文件", async () => {
    await expect(installer.uninstall()).resolves.toBeUndefined();
    expect(existsSync(join(cursorDir, "hooks.json"))).toBe(false);
  });

  test("status：未安装 → installed=false；安装后 → true", async () => {
    expect((await installer.status()).installed).toBe(false);
    await installer.install();
    expect((await installer.status()).installed).toBe(true);
  });

  test("status：条目被外部删除后检出损坏", async () => {
    await installer.install();
    const hj = hooksJson();
    hj.hooks.stop = [];
    writeFileSync(join(cursorDir, "hooks.json"), JSON.stringify(hj));
    const st = await installer.status();
    expect(st.installed).toBe(false);
    expect(st.detail).toBeTruthy();
  });

  test("脚本内容过期时 ensureFresh 自动刷新", async () => {
    await installer.install();
    const scriptPath = join(home, "hooks", "cursor-collect.cjs");
    writeFileSync(scriptPath, "// stale version");
    await installer.ensureFresh();
    expect(readFileSync(scriptPath, "utf-8")).not.toBe("// stale version");
  });
});
