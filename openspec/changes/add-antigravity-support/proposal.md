## Why

AI Traffic Light already tracks Cursor, Codex, and Qoder, but Antigravity agent trajectories are invisible to the traffic-light view. Antigravity exposes user-visible agent work as local read-only stores under `~/.gemini/antigravity` (SQLite conversation stores plus summary/transcript side channels), so the app can support Antigravity without hooks, without calling its local API, and without collecting prompt or code content.

## What Changes

- Add Antigravity as a first-class tracked AI tool alongside Cursor, Codex, and Qoder.
- Discover recent Antigravity trajectories from `conversations/*.db` (bounded, mtime-based) and read structural step state read-only with a lock-safe SQLite open strategy (immutable read or snapshot copy when WAL exists).
- Map `CortexStepStatus` structural evidence to traffic-light states: active statuses to running, current structural waiting to exact yellow (`user_action`), non-cancel structural terminal errors to exact red, cancelled to aborted (not red).
- Keep Antigravity-derived events memory-only (never persisted to `events.jsonl`), with startup baseline, episode tracking for reused conversation ids, store-epoch detection, and stable terminal timestamps so restarts do not resurrect acknowledged alerts.
- Add Antigravity-specific bounded transcript tail parsing for trailing-question detection after structural completion, bypassing the generic transcript reader.
- Add Antigravity process liveness, multi-state health reporting (not detected / ok / store unreadable / schema mismatch / permission denied / degraded), and privacy-safe display names (`Antigravity <short-id>`).
- Keep Cursor, Codex, and Qoder behavior unchanged.

## Capabilities

### New Capabilities

- `antigravity-session-tracking`: Tracks Antigravity agent trajectories from local read-only stores, maps structural step/trajectory state to traffic-light states, prevents false alerts across restarts/episodes/schema drift, exposes safe metadata, and reports collector health.

### Modified Capabilities

- None. The shared `ai-session-state` capability (generic `user_action_required` event, exact `user_action` waiting kind, `yellowPush` capability) introduced by add-qoder-support already covers everything Antigravity needs at the shared level.

## Impact

- Main process: new `src/main/adapters/antigravity/` modules (store locator, DB reader, status mapping, snapshot reader, poller, transcript tail), process-liveness patterns, adapter registry/probe wiring, startup baseline, health IPC.
- Renderer/shared: `Antigravity` tool display name, settings-page health section copy.
- Tests: sanitized SQLite fixtures for status mapping, waiting/terminal/cancel-guard scenarios, baseline/episode/epoch behavior, degraded-read preservation, privacy assertions, and regression coverage that Cursor/Codex/Qoder stay unchanged.
- No new external services, no Antigravity hooks, no writes to Antigravity files.
