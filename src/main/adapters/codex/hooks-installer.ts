// Codex hooks.json 合并式安装/卸载（design.md D6）：
// - Codex 结构：hooks.<Event> = 组数组，每组 { matcher?, hooks: [{type,command,timeout}] }；本工具自成一组；
// - 条目定义装后冻结（command 路径、timeout 永不变）——信任哈希锁的是条目定义（spike 1.4），脚本内容可自由升级；
// - MUST NOT 写 config.toml（notify 被桌面版占用；[hooks.state] 是 Codex 的信任记账，代写=绕过安全审查）；
// - 信任态检测：只读解析 config.toml 的 [hooks.state."<hooks.json路径>:<snake_case事件>:<组序>:<条目序>"] 段。
import { promises as fs } from "node:fs";
import path from "node:path";

/** 安装的 hook 事件（PreToolUse 不装：spike 1.3 实证批准瞬间无重触发，装了无收益纯成本） */
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop"] as const;

/** hooks 同步执行且默认超时 600s：显式小超时防脚本卡死拖垮 Codex */
const HOOK_TIMEOUT_S = 5;
const SCRIPT_NAME = "codex-collect.cjs";
const BUNDLED_SCRIPT = path.resolve(__dirname, "../../../../hook-scripts", SCRIPT_NAME);

