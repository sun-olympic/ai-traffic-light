# AI Traffic Light（AI 会话红绿灯）

常驻桌面的红绿灯造型悬浮窗，实时显示本机 AI 工具（当前支持 Cursor、OpenAI Codex、Qoder、Antigravity、CodeBuddy、WorkBuddy）agent 会话状态：

- 🟢 运行中
- 🟡 等待确认（agent 提问 / 命令与 MCP 审批 / 结尾提问 / 疑似卡死 / 长时间无活动）
- 🔴 异常中断，或错过提问（提问未作答被自动处理 / 表单被界面重建意外关闭、作答丢失——红灯明细里显示具体原因，点圆环清除）
- ⚫ 无活动会话

## 原理

双通道混合探测：

1. **Cursor hooks**（`~/.cursor/hooks.json`，官方接口）：会话发现与 绿/灭/红 状态转移；`beforeReadFile`/`afterFileEdit` 作为活动信号，作答后 agent 一恢复读写文件即秒级变绿。采集脚本把标准化事件追加到 `~/.ai-traffic-light/events.jsonl`（只记事件类型，不落盘文件路径/内容/prompt 文本）；
2. **state.vscdb 定向只读轮询**（逆向接口）：黄灯精确判定——最新工具气泡 `additionalData.status="pending"` 即挂起等待（提问/审批），仅在会话运行且事件静默超 5s 时按会话定向查询（实测 11~40ms/次）。实测两个补偿规则：提问气泡建库早于弹窗展示约 2s（亮黄加 2s 确认期对齐弹窗）；作答后 `pending` 字段翻转严重滞后，但新气泡数秒内追加（ask 不再是最新气泡即判已作答，清黄）。

事件 schema 工具无关（带版本字段），后续接入 Claude Code 等只需新增 adapter。

### Codex 通道

1. **Codex hooks**（`~/.codex/hooks.json`，官方接口）：`SessionStart`/`UserPromptSubmit`/`PermissionRequest`/`PostToolUse`/`Stop` 五个事件；审批弹窗（`PermissionRequest`）即时亮精确黄灯；
2. **rollout 会话日志定向读取**（`~/.codex/sessions/**/*.jsonl`，逐行落盘）：`Stop` hook 不带终态，回读 rollout 尾部判定 完成/中断/错误 与结尾提问文本；中断（ESC）、API 错误、拒绝审批均**不触发** `Stop` hook，靠周期探针读 rollout 终态兜底清灯；
3. **状态库只读**（`~/.codex/state_*.sqlite`）：会话名、archived 过滤、背景线程宽限期过滤。

## 使用前准备（各工具配置）

六个工具的接入成本不同：**Cursor / Codex 需要安装 hooks**（Codex 还要一次人工信任），**Qoder / Antigravity / CodeBuddy / WorkBuddy 零配置**免安装。各通道状态都在 设置页 → 对应采集区块 实时显示。

**通用前提**：

- 系统已安装 Node.js 且 `node` 在 PATH 中——Cursor/Codex 的 hook 条目以 `node ~/.ai-traffic-light/hooks/*.cjs` 方式执行，找不到 node 时 hooks 通道静默失效（表现为设置页「最后收到事件：从未」）；Qoder/Antigravity 通道无此要求；
- 数据目录 `~/.ai-traffic-light/`（事件文件、配置、hook 脚本）由 App 自动创建，无需手工准备；
- macOS 首次打开需绕过 Gatekeeper（安装包未签名，见下文「打包与 Gatekeeper」）。

### Cursor

1. 首次运行 App 会引导安装 hooks；也可随时在 设置页 → 采集通道 点「安装 hooks」（合并式写入 `~/.cursor/hooks.json`，不覆盖已有条目，安装前自动备份）；
2. DB 通道（黄灯精确判定）零配置，App 自动只读 `state.vscdb`；
3. 确认接通：设置页显示「hooks 已安装」「DB 通道正常」，跑一个会话后「最后收到事件」出现时间即正常。

可选项：「快速变绿」开关对应 `beforeReadFile` 活动信号 hook（agent 每次读文件约 +70ms 开销），关闭可省开销，变绿改走文件编辑等其他信号。

### Codex

Codex 的 hooks 有安全审查机制，装完必须人工信任一次：

1. 前提：本机有 Codex CLI（PATH 里有 `codex`；没有时 App 自动回落桌面版内置二进制）；
2. 设置页 Codex 区块点「安装 hooks」（合并式写入 `~/.codex/hooks.json`，自动备份，不触碰 `config.toml`）；
3. **人工信任（必须）**：点「打开终端去信任」启动 Codex，输入 `/hooks` 审查并信任本工具的条目；
4. 重启 Codex（或新开会话）后生效，设置页显示「采集正常」。

