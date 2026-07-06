# AI Traffic Light（AI 会话红绿灯）

常驻桌面的红绿灯造型悬浮窗，实时显示本机 AI 工具（当前支持 Cursor 与 OpenAI Codex）agent 会话状态：

- 🟢 运行中
- 🟡 等待确认（agent 提问 / 命令与 MCP 审批 / 结尾提问 / 疑似卡死 / 长时间无活动）
- 🔴 异常中断
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

## 接入 Codex（信任流程）

Codex 的 hooks 有安全审查机制，装完必须人工信任一次：

1. 设置页 Codex 区块点「安装 hooks」（合并式写入 `~/.codex/hooks.json`，自动备份，不触碰 `config.toml`）；
2. 点「打开终端去信任」启动 Codex，输入 `/hooks` 审查并信任本工具的条目；
3. 重启 Codex（或新开会话）后生效，设置页显示「采集正常」。

信任哈希锁的是 hooks.json 条目定义（本工具装后冻结），采集脚本内容升级不需要重新信任。

### Codex 已知限制

- **断流盲区**：`Stop` hook 只在正常完成时触发，中断/错误/拒绝审批的清灯依赖 rollout 探针（约一个探测周期的延迟）；
- **审批黄灯标注**：批准瞬间 Codex 不发任何事件，黄灯持续到命令执行完成（`PostToolUse`），明细里标注为「等待审批（或已批准执行中）」；
- **云端任务不支持**：只覆盖本机会话（rollout 落在本机才可探测）；
- 若 `config.toml` 有 `[features] hooks = false`，hooks 引擎整体关闭，设置页会明确提示。

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

CI 会同时产出 Windows 安装包（`*.exe` nsis / `*-win.zip`）。Cursor、Codex 通道完整支持（DB 路径、hooks、进程检测已适配 `tasklist`）；Qoder 路径按 `%APPDATA%/Qoder` 惯例推测、未经真机验证；Antigravity 暂不支持（健康页显示未检测到）。安装包同样未签名，SmartScreen 首次运行需点「仍要运行」。

## 安装 hooks

首次运行会引导安装（合并式写入 `~/.cursor/hooks.json`，不覆盖已有条目，安装前自动备份）；Codex 同理（`~/.codex/hooks.json`，另需一次信任，见上文）。卸载 = 设置页一键移除 hooks 条目 + 删除 `~/.ai-traffic-light/`。
