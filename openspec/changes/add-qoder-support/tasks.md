## 1. Shared Session Model

- [x] 1.1 Add `user_action_required` to the shared event schema while preserving replay support for v1 and v2 events
- [x] 1.2 Add `user_action` to the session waiting-kind model as an exact, non-ignorable waiting state
- [x] 1.3 Route `user_action_required` events through the session machine into `waiting/user_action`
- [x] 1.4 Add user-facing labels and notification-safe wording for `user_action` in Chinese and English
- [x] 1.5 Add regression tests for event parsing, adapter validation, state transitions, and view-model labels

## 2. Qoder State Readers

- [x] 2.1 Add Qoder default path resolution for macOS local storage and mark other platforms unsupported or not detected for the first version
- [x] 2.2 Implement a read-only Qoder snapshot reader for `ItemTable.aicoding.questTaskListSnapshot`
- [x] 2.3 Implement Qoder status normalization for running, action required, completed, stopped/cancelled, error, and unknown statuses
- [x] 2.4 Implement Qoder canonical session id and alias matching using `executionSessionId` and task id fallbacks
- [x] 2.5 Implement privacy-safe Qoder metadata extraction without persisting `query`, prompt-like titles, transcript text, or AI-modified content
- [x] 2.6 Add unit tests with sanitized fixtures for snapshot parsing, status mapping, alias deduplication, and missing/schema-mismatched storage

## 3. Qoder Tracking Pipeline

- [x] 3.1 Add a Qoder watcher/poller that diffs snapshot state and emits normalized events only on state changes
- [x] 3.2 Establish a startup baseline so historical Qoder error and action-required tasks do not trigger fresh repeated notifications
- [x] 3.3 Register Qoder with `yellow: "exact"`, `yellowPush: true`, `red: "exact"`, metadata enabled, and aborted/stopped not red
- [x] 3.4 Add Qoder liveness matching and stale-running handling so unchanged running/action-required tasks stop when Qoder has exited
- [x] 3.5 Integrate optional Qoder transcript lookup for trailing-question detection on newly observed completed tasks
- [x] 3.6 Ensure `ai_tracker` changes never resurrect terminal Qoder sessions as running by themselves

## 4. UI and Health

- [x] 4.1 Show Qoder as `Qoder` in detail rows and aggregate counts
- [x] 4.2 Add settings health output for Qoder not detected, OK, and degraded states
- [x] 4.3 Keep Qoder not detected neutral so Cursor/Codex-only users do not see a warning
- [x] 4.4 Use safe Qoder notification names such as `Qoder task <short-id>` unless a future explicit setting allows prompt-like titles
- [x] 4.5 Add UI/view-model tests for Qoder rows, `user_action` copy, and neutral/degraded health data

## 5. Verification

- [x] 5.1 Add tests for Qoder cold-start baseline behavior, including historical error and historical action-required sessions
- [x] 5.2 Add tests for Qoder state transitions: running to user action, running to completed, running to stopped, and running to error
- [x] 5.3 Add tests that unchanged Qoder action-required polls do not produce repeated notifications
- [x] 5.4 Add privacy assertions that Qoder-derived persisted events exclude prompt text, transcript text, `aiModifiedContent`, and file diff content
- [x] 5.5 Add tests that Cursor and Codex behavior remains unchanged after the shared event/state extension
- [x] 5.6 Run the full test suite, TypeScript build, and `openspec validate add-qoder-support`
- [x] 5.7 Perform a manual Qoder smoke test covering not detected, running, action required, completed, stopped, error, and event-log privacy
  - 真实环境：冷启动基线（本机历史 Stopped/Completed 任务静默）、事件日志隐私（events.jsonl 零 qoder 事件）、设置页三态健康、running 绿灯实时出现（用户实测）、Stopped 灭灯实时验证（用户实测：配额耗尽的 Stopped 与手动停止在快照中无差异，按规格不红）
  - 沙箱快照（TL_QODER_DB 指向合成库，不碰真实数据）：Running→ActionRequired 黄灯（等待用户操作）、ActionRequired→Running 清黄回绿、Running→Error 红灯（已中断 + 知悉按钮）全部实时验证通过
- [x] 5.8 Document any remaining Qoder schema unknowns or follow-up spikes discovered during implementation
