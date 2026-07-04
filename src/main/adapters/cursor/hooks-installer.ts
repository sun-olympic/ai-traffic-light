// hooks.json 合并式安装/卸载（design.md D4）：
// - 只追加/移除自己的条目（按 command 指向 appHome/hooks/ 识别），不触碰用户已有钩子；
// - 采集脚本复制到稳定路径 ~/.ai-traffic-light/hooks/（绝不指向 .app 包内部）；
// - 安装前备份；启动时 ensureFresh 校验脚本内容并自动刷新。
import { promises as fs } from "node:fs";
import path from "node:path";

export const HOOK_EVENTS = [
  "beforeSubmitPrompt",
  "stop",
  "sessionStart",
  "sessionEnd",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "afterFileEdit",
  "beforeReadFile",
] as const;

const SCRIPT_NAME = "cursor-collect.cjs";
// 打包后脚本随 app 资源分发，源码运行时取仓库根的 hook-scripts/
const BUNDLED_SCRIPT = path.resolve(__dirname, "../../../../hook-scripts", SCRIPT_NAME);

interface HookEntry {
  command: string;
  [k: string]: unknown;
}

interface HooksFile {
  version: number;
  hooks: Record<string, HookEntry[]>;
}

export interface HooksInstallerOptions {
  appHome: string;
  cursorDir: string;
  /** 采集脚本源文件路径（测试注入用），默认取随包分发的脚本 */
  scriptSource?: string;
}

export class HooksInstaller {
  private readonly appHome: string;
  private readonly cursorDir: string;
  private readonly scriptSource: string;

  constructor(opts: HooksInstallerOptions) {
    this.appHome = opts.appHome;
    this.cursorDir = opts.cursorDir;
    this.scriptSource = opts.scriptSource ?? BUNDLED_SCRIPT;
  }

  private get hooksJsonPath(): string {
    return path.join(this.cursorDir, "hooks.json");
  }

  private get installedScriptPath(): string {
    return path.join(this.appHome, "hooks", SCRIPT_NAME);
  }

  private get command(): string {
    // 路径加引号：home 目录含空格（如 /Users/First Last）时 shell 不会拆分脚本路径
    return `node "${this.installedScriptPath}"`;
  }

  private isOurs(entry: HookEntry): boolean {
    return typeof entry.command === "string" && entry.command.includes(path.join(this.appHome, "hooks"));
  }

  private async readHooksFile(): Promise<HooksFile> {
    try {
      const raw = await fs.readFile(this.hooksJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<HooksFile>;
      return { version: parsed.version ?? 1, hooks: parsed.hooks ?? {} };
    } catch {
      return { version: 1, hooks: {} };
    }
  }

  private async copyScript(): Promise<void> {
    await fs.mkdir(path.dirname(this.installedScriptPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(this.scriptSource, this.installedScriptPath);
    await fs.chmod(this.installedScriptPath, 0o700);
  }

  /** 安装/同步：events 内的事件确保有本工具条目，HOOK_EVENTS 中不在 events 的移除（配置关闭的信号源） */
  async install(events: readonly string[] = HOOK_EVENTS): Promise<void> {
    await this.copyScript();
    const file = await this.readHooksFile();
    // 备份仅在原文件存在时有意义
    try {
      await fs.copyFile(this.hooksJsonPath, `${this.hooksJsonPath}.bak-${Date.now()}`);
    } catch {
      /* 原文件不存在，无需备份 */
    }
    for (const ev of HOOK_EVENTS) {
      const entries = (file.hooks[ev] ?? []).filter((e) => !this.isOurs(e));
      if (events.includes(ev)) entries.push({ command: this.command });
      file.hooks[ev] = entries;
    }
    await fs.mkdir(this.cursorDir, { recursive: true });
    await fs.writeFile(this.hooksJsonPath, JSON.stringify(file, null, 2) + "\n");
  }

  async uninstall(): Promise<void> {
    // 幂等：hooks.json 不存在（未装过工具/目录被删）时跳过改写，不新建文件也不 reject
    const exists = await fs.access(this.hooksJsonPath).then(() => true, () => false);
    if (exists) {
      const file = await this.readHooksFile();
      for (const ev of Object.keys(file.hooks)) {
        file.hooks[ev] = (file.hooks[ev] ?? []).filter((e) => !this.isOurs(e));
      }
      await fs.writeFile(this.hooksJsonPath, JSON.stringify(file, null, 2) + "\n");
    }
    await fs.rm(path.dirname(this.installedScriptPath), { recursive: true, force: true });
  }

  async status(events: readonly string[] = HOOK_EVENTS): Promise<{ installed: boolean; detail?: string }> {
    const file = await this.readHooksFile();
    const missing = events.filter((ev) => !(file.hooks[ev] ?? []).some((e) => this.isOurs(e)));
    if (missing.length > 0) return { installed: false, detail: `缺失事件条目: ${missing.join(", ")}` };
    try {
      await fs.access(this.installedScriptPath);
    } catch {
      return { installed: false, detail: "采集脚本缺失" };
    }
    return { installed: true };
  }

  /** 曾经安装过（采集脚本存在）：用于升级时自动补齐新增 hook 条目 */
  async everInstalled(): Promise<boolean> {
    try {
      await fs.access(this.installedScriptPath);
      return true;
    } catch {
      return false;
    }
  }

  /** 启动校验：脚本缺失或内容与当前版本不符时自动刷新（含 App 升级场景） */
  async ensureFresh(): Promise<void> {
    const want = await fs.readFile(this.scriptSource, "utf-8");
    let got = "";
    try {
      got = await fs.readFile(this.installedScriptPath, "utf-8");
    } catch {
      /* 缺失视为过期 */
    }
    if (got !== want) await this.copyScript();
  }
}