// 外部文件解析形状：字段宽容（用户手写/未来版本可能缺字段），isOurGroup 只认 command 字符串
interface HookCommand {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [k: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [k: string]: unknown;
}

type HooksMap = Record<string, HookGroup[]>;

interface HooksFile {
  hooks: HooksMap;
  [k: string]: unknown;
}

/** Codex 信任 key 的事件名口径：snake_case（实测 "…:pre_tool_use:0:0"） */
function snakeCase(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export interface CodexHooksInstallerOptions {
  appHome: string;
  codexDir: string;
  /** 采集脚本源文件路径（测试注入用），默认取随包分发的脚本 */
  scriptSource?: string;
}

export class CodexHooksInstaller {
  private readonly appHome: string;
  private readonly codexDir: string;
  private readonly scriptSource: string;

  constructor(opts: CodexHooksInstallerOptions) {
    this.appHome = opts.appHome;
    this.codexDir = opts.codexDir;
    this.scriptSource = opts.scriptSource ?? BUNDLED_SCRIPT;
  }

  private get hooksJsonPath(): string {
    return path.join(this.codexDir, "hooks.json");
  }

  private get configTomlPath(): string {
    return path.join(this.codexDir, "config.toml");
  }

  private get installedScriptPath(): string {
    return path.join(this.appHome, "hooks", SCRIPT_NAME);
  }

  private get command(): string {
    // 路径加引号：home 目录含空格时 shell 不会拆分脚本路径。
    // 已安装条目不受影响（install 幂等跳过既有组，条目定义冻结保信任哈希），仅新装生效
    return `node "${this.installedScriptPath}"`;
  }

  private isOurGroup(g: HookGroup): boolean {
    return (g.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(path.join(this.appHome, "hooks")));
  }

  private async readHooksFile(): Promise<HooksFile> {
    try {
      const raw = await fs.readFile(this.hooksJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<HooksFile>;
      return { ...parsed, hooks: parsed.hooks ?? {} };
    } catch {
      return { hooks: {} };
    }
  }

  private async copyScript(): Promise<void> {
    await fs.mkdir(path.dirname(this.installedScriptPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(this.scriptSource, this.installedScriptPath);
    await fs.chmod(this.installedScriptPath, 0o700);
  }

  /** 安装/同步：合并写入本工具条目，保留用户已有组；重复安装幂等（条目定义永不变） */
  async install(): Promise<void> {
    await this.copyScript();
    const file = await this.readHooksFile();
    let changed = false;
    for (const ev of CODEX_HOOK_EVENTS) {
      const groups = file.hooks[ev] ?? [];
      if (groups.some((g) => this.isOurGroup(g))) continue;
      groups.push({ hooks: [{ type: "command", command: this.command, timeout: HOOK_TIMEOUT_S }] });
      file.hooks[ev] = groups;
      changed = true;
    }
    if (!changed) return; // 幂等：文件字节不动，信任哈希无扰动
    try {
      await fs.copyFile(this.hooksJsonPath, `${this.hooksJsonPath}.bak-${Date.now()}`);
    } catch {
      /* 原文件不存在，无需备份 */
    }
    await fs.mkdir(this.codexDir, { recursive: true });
    await fs.writeFile(this.hooksJsonPath, JSON.stringify(file, null, 2) + "\n");
  }

  /** 卸载：按 command 路径精确移除本工具组，用户组保留；hooks.json 不存在时幂等跳过 */
  async uninstall(): Promise<void> {
    const exists = await fs.access(this.hooksJsonPath).then(() => true, () => false);
    if (exists) {
      const file = await this.readHooksFile();
      for (const ev of Object.keys(file.hooks)) {
        file.hooks[ev] = (file.hooks[ev] ?? []).filter((g) => !this.isOurGroup(g));
        if (file.hooks[ev].length === 0) delete file.hooks[ev];
      }
      await fs.writeFile(this.hooksJsonPath, JSON.stringify(file, null, 2) + "\n");
    }
    await fs.rm(path.dirname(this.installedScriptPath), { recursive: true, force: true });
  }

  async status(): Promise<{ installed: boolean; detail?: string }> {
    const file = await this.readHooksFile();
    const missing = CODEX_HOOK_EVENTS.filter((ev) => !(file.hooks[ev] ?? []).some((g) => this.isOurGroup(g)));
    if (missing.length > 0) return { installed: false, detail: `缺失事件条目: ${missing.join(", ")}` };
    try {
      await fs.access(this.installedScriptPath);
    } catch {
      return { installed: false, detail: "采集脚本缺失" };
    }
    return { installed: true };
  }

  async everInstalled(): Promise<boolean> {
    try {
      await fs.access(this.installedScriptPath);
      return true;
    } catch {
      return false;
    }
  }

  /** 启动校验：脚本缺失或内容与当前版本不符时自动刷新（脚本升级不破坏信任，spike 1.4） */
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

  /** hooks 引擎禁用检测：[features] 段的 hooks/codex_hooks = false（宽松行级解析，不引 TOML 依赖） */
  async hooksFeatureDisabled(): Promise<boolean> {
    let toml = "";
    try {
      toml = await fs.readFile(this.configTomlPath, "utf-8");
    } catch {
      return false;
    }
    let inFeatures = false;
    for (const line of toml.split("\n")) {
      const t = line.trim();
      if (t.startsWith("[")) {
        inFeatures = t === "[features]";
        continue;
      }
      if (inFeatures && /^(hooks|codex_hooks)\s*=\s*false\b/.test(t)) return true;
    }
    return false;
  }

  /** 本工具各事件条目在当前 hooks.json 中对应的信任 key（按实际组序计算，用户重排后口径仍正确） */
  expectedTrustKeys(hooks: HooksMap): string[] {
    const keys: string[] = [];
    for (const ev of CODEX_HOOK_EVENTS) {
      const groups = hooks[ev] ?? [];
      const gi = groups.findIndex((g) => this.isOurGroup(g));
      if (gi < 0) continue;
      const hi = groups[gi].hooks.findIndex((h) => typeof h.command === "string" && h.command.includes(path.join(this.appHome, "hooks")));
      keys.push(`${this.hooksJsonPath}:${snakeCase(ev)}:${gi}:${Math.max(hi, 0)}`);
    }
    return keys;
  }

  /** 信任态精确检测：只读 config.toml [hooks.state] 段，比对本工具条目 key 是否已有信任记账 */
  async trustStatus(): Promise<{ trusted: boolean; missing: string[] }> {
    const file = await this.readHooksFile();
    const expected = this.expectedTrustKeys(file.hooks);
    let toml = "";
    try {
      toml = await fs.readFile(this.configTomlPath, "utf-8");
    } catch {
      /* 无 config.toml = 无信任记账 */
    }
    const recorded = new Set<string>();
    for (const m of toml.matchAll(/^\[hooks\.state\."(.+)"\]\s*$/gm)) recorded.add(m[1]);
    const missing = expected.filter((k) => !recorded.has(k));
    return { trusted: expected.length > 0 && missing.length === 0, missing };
  }
}
