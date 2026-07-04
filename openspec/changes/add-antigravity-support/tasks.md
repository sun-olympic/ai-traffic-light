## 1. Store Discovery (single responsibility: locate stores, no parsing)

- [x] 1.1 Add `store-locator`: default macOS Antigravity home, `TL_ANTIGRAVITY_HOME` env override, non-darwin returns null (not detected)
- [x] 1.2 Add bounded candidate discovery: recent `conversations/*.db` by max(db/-wal/-shm mtime), capped count, lstat-based symlink/non-regular filtering, canonical session id = file basename

## 2. DB Reading (single responsibility: lock-safe SQLite access, raw rows out)

- [x] 2.1 Add `db-reader`: read-only open strategy (immutable read when no WAL sidecar; bounded snapshot copy of db+wal+shm when WAL exists), prompt close, serialized one-DB-at-a-time reads
- [x] 2.2 Add schema guard: required table/columns check (`steps`: `idx`, `step_type`, `status`, `error_details`), missing schema → `schema_mismatch`, read/open failure → degraded with per-file backoff, permission errors distinguished

## 3. State Mapping (single responsibility: pure structural interpretation)

- [ ] 3.1 Add `status-map`: `CortexStepStatus` numeric map (active/waiting/terminal/unknown classes), reserved value 10 and `INTERRUPTED`-without-context as unknown, cancel-guard pattern list for `error_details`
- [ ] 3.2 Add `derive-state`: pure function from step rows → per-session observation (waiting evidence > active > last-row terminal with cancel guard > unknown), carrying max idx, evidence idx, and source mtime

## 4. Poller Pipeline (single responsibility: diff + episodes + events)

- [x] 4.1 Add `poller` baseline: first poll restores running, restores waiting only when source mtime is within the freshness window, silences historical terminals, memory-only events (never `events.jsonl`)
- [x] 4.2 Add diff/episode/epoch logic: high-water idx per session, newer user-visible progress after terminal starts a new episode, evidence at or below terminal idx is ignored, inode/idx-reset detected as new store epoch that re-baselines, terminal stop uses stable source-mtime timestamp
- [x] 4.3 Add probe snapshot sharing the poller's latest snapshot cache: fresh no-wait clears yellow, read failure/missing store returns null (preserve + degraded), terminal fuse via `ProbeSnapshot.terminal`

## 5. Transcript Tail (single responsibility: bounded trailing-question source)

- [x] 5.1 Add `transcript-tail`: locate `brain/<id>/.system_generated/logs/transcript*.jsonl`, bounded tail read, conservative last-assistant-text extraction (null when uncertain), used only after structural completion via `resolvedLastMessage`; stop events never carry `transcriptPath`

## 6. Wiring and UI

- [x] 6.1 Add Antigravity process patterns (app + language_server) to process-liveness and the liveness matcher table
- [x] 6.2 Register the antigravity adapter in `index.ts`: capability flags (`yellow/red exact`, `yellowPush`, `redIncludesAborted: false`), poll interval hookup, probe routing, startup baseline call, safe notification/display name `Antigravity <short-id>`
- [x] 6.3 Add Antigravity health to the health IPC, `global.d.ts`, settings page section, and zh/en copy; add `Antigravity` tool display name

## 7. Real-Usage Findings

- [x] 7.0.1 Add poller terminal quiet window (D39): terminal-looking observation with fresh store mtime is treated as running (baseline lights green, diff emits activity, no premature stop/red); terminal confirmed and stop emitted only after mtime quiescence; probe path downgraded consistently
- [x] 7.0.2 Panel displays interface-sourced session title (user decision, Qoder precedent): bounded read of `agyhub_summaries_proto.pb` id→title map with mtime cache; panel name = title, fallback safe name; notifications keep safe short-id name; title never persisted/logged

## 8. Verification

- [x] 7.1 Add privacy assertions: no antigravity events persisted to `events.jsonl`, notification names are safe, fixtures synthetic-only
- [x] 7.2 Run full test suite and TypeScript build; run `openspec validate add-antigravity-support`; confirm Cursor/Codex/Qoder regressions pass
  - 全量 411 测试通过（Cursor/Codex/Qoder 回归含内）；tsc 主/渲染进程构建通过；openspec validate 通过
  - 真机只读冒烟：本机 `~/.gemini/antigravity` 实库读取（仅输出 id/枚举/计数）
