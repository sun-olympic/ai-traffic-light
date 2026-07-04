## Context

AI Traffic Light currently ingests Cursor and Codex sessions through tool-specific adapters and routes normalized events through `SessionTracker`. Cursor combines hook events with Cursor's local database, while Codex combines hook events with rollout/session readers.

Qoder is also VS Code-derived, but local investigation shows it does not use Cursor's `cursorDiskKV` schema and no Qoder hook configuration has been found. Instead, Qoder persists agent tasks in `~/Library/Application Support/Qoder/User/globalStorage/state.vscdb`, table `ItemTable`, key `aicoding.questTaskListSnapshot`. That snapshot includes task identifiers, `executionSessionId`, workspace information, title/name, and task status. Qoder's bundled app normalizes statuses to `Running`, `ActionRequired`, `Completed`, `Stopped`, and `Error`; non-terminal active statuses are also mapped to those values internally.

The design therefore treats Qoder as a read-only local-state integration. It adds a generic `user_action` exact yellow state because Qoder's `ActionRequired` can mean several user interventions and is not necessarily command approval.

## Goals / Non-Goals

**Goals:**
- Track Qoder agent sessions as first-class AI Traffic Light sessions.
- Use Qoder's local task snapshot as the primary state source.
- Map Qoder running, waiting, completed, stopped, and error states into the shared traffic-light model.
- Prevent old Qoder tasks from triggering fresh alerts during app startup.
- Deduplicate Qoder task/session aliases into one visible session.
- Preserve privacy by not persisting Qoder prompt text, transcript text, or AI-modified code content.
- Surface Qoder collector health without marking Qoder absence as an error.

**Non-Goals:**
- Installing Qoder hooks or modifying Qoder configuration.
- Driving or automating the Qoder UI.
- Deep-linking from AI Traffic Light into Qoder tasks.
- Full support for remote/cloud Qoder transcripts in the first version.
- Treating `ai_tracker` as an authoritative live state source.

## Decisions

### D1. Use Qoder task snapshot as the primary source

Read `state.vscdb` in read-only mode and parse `ItemTable.aicoding.questTaskListSnapshot`.

Alternatives considered:
- Hooks: rejected because no stable Qoder hook file or contract has been discovered.
- Conversation JSONL mtime: rejected as the primary source because it cannot reliably distinguish running from completed.
- Logs: rejected as the primary source because logs include unrelated network/auth noise and are version-fragile.

### D2. Poll and diff snapshot state instead of appending hook events

Add a Qoder watcher/poller that periodically reads the snapshot, normalizes task state, and emits normalized events only when a canonical session changes state. Repeated reads of the same state MUST NOT produce repeated alerts.

The watcher keeps an in-memory baseline at startup. Existing historical `Completed`, `Stopped`, and `Error` tasks are restored only as quiet history where needed; only state transitions observed after baseline can generate new yellow/red alerts.

### D3. Add generic exact `user_action` waiting state

Qoder `ActionRequired` maps to a new exact waiting kind named `user_action`. It is non-ignorable, like question and approval waiting. UI text is "Waiting for user action" / "等待用户操作".

The event schema should add a `user_action_required` event. Because Qoder exact yellow is push/diff driven, Qoder's adapter capability declaration uses `yellow: "exact"` and `yellowPush: true`.

### D4. Normalize Qoder statuses conservatively

Status normalization:
- `Running`, `planning`, `running`, `in_progress`, `prompting`, `streaming` -> running
- `ActionRequired`, `suspended`, `action_required`, `actionrequired` -> user action required
- `Completed`, `complete`, `completed`, `end_turn` -> completed
- `Stopped`, `stop`, `stopped`, `cancelled`, `canceled` -> aborted/stopped
- `Error`, `error`, `failed`, `failure`, `error_aborted` -> error

Unknown statuses are not red by default. If Qoder is alive and the task has recent snapshot activity, treat unknown as running with degraded confidence; otherwise keep the session idle/unknown.

### D5. Canonicalize Qoder session identity

Use one canonical session id per task:
- Prefer `executionSessionId`.
- If absent, use `${task.id}.session.execution`.
- Compare aliases by stripping `.session.execution` and `.session.design`.
- Use the canonical id for UI rows, marks, notification de-duplication, and tracker keys.

This prevents the same task from appearing as both `task-...` and `task-....session.execution`.

### D6. Keep Qoder metadata privacy-safe

Qoder `title`, `name`, `query`, and `lingma.chat.localHistory.*.quest.title` can contain user prompt text. Events persisted to `~/.ai-traffic-light/events.jsonl` MUST NOT contain those fields.

Metadata may be read on demand for local UI display, but notifications should use a safe fallback such as `Qoder task <short-id>` unless a future setting explicitly allows prompt-like names. `ai_tracker.aiModifiedContent`, conversation transcript text, and file diff content MUST NOT be stored in fixtures or app event logs.

### D7. Use transcript only for trailing-question detection

Qoder conversation files under `~/.qoder/cache/projects/**/conversation-history/**/*.jsonl` may be used to read the last assistant message when a newly observed task completes. The app should reuse the existing trailing-question heuristic when the format is compatible. Remote/cloud tasks without local transcripts simply skip trailing-question detection.

### D8. Treat tool liveness as a stale-running guard

