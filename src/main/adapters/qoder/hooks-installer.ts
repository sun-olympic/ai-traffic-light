import { promises as fs } from "node:fs";
import path from "node:path";

export const QODER_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
  "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd",
] as const;

const SCRIPT_NAME = "qoder-collect.cjs";
const BUNDLED_SCRIPT = path.resolve(__dirname, "../../../../hook-scripts", SCRIPT_NAME);

interface HookEntry { type?: unknown; command?: unknown; [key: string]: unknown }
interface HookGroup { hooks?: HookEntry[]; [key: string]: unknown }
interface SettingsFile { hooks?: Record<string, HookGroup[]>; [key: string]: unknown }

export interface QoderHooksInstallerOptions {
  qoderDir: string;
  appHome: string;
  scriptSource?: string;
}

export class QoderHooksInstaller {
  private readonly qoderDir: string;
  private readonly appHome: string;
  private readonly scriptSource: string;

  constructor(opts: QoderHooksInstallerOptions) {
    this.qoderDir = opts.qoderDir;
    this.appHome = opts.appHome;
    this.scriptSource = opts.scriptSource ?? BUNDLED_SCRIPT;
  }

  private get settingsPath(): string { return path.join(this.qoderDir, "settings.json"); }
  private get scriptPath(): string { return path.join(this.appHome, "hooks", SCRIPT_NAME); }
  private command(): string { return `node "${this.scriptPath}"`; }

  private async readSettings(): Promise<SettingsFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.settingsPath, "utf8")) as SettingsFile;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid Qoder settings.json");
      return { ...parsed, hooks: parsed.hooks ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hooks: {} };
      throw error;
    }
  }

  private isOurHook(hook: HookEntry): boolean {
    return hook.command === this.command();
  }

  private isOurs(group: HookGroup): boolean {
    return (group.hooks ?? []).some((hook) => this.isOurHook(hook));
  }

  private async copyScript(): Promise<void> {
    await fs.mkdir(path.dirname(this.scriptPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(this.scriptSource, this.scriptPath);
    await fs.chmod(this.scriptPath, 0o700);
  }

  async install(): Promise<void> {
    const settings = await this.readSettings();
    let changed = false;
    for (const event of QODER_HOOK_EVENTS) {
      const groups = settings.hooks![event] ?? [];
      if (!groups.some((group) => this.isOurs(group))) {
        groups.push({ hooks: [{ type: "command", command: this.command(), name: "ai-traffic-light", timeout: 5, async: true }] });
        settings.hooks![event] = groups;
        changed = true;
      }
    }
    await this.copyScript();
    if (!changed) return;
    try { await fs.copyFile(this.settingsPath, `${this.settingsPath}.bak-${Date.now()}`); } catch { /* first installation */ }
    await fs.mkdir(this.qoderDir, { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  }

  async uninstall(): Promise<void> {
    try {
      await fs.access(this.settingsPath);
      const settings = await this.readSettings();
      for (const event of Object.keys(settings.hooks ?? {})) {
        settings.hooks![event] = (settings.hooks![event] ?? []).flatMap((group) => {
          if (!this.isOurs(group)) return [group];
          const hooks = group.hooks!.filter((hook) => !this.isOurHook(hook));
          return hooks.length ? [{ ...group, hooks }] : [];
        });
        if (settings.hooks![event].length === 0) delete settings.hooks![event];
      }
      await fs.writeFile(this.settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rm(this.scriptPath, { force: true });
  }

  async status(): Promise<{ installed: boolean; detail?: string }> {
    const settings = await this.readSettings();
    const missing = QODER_HOOK_EVENTS.filter((event) => !(settings.hooks?.[event] ?? []).some((group) => this.isOurs(group)));
    if (missing.length) return { installed: false, detail: `缺失事件条目: ${missing.join(", ")}` };
    try { await fs.access(this.scriptPath); } catch { return { installed: false, detail: "采集脚本缺失" }; }
    return { installed: true };
  }

  /** 曾经安装过（采集脚本存在）：显式卸载会删脚本，所以卸载后重启不会被写回；升级时据此补齐新增事件条目 */
  async everInstalled(): Promise<boolean> {
    try {
      await fs.access(this.scriptPath);
      return true;
    } catch {
      return false;
    }
  }

  async ensureFresh(): Promise<void> {
    const expected = await fs.readFile(this.scriptSource, "utf8");
    let installed = "";
    try { installed = await fs.readFile(this.scriptPath, "utf8"); } catch { /* missing */ }
    if (installed !== expected) await this.copyScript();
  }
}