若 `config.toml` 里有 `[features] hooks = false`，hooks 引擎整体关闭（设置页会明确提示），需删掉该行或改为 `true` 后重装信任。信任哈希锁的是 hooks.json 条目定义（本工具装后冻结），采集脚本内容升级不需要重新信任。

Codex 已知限制：

- **断流盲区**：`Stop` hook 只在正常完成时触发，中断/错误/拒绝审批的清灯依赖 rollout 探针（约一个探测周期的延迟）；
- **审批黄灯标注**：批准瞬间 Codex 不发任何事件，黄灯持续到命令执行完成（`PostToolUse`），明细里标注为「等待审批（或已批准执行中）」；
- **云端任务不支持**：只覆盖本机会话（rollout 落在本机才可探测）。

### Qoder

零配置：App 自动只读任务快照库（macOS `~/Library/Application Support/Qoder/User/globalStorage/state.vscdb`）与本地会话记录缓存（`~/.qoder/cache`）。未安装 Qoder 时设置页显示「未检测到」，无需处理。Windows 路径按 `%APPDATA%/Qoder` 惯例推测、未经真机验证。

### Antigravity

零配置、仅 macOS：App 自动发现并只读 `~/.gemini/antigravity/conversations/*.db`。非默认安装位置可用环境变量 `TL_ANTIGRAVITY_HOME` 覆盖。未安装时设置页显示「未检测到」。

### CodeBuddy

零配置：App 自动只读会话状态库（macOS `~/Library/Application Support/CodeBuddy CN/codebuddy-sessions.vscdb`）检测绿灯（`Working` → 运行中、`Completed` → 结束），并读取 `~/Library/Application Support/CodeBuddyExtension/Data/` 下的对话历史文件检测黄灯（AI 回复末尾是否在向用户提问）。未安装 CodeBuddy 时设置页显示「未检测到」。

### WorkBuddy

零配置：App 自动只读会话数据库（`~/.workbuddy/workbuddy.db`）和对话记录文件（`~/.workbuddy/projects/<workspace>/<session>.jsonl`）检测绿灯、黄灯。非默认安装位置可用环境变量 `TL_WORKBUDDY_HOME` 覆盖。未安装时设置页显示「未检测到」。

### 卸载

设置页一键移除各工具 hooks 条目（只删本工具的，不动用户已有钩子）+ 删除 `~/.ai-traffic-light/`。

## 开发

```bash
npm install        # 安装依赖
npm test           # 运行单测（vitest）
npm start          # 构建并启动
npm run dist       # macOS 打包（electron-builder）
npm run dist:win   # Windows 打包（nsis/zip；需在 Windows 上执行或走 CI）
```

技术栈：Electron + TypeScript（主/渲染进程均为原生 TS，无前端框架）、Node 内置 `node:sqlite`（只读打开 Cursor DB，零原生依赖）、chokidar（事件文件监听）、vitest（单测）。

## 目录结构

```
src/
  main/       Electron 主进程（窗口、托盘、状态机、事件源 adapter）
  renderer/   渲染进程（悬浮窗 UI、明细面板、设置页）
  shared/     主/渲染共享的类型与常量（事件 schema、状态枚举）
scripts/      构建辅助脚本
```

## 打包与 Gatekeeper

`npm run dist` 产出 `release/ai-traffic-light-<版本>-mac-arm64.dmg`（文件名不含空格：GitHub 上传会把空格改成点，导致 electron-builder 查重失败重复建 Release）。为控制体积，打包只保留 en-US/zh-CN 两种 Electron 语言包并启用最大压缩（app 由 280M 降到 233M；余下体量主要是 Electron 运行时本身，属固有开销）。安装包**未签名/未公证**，首次打开 macOS 会拦截：

- 方式一：右键 App → 打开 → 再点「打开」；
- 方式二：`xattr -dr com.apple.quarantine "/Applications/AI Traffic Light.app"`。

## Windows 支持（实验性）

CI 会同时产出 Windows 安装包（`*.exe` nsis / `*-win.zip`）。Cursor、Codex 通道完整支持（DB 路径、hooks、进程检测已适配 `tasklist`）；Qoder 路径按 `%APPDATA%/Qoder` 惯例推测、未经真机验证；CodeBuddy 路径按 `%APPDATA%/CodeBuddy CN` 惯例推测；Antigravity / WorkBuddy 暂不支持 Windows（健康页显示未检测到）。安装包同样未签名，SmartScreen 首次运行需点「仍要运行」。