If the snapshot still says running/action-required but Qoder is not alive and the snapshot has not changed recently, the session should stop with `unknown` and show the existing `tool_exited` note rather than staying green/yellow forever.

### D9. Health is tri-state, not install-required

Qoder health has at least these states:
- Not detected: neutral, no warning.
- Detected and snapshot readable: OK.
- Detected but DB/schema unreadable: degraded warning with retry.

SQLite open/query failures use the same degrade-and-retry posture as Cursor DB reading.

## Risks / Trade-offs

- [Snapshot lag or stale running state] -> Combine snapshot state with Qoder process liveness and snapshot update time.
- [Historical errors alert on startup] -> Establish a startup baseline and only alert on post-baseline state transitions.
- [Qoder schema drift] -> Keep parsing defensive, mark health degraded, and avoid affecting Cursor/Codex.
- [Prompt text leaks through metadata] -> Do not persist Qoder titles/queries in events and use safe notification labels.
- [Task disappears from snapshot] -> Do not assume completion; treat as removal only when deletion/tombstone evidence exists or after stale-session GC.
- [Remote/cloud tasks lack local transcript] -> Track snapshot state but skip transcript-dependent trailing-question detection.
- [Unknown status values] -> Never map unknown directly to red; prefer degraded running or idle based on liveness/activity.
- [Polling overhead] -> Poll only the small snapshot key and avoid scanning conversation/ai_tracker paths unless needed.

## Migration Plan

1. Extend the shared event/state model with `user_action_required` and `user_action`.
2. Add Qoder read-only readers, status normalization, and watcher baseline logic.
3. Register Qoder in main-process capability tables and liveness matching.
4. Add UI labels and settings health surface.
5. Add fixture-based tests and run existing Cursor/Codex regression tests.

Rollback is straightforward: disable Qoder registration/watcher. Existing Cursor/Codex event parsing remains backward-compatible with prior event schema versions.

## Verification Strategy

Automated verification should cover the core state model and Qoder snapshot reader with sanitized fixtures:
- Event parsing remains backward-compatible for v1/v2 Cursor and Codex logs and accepts the new `user_action_required` event.
- `user_action` behaves as an exact, non-ignorable waiting kind and clears on subsequent activity or stop events.
- Qoder status normalization maps running, action required, completed, stopped/cancelled, error, and unknown statuses as specified.
- Qoder startup baseline prevents historical error/action-required tasks from emitting fresh repeated alerts.
- Qoder canonical session id logic deduplicates task id, execution session id, and design/execution suffix aliases.
- Qoder privacy tests assert persisted events and fixtures exclude `query`, prompt-like `title`, transcript text, `aiModifiedContent`, and file diff content.
- Cursor and Codex regression tests continue to pass after the shared event/state changes.

Manual smoke verification should be performed on a machine with Qoder installed:
1. Start AI Traffic Light with Qoder closed and confirm settings health shows Qoder as neutral/not detected or inactive, not as an error.
2. Start Qoder and run a small local agent task; confirm the session becomes green while the snapshot reports running.
3. Put or observe a Qoder task in `ActionRequired`; confirm exactly one yellow notification appears and repeated polling does not notify again while the state is unchanged.
4. Complete the task; confirm the green/yellow session clears, and a trailing-question completion becomes soft yellow when a readable local transcript ends with a question.
5. Stop/cancel a task; confirm it does not become red.
6. Observe or fixture an error transition after startup baseline; confirm it becomes red.
7. Inspect `~/.ai-traffic-light/events.jsonl` and confirm Qoder-derived events contain only safe metadata, not prompt text or AI-modified code content.

Release verification consists of `openspec validate add-qoder-support`, the full unit test suite, TypeScript build, and the Qoder smoke checklist above.

## Open Questions

- Whether Qoder writes a stable deleted-task tombstone key in the user storage that should be used for precise session removal.
- Whether future versions expose `acpStream.state` in a stable persisted location; if so, it can refine running vs user-action detection.
- Whether users want an opt-in setting to show prompt-like Qoder task titles in system notifications.

## Implementation Findings (2026-07-04 本机实样)

- 快照结构确认为 `{ version: 1, updatedAt, folders: { <workspacePath|__virtual__>: { updatedAt, tasks: [...] } } }`；`__virtual__` 目录任务无工作区（workspacePath 记 null）。
- 任务安全字段实测：`id`、`status`、`executionSessionId`（`<taskId>.session.execution` 形态）、`updatedAtTimestamp`、`createdAt`；隐私字段 `query`/`title`/`name`/`userRequirements` 确认存在于同一对象，读取器在解析层丢弃。
- Qoder 主进程 `ps comm` 为 `/Applications/Qoder.app/Contents/MacOS/Electron`（非 Qoder 命名），存活匹配用包路径前缀 `Qoder.app/Contents/MacOS/`。
- transcript 布局确认：`~/.qoder/cache/projects/<ws>-<hash>/conversation-history/<taskId 前 8 字符>/<同名>.jsonl`，行格式与既有 `lastAssistantText` 解析器兼容（`{role, message:{content:[{type:"text",text}]}}`）；项目目录 hash 算法未知，用目录遍历定位。
- `acpStream.state` 与删除 tombstone 在持久层未发现，两个 open question 维持。
- 实现选择：Qoder 事件不写 `events.jsonl`（隐私边界最彻底满足），冷启动状态由每次启动的快照基线重建，不依赖回放。
