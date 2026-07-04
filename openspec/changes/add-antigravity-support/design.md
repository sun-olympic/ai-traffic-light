## Context

AI Traffic Light already tracks Cursor, Codex, and Qoder sessions through tool-specific adapters and a shared `SessionTracker`. Cursor and Codex use hooks plus local probes. Qoder uses a read-only local snapshot poller because it has no discovered hook contract.

Antigravity is also local-first from the user's perspective, but it is not a Cursor/Qoder clone. Local investigation shows an Electron shell backed by an Antigravity `language_server`. User-visible agent work is stored as "trajectories" under `~/.gemini/antigravity`, with a mix of summary protobuf files, per-trajectory conversation stores, brain artifacts, and transcripts.

Important observed sources:

- `/Applications/Antigravity.app/Contents/MacOS/Antigravity`: main app process.
- `/Applications/Antigravity.app/Contents/Resources/bin/language_server --override_ide_name antigravity`: backend process.
- `~/.gemini/antigravity/agyhub_summaries_proto.pb`: hub summary/index file containing many trajectory ids.
- `~/.gemini/antigravity/conversations/<id>.db`: new SQLite conversation store for recent trajectories.
- `~/.gemini/antigravity/conversations/<id>.pb`: older/historical conversation store format; currently not safely structure-decodable.
- `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript*.jsonl`: transcript/log side channel.
- `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`: VS Code-style storage with historical/auxiliary state; not reliable as the primary source for current sessions.

The design treats Antigravity as a read-only local-state integration. It must be conservative because most sources are internal implementation details and can drift across Antigravity releases.

## Goals / Non-Goals

**Goals:**

- Track user-visible Antigravity agent sessions as first-class AI Traffic Light sessions.
- Use local read-only stores; never modify Antigravity config, databases, logs, or artifacts.
- Prefer exact yellow/red only when supported by structural state.
- Preserve privacy by not persisting prompts, message content, tool arguments, code diffs, or artifact text.
- Handle schema drift, SQLite lock/read failures, missing local detail files, app/backend restarts, and historical data without false alerts.
- Surface Antigravity health separately from Cursor/Codex/Qoder health.

**Non-Goals:**

- Installing Antigravity hooks.
- Calling Antigravity's local API as the primary session-state source.
- Driving or automating the Antigravity UI.
- Deep-linking into Antigravity trajectories.
- Exact state tracking for old `.pb` conversation stores until a stable structure is proven.
- Using Antigravity quota/model APIs; quota is a separate feature area.

## Data Flow

```text
Antigravity.app
  └─ language_server
       ├─ agyhub_summaries_proto.pb        candidate ids / hub summaries
       ├─ conversations/<id>.db            primary state for new local sessions
       ├─ conversations/<id>.pb            old/history format, conservative only
       └─ brain/<id>/.system_generated
            ├─ logs/transcript*.jsonl      trailing-question fallback only
            └─ messages/*.json             do not persist; privacy-sensitive

Antigravity poller
  ├─ discover recent candidate ids
  ├─ read one session store at a time
  ├─ diff high-water state in memory
  └─ emit normalized in-memory events/probe snapshots

SessionTracker
  ├─ activity -> running
  ├─ user_action_required/probe pending -> waiting(user_action)
  ├─ stop(completed/aborted/error) -> idle/failed per capability
  └─ probe=null -> degraded, preserve existing state
```

## Decisions

### D1. Use `.gemini/antigravity` as the primary source, not VS Code global storage

`~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` contains useful historical and UI synchronization state, but the latest validated session did not appear there as an authoritative current session. The current session did appear under `~/.gemini/antigravity/conversations/<id>.db` and `~/.gemini/antigravity/brain/<id>`.

Therefore the adapter MUST use `.gemini/antigravity` as the primary source. VS Code storage may be used only as a compatibility/fallback hint and MUST NOT be required for current-session tracking.

### D2. Treat `agyhub_summaries_proto.pb` as an index, not a state source

`agyhub_summaries_proto.pb` contains many ids, including ids without local conversation details. It can be used to discover candidate trajectories and metadata, but it cannot create a tracked session by itself.

If a summary id has no local `.db`, no safely parseable `.pb`, and no matching `brain/<id>` evidence, the adapter MUST classify it as untrackable history and MUST NOT emit session events.

### D3. Prefer conversation `.db` as the current-state source

Recent Antigravity trajectories may use SQLite conversation stores with tables such as:

- `trajectory_meta`
- `steps`
- `gen_metadata`
- `executor_metadata`
- `parent_references`
- `trajectory_metadata_blob`
- `battle_mode_infos`

The `steps` table exposes structural columns such as `idx`, `step_type`, `status`, `has_subtrajectory`, `error_details`, `permissions`, `task_details`, `render_info`, and `step_payload`.

Binary descriptor inspection confirms that `steps.status` is `exa.cortex_pb.CortexStepStatus` in Antigravity 2.2.1:

| Value | Name | Initial meaning |
|---:|---|---|
| 0 | `CORTEX_STEP_STATUS_UNSPECIFIED` | unknown/degraded |
| 1 | `CORTEX_STEP_STATUS_PENDING` | active/incomplete |
| 2 | `CORTEX_STEP_STATUS_RUNNING` | active/incomplete |
| 3 | `CORTEX_STEP_STATUS_DONE` | terminal success for that step |
| 4 | `CORTEX_STEP_STATUS_INVALID` | structural invalid/error candidate |
| 5 | `CORTEX_STEP_STATUS_CLEARED` | cleared/terminal, do not treat as active |
| 6 | `CORTEX_STEP_STATUS_CANCELED` | terminal aborted, not red |
| 7 | `CORTEX_STEP_STATUS_ERROR` | terminal error candidate |
| 8 | `CORTEX_STEP_STATUS_GENERATING` | active/incomplete |
| 9 | `CORTEX_STEP_STATUS_WAITING` | user-action candidate |
| 11 | `CORTEX_STEP_STATUS_QUEUED` | active/incomplete |
| 12 | `CORTEX_STEP_STATUS_INTERRUPTED` | interrupted; classify only with error/cancel context |

Value `10` appears to be reserved/deprecated around `CORTEX_STEP_STATUS_HALTED` in the embedded descriptor. It MUST be treated as unknown until a real fixture shows how Antigravity emits it.

Relevant step type ids confirmed in the same descriptor include `CODE_ACTION=5`, `VIEW_FILE=8`, `LIST_DIRECTORY=9`, `USER_INPUT=14`, `PLANNER_RESPONSE=15`, `ERROR_MESSAGE=17`, `RUN_COMMAND=21`, `CHECKPOINT=23`, `SEARCH_WEB=33`, `TASK_BOUNDARY=81`, `NOTIFY_USER=82`, `CODE_ACKNOWLEDGEMENT=83`, `CONVERSATION_HISTORY=98`, `SYSTEM_MESSAGE=101`, `GENERIC=132`, and `ASK_QUESTION=138`.

The poller should keep per-session high-water state (`max(idx)`, last observed terminal state, last readable timestamp) and only react to structural changes after startup baseline.

### D4. Canonical session identity is the conversation basename/cascade id

Observed `trajectory_meta` can contain both an internal `trajectory_id` and a `cascade_id`. The local conversation DB filename and `brain/<id>` directory use the externally visible id. In the validated sample, the file/brain id differed from `trajectory_meta.trajectory_id`.

The adapter MUST use the conversation file basename / brain directory id / cascade id as the canonical AI Traffic Light session id. Other ids from `trajectory_meta` are aliases only.

### D5. Old `.pb` conversation stores are historical unless proven parseable

The local installation contains many old `.pb` conversation files, some tens of MB. They do not currently decode as an obvious safe protobuf structure with available tooling. Exact state tracking for these files is therefore not part of the first implementation.

For `.pb` stores:

- If no stable parser exists, treat them as baseline history only.
- Do not emit exact yellow/red from string scanning.
- Do not read large `.pb` files during every poll.
- Revisit only after a dedicated parser spike proves structural state fields.

### D6. Poll and diff local state; do not append Antigravity events to `events.jsonl`

Like Qoder, Antigravity local state can include prompt-like titles, message text, tool call arguments, artifact review text, paths, and internal reasoning metadata. To minimize privacy risk, Antigravity-derived state transitions should be memory-direct into `SessionTracker` and should not be persisted to `~/.ai-traffic-light/events.jsonl`.

Cold-start state is rebuilt from the latest local snapshot each run. Historical terminal states are baselined without fresh notifications.

### D7. Exact yellow requires current structural waiting evidence

Antigravity 2.2.1 exposes user-attention candidates through structural fields such as:

- `TrajectoryUpdate.waiting_steps`
- `CascadeTrajectorySummary.waiting_steps`
- `latest_notify_user_step`
- `latest_task_boundary_step`
- `TaskDetails.requires_input_approval`
- `CortexStepNotifyUser.ask_for_user_feedback`
- `CortexStepNotifyUser.should_auto_proceed`
- `steps.status = CORTEX_STEP_STATUS_WAITING`
- current `TASK_BOUNDARY`, `NOTIFY_USER`, `CODE_ACKNOWLEDGEMENT`, or `ASK_QUESTION` step state

`BlockedOnUser` has NOT been confirmed as an Antigravity 2.2.1 field name. The design should use it only as a conceptual synonym in discussion, not as an implementation dependency.

Exact yellow is allowed only when the current active session state shows a user action is required. The preferred order is trajectory-level waiting evidence first (`waiting_steps` or run status), then current waiting step evidence, then narrowly-scoped current artifact/notify metadata. Historical step blobs MUST NOT produce yellow.

The adapter maps exact waiting to the existing `user_action` waiting kind, not `approval`, because Antigravity waiting may mean plan review, artifact review, continue/confirm, browser/tool permission, login, quota selection, or another intervention.

Historical `permissions` blobs on completed steps MUST NOT turn the session yellow.

### D8. Artifact review is not yellow unless structurally blocked

Antigravity often produces artifacts such as plans, tasks, and walkthroughs. A completed task with files to review should not automatically become yellow; otherwise every normal completion may look like user interruption.

Local samples show `RequestFeedback`, `UserFacing`, and artifact metadata inside a completed `CODE_ACTION` step payload while the step status is still `DONE` and later steps continue. Therefore artifact metadata alone is not enough for exact yellow.

Only current structural evidence such as `waiting_steps`, `CORTEX_STEP_STATUS_WAITING`, `requires_input_approval`, a current `NOTIFY_USER`/`TASK_BOUNDARY`/`CODE_ACKNOWLEDGEMENT` waiting step, or an equivalent trajectory-level waiting status should produce exact yellow. A final assistant message ending in a question may still produce existing soft trailing-question yellow.

If product semantics require "artifact awaiting review" to be yellow even when the step status is `DONE`, implementation must add a separate guarded rule: only the latest visible step, no later user/agent progress, artifact review policy requires review, and trajectory summary still marks waiting or not fully idle. Without those guards, this rule will create false yellow after normal artifact generation.

### D9. Transcript is a fallback, never the primary state source

Antigravity transcript lines include fields such as `type`, `status`, `source`, `step_index`, `created_at`, and `content`. The validated transcript still contained `RUNNING` entries after the conversation DB indicated completion. Therefore transcript `RUNNING` MUST NOT be interpreted as current running state.

Transcript use is limited to:

- last assistant text / trailing-question detection after a structural completion
- diagnostic metadata when the primary store is unavailable

Transcript content MUST NOT be persisted.

### D10. Red is structural terminal error with cancel guards

The adapter can declare `red: "exact"` only if it maps red from structural terminal error evidence. It MUST NOT map free-text status strings or logs directly to red.

Cancellation guard terms include at least:

- `context canceled`
- `context cancelled`
- `user canceled`
- `user cancelled`
- `cancelled by user`
- `canceled by user`
- `manage_task cancel`
- `aborted`

If terminal error details match cancellation/user-stop patterns, emit `stop(aborted)` with `redIncludesAborted=false`.

Non-cancel terminal errors may emit `stop(error)`. Unknown terminal forms should remain degraded/unknown rather than red.

### D11. Logs are health/debug evidence, not lamp-state evidence

Antigravity logs include many error-looking lines that do not equal session failure:

- updater/network errors
- background cache refresh failures
- model/tool output warnings that the agent can recover from
- "trajectory not found" races before a store is created
- local API/load failures unrelated to a tracked session

The adapter MUST NOT create red/yellow lamp states from log text. Logs may contribute to health diagnostics only.

### D12. SQLite reading must be serialized, read-only, and failure-preserving

Direct reads of active Antigravity DBs can fail with `unable to open database file`, and copied snapshots can still report `database is locked` if copied at an unlucky moment. Concurrent reads make this more likely.

Validated local behavior:

- `sqlite3 <db>` failed with `unable to open database file`.
- `file:<db>?mode=ro` also failed.
- `file:<db>?mode=ro&immutable=1` succeeded for the current no-WAL database.
- No `-wal`/`-shm` file existed in the validated current sample.

This is probably caused by SQLite locking/journal side effects under a read-only permission model, not by database corruption.

The reader MUST:

- read one Antigravity DB at a time
- open read-only with a strategy that works under read-only directory access
- use short timeouts
- close connections promptly
- retry with backoff
- preserve the previous session state on read failure
- return `probe=null` after repeated read failure so `SessionTracker` marks the Antigravity probe channel degraded

Preferred DB open strategy:

1. If no `-wal`/`-shm` exists, use `mode=ro&immutable=1` and treat it as a point-in-time immutable read.
2. If WAL/SHM exists, do not blindly use `immutable=1` because it can miss recent WAL state. Prefer a bounded snapshot copy of `db`, `db-wal`, and `db-shm` into a private temp directory, then open the copied DB read-only.
3. If snapshot copy fails or is inconsistent, preserve prior state and mark health degraded rather than guessing.

### D13. Task disappearance is not completion

A conversation file, brain directory, summary id, or task entry can disappear because of cleanup, migration, remote-only history, or store compaction. Disappearance alone MUST NOT be treated as `completed` or `error`.

If a tracked active session disappears:

- if Antigravity is not alive, allow existing liveness handling to produce `tool_exited`
- if Antigravity is alive, keep the last known state for a grace window and mark health/store as degraded
- if still missing after GC, let normal session GC remove it

### D14. Process health is multi-dimensional

Antigravity has at least two important process layers:

- app shell: `Antigravity.app/Contents/MacOS/Antigravity`
- backend: `Antigravity.app/Contents/Resources/bin/language_server`

The app can be alive while the backend is restarting or dead. Auto-updates can restart the backend and change local ports/tokens. The health model should expose at least:

- `not_detected`
- `app_alive_backend_alive_store_ok`
- `app_alive_backend_down`
- `store_missing`
- `store_unreadable`
- `schema_mismatch`
- `permission_denied`
- `degraded`

`isAlive()` for stale-running cleanup may use the app process. Health should also report backend availability separately.

### D15. Local API is not the primary source

The language server exposes dynamic localhost endpoints with CSRF tokens in process args. These are useful for quota or future explicit integrations, but session-state tracking should not depend on them because:

- ports/tokens change on restart/update
- local API shape is internal
- API calls increase security/privacy surface
- file stores already provide local state evidence

The adapter may inspect process args for health only, and MUST NOT persist CSRF tokens.

### D16. Background/implicit Antigravity work must be filtered

Antigravity has implicit/background stores such as `~/.gemini/antigravity/implicit` and daemon logs. These are not user-visible agent sessions and should not create lamp rows.

The poller should track only user-visible trajectories with conversation/brain evidence. Background cache, update, indexing, and implicit tasks are ignored unless future evidence shows they require user action.

### D17. Parent/subtrajectory handling must prevent duplicate rows

The SQLite schema includes `has_subtrajectory` and `parent_references`. The validated sample had no subtrajectories, but the design must reserve behavior:

- canonical row is the user-visible parent/cascade session
- subtrajectory activity can keep the parent running
- subtrajectory pending user action can make the parent yellow
- subtrajectory terminal error may make the parent red only when structural and non-cancel
- subtrajectory rows should not appear as duplicate UI sessions unless explicitly user-visible

### D18. Unknown state is a degraded condition, not a lamp state

Unknown status values, unknown step types, schema changes, unreadable blobs, partial writes, or conflicting sources MUST NOT be forced into running/yellow/red.

Default posture:

- preserve current state if already tracking
- mark Antigravity health degraded
- use inactive soft yellow only through existing `SessionTracker` timing, not through guessed Antigravity semantics

### D19. Aggregate lamp priority is a product decision

Current `SessionTracker.aggregate()` returns yellow before red when both waiting and failed sessions exist. Antigravity may increase the chance of mixed states because multiple trajectories can run in parallel.

This design does not change aggregate priority. If the desired product behavior is red-over-yellow, that should be a separate global design decision affecting all tools.

### D20. Startup baseline prevents historical alert floods

At startup:

- recent active sessions may be restored as visible running/waiting when supported by current structural state
- old terminal sessions do not emit fresh notifications
- stale waiting follows existing `expireStaleWaiting` behavior
- historical red is preserved only when the error is structurally reliable and still within the app's normal retention/ack model

The adapter must not scan all historical `.pb`/transcript files on startup.

### D21. Privacy boundaries are stricter than metadata convenience

The following Antigravity fields/content are privacy-sensitive and MUST NOT be persisted in events, health payloads, logs generated by AI Traffic Light, or test fixtures:

- prompt/task/message content
- tool call arguments
- artifact metadata such as `RequestFeedback`, `CodeContent`, `TargetFile`, and descriptions when paired with user content
- `thinkingSignature`
- `thinking`
- artifact text
- generated code/diffs
- full local file paths beyond safe workspace basename when used for notification
- workspace URIs
- repository remotes
- branch names
- CSRF tokens, OAuth tokens, project ids, or account identifiers
- process arguments containing local ports, tokens, account-specific endpoints, or experiment ids

Safe display defaults:

- notification name: `Antigravity <short-id>` or `<workspace-basename> · <short-id>`
- detail row may show local safe metadata only
- prompt-like task titles require a future explicit opt-in

### D22. Polling must be bounded

The local Antigravity directory can contain many files, including large `.pb` files and multi-MB transcripts. The poller must avoid expensive scans.

Observed stores include dozens of old `conversations/*.pb` files, one recent `.db`, many `implicit/*.pb` files, and transcript logs containing full tool arguments, permissions, diffs, artifact text, paths, and model thinking. Summary protobuf strings also contain prompt-like titles, workspace URIs, repository remotes, and branch names.

Bounded strategy:

- scan recent `conversations/*.db` by mtime, not every historical file
- keep a small active set plus recently updated candidates
- use per-session high-water `idx`
- read transcript tail only after structural completion
- apply backoff after read failures
- avoid parsing `.pb` history in the hot path
- never scan `implicit/*.pb` as user-visible sessions in the hot path
- never emit summary/transcript strings into debug output; only ids, counts, enum names, blob lengths, and sanitized basenames are allowed

### D23. Platform and install path are explicit constraints

Initial support is macOS because all validated paths and process patterns are macOS-specific. Other platforms should return neutral/not detected until investigated.

Install path assumptions should be configurable or pattern-based where practical. Antigravity may be installed outside `/Applications`, renamed, or upgraded in place.

### D24. Permission-denied and sandbox failures are health states

AI Traffic Light may lack permission to read `~/.gemini/antigravity` or process tables in some packaging or OS privacy configurations. Permission-denied must be reported as health degraded/permission denied, not as "no sessions" and not as a lamp state.

### D25. Time and sleep handling follows the shared tracker

Antigravity uses file mtimes, DB update times, and app clocks. The adapter should use the shared clock when emitting events and should rely on the existing tracker sleep/wake timer reset to avoid false inactive alerts after macOS sleep.

### D26. Use trajectory-level run status when available

Antigravity descriptors expose `CascadeRunStatus`:

| Value | Name | Initial meaning |
|---:|---|---|
| 0 | `CASCADE_RUN_STATUS_UNSPECIFIED` | unknown/degraded |
| 1 | `CASCADE_RUN_STATUS_IDLE` | idle/terminal candidate |
| 2 | `CASCADE_RUN_STATUS_RUNNING` | running |
| 3 | `CASCADE_RUN_STATUS_CANCELING` | cancel in progress |
| 4 | `CASCADE_RUN_STATUS_BUSY` | busy/running candidate |

`TrajectoryUpdate`, `AgentStateUpdate`, and `CascadeTrajectorySummary` include trajectory-level `status` plus `waiting_steps`, `fully_idle`, `killed`, `last_step_error`, and `last_step_type`. If these structures can be decoded from `.db` blobs or summary data without reading content fields, they are better top-level state evidence than inferring state from the last row in `steps`.

The implementation should not depend solely on the final step row. The latest row can be `SYSTEM_MESSAGE`, `CONVERSATION_HISTORY`, `GENERIC`, or an artifact-related `CODE_ACTION`, while the user-visible trajectory state is elsewhere.

### D27. Summary and transcript are privacy-heavy indexes

`agyhub_summaries_proto.pb` is attractive because it contains trajectory ids, summaries, workspaces, and status-like fields, but it also contains prompt-like titles, workspace URIs, repository remotes, and branch names. It may also include running task snapshots only when `IncludeRunningTaskSnapshots` is enabled.

Therefore:

- summary file may discover candidate ids and sanitized structural counters only
- summary text fields must not be displayed, logged, or persisted
- summary status must not override a readable `.db` detail store
- summary-only waiting should be exact yellow only after a parser proves it is structural and current
- absence of running snapshots must not imply idle

Transcript files are even more sensitive. They contain tool args, permissions, diffs, generated artifacts, paths, logs, and model thinking. Transcript is limited to in-memory tail-question heuristics after structural completion and must be skipped entirely for exact state when a structural store is readable.

### D28. Poll/probe coherence must prevent state flapping

AI Traffic Light has two Antigravity read paths:

- poller diff: emits memory-only `activity`, `user_action_required`, and `stop` events
- tracker probe: reads a snapshot later to confirm pending/terminal state or clear an existing waiting state

For Qoder, these paths read a single compact snapshot. For Antigravity, they may read different files at different moments. A stale probe can otherwise clear a fresh yellow, resurrect a terminal session, or turn a temporary DB read failure into a false idle state.

The adapter should therefore normalize every successful read into a single `AntigravitySnapshot` shape and cache the latest successful snapshot for a short bounded interval. Poll and probe should prefer the same snapshot generation when they run in the same tick.

Each per-session observation should include structural ordering fields:

- canonical session id
- store epoch/fingerprint
- max observed `steps.idx`
- max source mtime across `.db`, `-wal`, `-shm`, and relevant metadata
- last structural state and confidence
- waiting evidence index/time, if any
- terminal evidence index/time, if any
- snapshot read time

Clearing `waiting(user_action)` requires a successful, fresh structural read for the same store epoch. It MUST NOT be cleared by:

- unreadable DB / `probe=null`
- summary-only absence
- transcript-only absence
- a snapshot older than the waiting evidence
- a partial snapshot that skipped the session because of read limits
- schema mismatch or unknown status

If the reader cannot prove "no current wait" from a complete current snapshot, it should preserve the previous state and mark health degraded.

### D29. Conversation ids may span multiple episodes

Antigravity may reuse the same conversation/cascade id across multiple user turns. A terminal step in the same DB does not necessarily mean the user will never continue that trajectory.

The adapter should track a per-session episode boundary in memory:

- A new user-visible `USER_INPUT`, task boundary, or higher-index running step after a terminal state can start a new episode and emit `activity`.
- Late writes at or below the terminal evidence index MUST NOT resurrect a completed/failed episode.
- Terminal evidence should include the index/time it came from so later progress can be distinguished from delayed metadata writes.
- If `steps.idx` resets, the DB file is replaced, or schema migration rewrites the store, treat this as a new store epoch and baseline before emitting new terminal notifications.
- If Antigravity compacts old rows, losing prior indices is not completion or error; it is either a new epoch or degraded until enough structure is readable.

This matters for marks too: red acknowledgements and soft-yellow ignores are keyed by stop time. If the same Antigravity id starts a later episode, the old mark must not suppress the new episode.

### D30. Conflicting sources need explicit precedence

Antigravity exposes overlapping signals. The adapter must not let a weak source override a stronger source.

Precedence for exact state:

1. Decoded trajectory-level structures for the same canonical id and store epoch (`TrajectoryUpdate`, `AgentStateUpdate`, `CascadeTrajectorySummary`) when current.
2. Current `steps` structural state, ordered by `idx` and guarded by step type/status.
3. Summary protobuf structural fields only after a parser proves they are current and content-free.
4. Transcript tail only for soft trailing-question detection after structural completion.
5. Process/app/backend liveness only for health and stale cleanup.
6. Logs only for health/debug.

Conflict rules:

- Current structural waiting beats generic running/busy.
- A non-cancel structural terminal error beats stale waiting only when the terminal evidence is at or after the waiting evidence in the same store epoch.
- `DONE` on a step does not mean whole-trajectory completion unless trajectory-level state or terminal boundary agrees.
- Activity after waiting clears yellow only when the activity is structurally newer than the waiting evidence.
- Completion after waiting clears yellow only when it is structurally newer than the wait; otherwise preserve/degrade.
- Transcript `RUNNING` never overrides DB/trajectory terminal.
- Logs and process args never override session state.

### D31. Startup freshness must avoid resurrecting old waits

On application startup, the Antigravity poller should rebuild current state without creating a flood of old notifications.

Startup behavior should distinguish:

- fresh active/waiting sessions: app/backend alive and structural evidence is current enough to restore green/yellow
- old terminal sessions: baseline silently, no new red/yellow notification
- stale waiting sessions: do not emit exact yellow unless the trajectory is still structurally waiting and fresh
- unreadable sessions: preserve nothing new; health degraded only

Freshness should use a conservative combination of DB/WAL/SHM mtime, latest structural index/time if decoded, and app/backend liveness. Transcript mtime alone is not enough for exact freshness because transcripts can be appended by logging, migration, or delayed flush.

The exact freshness window is a product/config decision, but the first implementation should make it explicit and testable. It should also avoid scanning all history merely to decide freshness.

### D32. Metadata display is safer than Antigravity titles

Antigravity summaries and transcripts can contain prompt-like task titles, workspace URIs, repository remotes, branch names, artifact descriptions, and generated content. The metadata path is therefore higher-risk than the state path.

Default metadata rules:

- notification names use `Antigravity <short-id>` or `<workspace-basename> · <short-id>`
- panel display may use only sanitized, locally derived safe names by default
- prompt-like titles require an explicit future opt-in
- content hashes should not be used as identifiers because they can fingerprint private prompts or files
- debug output should use an allowlist: ids, enum names, counts, mtimes, blob byte lengths, schema fingerprints, and sanitized basenames

Panel titles (user-approved deviation from the original default): the user explicitly chose interface-sourced session titles for panel rows (Qoder precedent — same text the tool's own UI shows locally). Titles come from a bounded, mtime-cached read of the `agyhub_summaries_proto.pb` id→title map, fall back to the safe short-id name, are sanitized through the shared name sanitizer, and are never persisted, logged, or used in notifications.

### D33. Multi-install and multi-profile support must avoid id collisions

Initial support is macOS with the validated default home path, but implementation should not assume there is exactly one Antigravity installation forever.

Potential variants:

- app installed outside `/Applications`
- renamed app bundle
- beta/canary/stable channels installed side by side
- multiple user profiles or future workspace-specific Antigravity homes
- custom `GEMINI`/Antigravity home path in tests

The adapter should allow a config/env override for the Antigravity home. If multiple homes are supported later, canonical session ids must be namespaced by a stable home/channel fingerprint so two stores with the same cascade id do not collide in `SessionTracker`.

### D34. Schema drift should fail closed but recover automatically

Antigravity internals are not a public API. The reader should fingerprint the minimum schema it depends on:

- required table names
- required `steps` columns
- expected numeric enum ranges
- blob locations used by the structural parser
- Antigravity version if available without leaking process args

Unknown extra columns or enum values should not fail the whole reader. Missing required fields, unreadable blobs needed for exact state, or incompatible table layout should produce `schema_mismatch` / degraded and preserve prior state.

Version changes alone should not disable tracking. They should increase diagnostic detail and may trigger conservative parser behavior until the next successful structural read proves compatibility.

### D35. File-system and resource boundaries need hard caps

The Antigravity directory can contain large protobufs, large transcripts, many old conversations, and transient SQLite sidecars. The poller should be robust under size and churn.

Implementation constraints:

- do not follow symlinks when scanning Antigravity stores
- ignore non-regular files
- cap candidate count per poll
- cap bytes read from transcript tails
- cap blob decode size and skip oversized blobs
- close SQLite connections promptly
- avoid parallel SQLite reads against Antigravity stores
- back off per failing file, not globally
- include `-wal` and `-shm` mtimes when deciding whether a DB candidate changed
- handle APFS rename/replace by detecting inode/store fingerprint changes

Resource exhaustion should become health degraded, not a lamp state.

### D36. User-action taxonomy should stay generic in v1

Antigravity can wait for different kinds of user intervention: plan review, artifact review, continue/confirm, file/tool permission, browser/auth flow, quota/model selection, workspace trust, or an external terminal/action. The existing tracker only has one exact generic kind: `user_action`.

The first implementation should map all structurally proven Antigravity waits to `waiting(user_action)`. It should not label them as `approval` unless Antigravity exposes a stable command-approval contract equivalent to Codex/Cursor command approval.

If the UI later wants richer labels, the adapter should add non-persisted metadata such as `reason: "artifact_review" | "permission" | "continue" | "auth" | "quota" | "unknown"` only after each reason has structural evidence and privacy review.

### D37. Synthetic event timestamps must be stable

Antigravity events are memory-only, but they still interact with persistent tracker marks:

- red acknowledgements are keyed by tool, session id, and stop timestamp
- soft trailing-question ignores are keyed by tool, session id, and stop timestamp
- repeated waiting/failed notifications are deduped by state entry time

If the adapter emits a terminal `stop` using "current poll time" every time the app restarts, a previously acknowledged failure or ignored trailing question can reappear. Terminal events should therefore use the most stable structural evidence time available:

1. decoded terminal/update timestamp from trajectory data
2. DB/WAL source mtime associated with the terminal evidence
3. first-observed terminal time cached in memory for the current runtime

If no stable terminal time can be recovered after restart, startup should prefer silent baseline for terminal states instead of creating a fresh red/trailing-question episode.

The same caution applies to `activity`: because `SessionMachine` treats any activity as running and can revive a failed session, Antigravity must emit activity only for user-visible progress that is newer than the terminal/waiting evidence. Metadata writes, transcript flushes, summary rewrites, and debug log activity must not emit activity.

### D38. Antigravity transcript tail parsing must bypass the generic transcript reader

The shared tracker can read a transcript path for Cursor-style trailing-question detection, but Antigravity transcripts are a different, larger, and more privacy-sensitive format. Passing an Antigravity transcript path to the generic `readTranscript` path would risk full-file reads and incorrect parsing.

For Antigravity:

- do not put raw `transcriptPath` into emitted stop events
- after structural completion, the adapter may parse a bounded transcript tail in memory
- if a safe last assistant text is found, pass it as `resolvedLastMessage`
- if no safe tail can be parsed, pass `resolvedLastMessage: null` or omit it and accept idle without soft trailing-question yellow
- never use transcript tail parsing for exact running/waiting/error state

This mirrors the Codex resolver path conceptually, but the parsing and redaction rules must be Antigravity-specific.

### D39. Terminal confirmation requires write quiescence

Real-store validation (2.2.1) shows Antigravity persists a step row only when that step finishes: an actively running trajectory can show `steps` with every row `DONE` while the current step is not represented at all. Step-status-only inference therefore cannot distinguish "all done so far, still working" from "trajectory finished".

The poller MUST NOT confirm a terminal state (completed/aborted/error) while the conversation store is still being written. A terminal-looking observation whose source mtime is within a terminal quiet window (default 30s) is treated as `running`. Only after the store stays quiet beyond the window is the terminal state confirmed and `stop` emitted, using the store mtime as the stable terminal timestamp (consistent with D37).

Consequences:

- Active sessions with all-DONE steps light green through baseline/diff activity.
- Mid-trajectory `ERROR`/`CANCELED` rows that the agent recovers from do not flash red: before the quiet window elapses, newer step rows flip the evidence order back.
- Long tool steps (no DB writes beyond the window) may prematurely confirm completion and then revive as a new episode when the next row lands; this is an accepted v1 trade-off, and the window is an explicit constant.
- The probe path applies the same rule so a probe terminal fuse cannot clear a session the poller still considers running.

## State Mapping

| Evidence | Normalized event/probe | Lamp state | Confidence |
|---|---|---|---|
| Trajectory-level `CASCADE_RUN_STATUS_RUNNING` or `BUSY` | `activity` / `executing=true` | running | exact if decoded structurally |
| New/current `.db` with active structural progress after baseline | `activity` | running | exact |
| Current structural `waiting_steps` non-empty | `user_action_required` / `user_action_pending` | waiting/user_action | exact |
| Current step `status=WAITING` on `NOTIFY_USER`, `TASK_BOUNDARY`, `CODE_ACKNOWLEDGEMENT`, or `ASK_QUESTION` | `user_action_required` / `user_action_pending` | waiting/user_action | exact |
| Current `TaskDetails.requires_input_approval=true` on active/non-terminal step | `user_action_required` / `user_action_pending` | waiting/user_action | exact |
| Current `CortexStepNotifyUser.ask_for_user_feedback=true` with `should_auto_proceed=false` and trajectory waiting evidence | `user_action_required` / `user_action_pending` | waiting/user_action | exact |
| Current structural pending permission on active/non-terminal step | `user_action_required` / `user_action_pending` | waiting/user_action | exact |
| Historical `RequestFeedback` / artifact metadata on completed non-current step | none | unchanged | exact ignore |
| Historical `permissions` blob on completed step | none | unchanged | exact ignore |
| Artifact/review path without structural block | none or completed | idle/running per primary state | exact ignore |
| `steps.status` in `PENDING` / `RUNNING` / `GENERATING` / `QUEUED` | `activity` / `executing=true` | running | exact |
| Structural completed terminal | `stop(completed)` | idle | exact once verified |
| `steps.status=CANCELED` or trajectory `CANCELING` followed by canceled terminal | `stop(aborted)` | idle | exact |
| `steps.status=ERROR` or `INVALID` with non-cancel structural error | `stop(error)` | failed | exact |
| New user-visible progress after a prior terminal in the same DB | `activity` | running/new episode | exact if `idx`/epoch proves newer |
| Metadata-only rewrite after terminal/waiting | none | unchanged | ignored |
| Terminal evidence at or below previous terminal index | none | unchanged | duplicate/late write ignored |
| Fresh complete snapshot shows no pending wait after prior `user_action_required` | `pending=none` / clear via probe | running | exact clear |
| Read failure while waiting | `probe=null` | preserve waiting + degraded | conservative |
| Partial/stale snapshot lacks the session | none or `probe=null` | preserve/degraded | conservative |
| Conversation store epoch changes or `steps.idx` resets | baseline new epoch | no terminal alert until diff after baseline | conservative |
| `steps.status=INTERRUPTED` without reliable error/cancel context | `probe=null` or neutral snapshot | preserve/degraded | conservative |
| Reserved/deprecated status value `10` / `HALTED` | `probe=null` or neutral snapshot | preserve/degraded | conservative |
| Unknown step/status/schema | `probe=null` or neutral snapshot | preserve/degraded | conservative |
| Bounded Antigravity transcript tail final question after structural completion | `stop(completed)` with `resolvedLastMessage` | waiting/trailing_question | soft |
| Transcript `RUNNING` with no structural running | none | unchanged | ignored |
| App/backend gone while active session stale | existing liveness | idle/tool_exited | exact liveness |

## Capability Declaration

Planned capability:

```ts
antigravity: {
  yellow: "exact",
  red: "exact",
  metadata: true,
  yellowPush: true,
  redIncludesAborted: false,
}
```

`yellowPush: true` here means the Antigravity poller diffs local state and pushes memory-only normalized events into the tracker, similar to Qoder. The adapter should also provide probe snapshots as a safety net for missed diff events.

If structural red cannot be proven during implementation, downgrade to:

```ts
red: "none"
```

until enough fixtures and manual evidence exist.

## Health Model

Suggested Antigravity health payload:

```ts
type AntigravityHealthState =
  | "not_detected"
  | "ok"
  | "app_alive_backend_down"
  | "store_missing"
  | "store_unreadable"
  | "schema_mismatch"
  | "permission_denied"
  | "degraded";

interface AntigravityHealth {
  state: AntigravityHealthState;
  appAlive: boolean;
  backendAlive: boolean;
  storeFound: boolean;
  readable: boolean;
  activeDbCount: number;
  candidateCount?: number;
  unreadableDbCount?: number;
  schemaFingerprint?: string;
  antigravityVersion?: string;
  lastSuccessfulPollAt: number | null;
  detail?: string;
}
```

Not detected is neutral and should not warn Cursor/Codex/Qoder-only users. Health details must stay on the same redaction allowlist as debug output: no prompts, titles, transcript lines, paths beyond sanitized basenames, process tokens, remotes, or branch names.

## Risk Matrix

| Risk | Impact | Mitigation |
|---|---:|---|
| Summary id has no local detail | false sessions | summary is index only; require local detail |
| Summary contains prompt titles/remotes/branches | privacy breach | do not log/display/persist summary strings |
| Summary omits running snapshots depending on config | false idle | absence of running snapshot is not idle |
| `.db` locked/unreadable | false idle/red | retry/backoff; preserve previous state; health degraded |
| `mode=ro` cannot open DB under read-only directory access | false store missing | use `mode=ro&immutable=1` only when safe; otherwise snapshot copy |
| `immutable=1` ignores active WAL changes | stale state | detect `-wal`/`-shm`; copy coherent snapshot before reading |
| Copied DB still locked/inconsistent | crash/false state | snapshot copy only bounded fallback; tolerate failure |
| Poll reads fresh waiting, probe reads older neutral state | false yellow clear | cache snapshot generation; clear only from fresh structural read |
| Probe returns neutral for partial read | false yellow clear | partial/limited read returns degraded/null, not neutral |
| Same conversation id starts a new episode | missed new run or stale ack | track episode by idx/time/store epoch; marks keyed by stop time |
| Late metadata write after terminal | false running resurrection | require newer user-visible progress before `activity` |
| Terminal stop uses current poll time | repeated red/trailing-question after restart | use stable structural terminal time or silent baseline |
| Metadata write emits `activity` after red | red cleared incorrectly | emit activity only for newer user-visible progress |
| DB compaction or migration resets `steps.idx` | duplicate alerts/false terminal | detect store epoch reset and baseline before diff |
| Unknown `steps.status` | false red/yellow | unknown -> degraded/neutral |
| Reserved/deprecated `HALTED`/value 10 appears | false terminal | treat as unknown until fixture |
| `error_details` contains cancel text | false red | cancel guard before red |
| Non-cancel error hidden inside logs only | missed red | accept unless structural store confirms |
| Historical `permissions` | false yellow | require current active pending evidence |
| Historical `RequestFeedback` artifact metadata | false yellow | require current latest + trajectory waiting evidence |
| Transcript `RUNNING` remains after completion | false green | transcript not primary state |
| Transcript contains tool args/diffs/thinking | privacy breach | tail only in memory; never fixture/log full lines |
| Antigravity transcript passed to generic reader | privacy/perf/parsing risk | adapter does bounded tail parse and passes `resolvedLastMessage` |
| Artifact review after completion | false yellow | not yellow unless structurally blocked |
| Old `.pb` history | false states/perf | baseline only until parser spike |
| `.pb` mtime touched by migration | false recent session | mtime alone never creates session events |
| `implicit/*.pb` background tasks | false sessions | ignore implicit store in hot path |
| Parent/subtrajectory duplication | duplicate rows | aggregate subtrajectory under parent |
| Step-only inference misses trajectory waiting | missed yellow | prefer decoded trajectory summary/update when available |
| Last step is generic/system/history | false terminal/current state | use trajectory status and high-water diff, not last row alone |
| `DONE` step inside still-running trajectory | false completion | require trajectory terminal or terminal boundary |
| Current waiting and terminal evidence conflict | false clear/red | compare evidence idx/time within same epoch |
| Backend restart/update | stale state | file-store polling; liveness/health split |
| Main app alive but backend down | stuck green | backend health + inactive/tool_exited guard |
| Tool/API network errors | false red | logs only health; structural terminal needed |
| Prompt/tool args leakage | privacy breach | no persisted Antigravity events; safe names |
| Metadata name uses prompt-like title | privacy breach | default safe name; title display only future opt-in |
| Content hash used as id | private-content fingerprinting | use ids/short ids, not hashes of prompts/files |
| Large historical files | CPU/disk churn | recent files + high-water + tail reads |
| Symlink/non-regular file in store tree | unexpected scan or leakage | lstat, ignore symlinks and non-regular files |
| Huge blob/transcript tail | memory/CPU spike | size caps and bounded tail reads |
| Antigravity installed elsewhere | false not detected | path/config fallback |
| Multiple Antigravity homes/channels | id collision | namespace ids by home/channel fingerprint if supported |
| Permission denied by OS/package | silent failure | explicit health state |
| Multiple active sessions | aggregate ambiguity | keep existing tracker behavior; document yellow priority |
| Clock/sleep skew | false inactive | shared wake reset; use app clock for emitted events |
| Startup stale waiting from yesterday | false new yellow | freshness window and structural currentness requirement |
| Summary/transcript mtime changes during migration | false fresh session | freshness cannot rely on text/transcript mtime alone |
| Full process args logged | token/endpoint leakage | sanitize to process kind/version only; never store tokens/ports |

## Verification Strategy

Automated tests should use sanitized fixtures and avoid real prompt content:

- Reader handles missing `.gemini/antigravity` as neutral not detected.
- Reader discovers recent `.db` files and ignores summary-only ids.
- Reader canonicalizes session id from file/cascade id and treats table `trajectory_id` as alias.
- Reader maps known `CortexStepStatus` values from numeric ids and treats value 10/unknown as degraded.
- Reader maps active statuses (`PENDING`, `RUNNING`, `GENERATING`, `QUEUED`) to executing.
- Reader maps `DONE` to per-step terminal success, not necessarily whole-trajectory completion unless trajectory state agrees.
- Reader maps structural running/progress to activity.
- Reader maps trajectory `RUNNING`/`BUSY` to activity when decoded.
- Reader maps current `waiting_steps` to `user_action_required`.
- Reader maps current `WAITING` `NOTIFY_USER`/`TASK_BOUNDARY`/`CODE_ACKNOWLEDGEMENT`/`ASK_QUESTION` to `user_action_required`.
- Reader maps current `requires_input_approval` to `user_action_required`.
- Historical permissions on completed steps do not produce yellow.
- Historical `RequestFeedback`/artifact metadata on completed non-current steps does not produce yellow.
- `status=6` plus cancel/context-canceled error details maps to aborted, not red.
- `status=CANCELED` maps to aborted even if the text contains scary error wording.
- Non-cancel structural terminal error maps to red.
- Unknown status/schema returns degraded/neutral, not red/yellow.
- `mode=ro` DB open failure does not become "not detected"; immutable/snapshot fallback is attempted.
- WAL/SHM presence routes through snapshot copy or degraded state, not stale immutable reads.
- Summary-only ids, summary-only waiting, and implicit-store ids do not create sessions.
- Transcript `RUNNING` does not imply current running.
- Bounded Antigravity transcript tail final question after structural completion produces soft trailing question through `resolvedLastMessage`.
- Antigravity stop events do not carry raw `transcriptPath`.
- Transcript/tool args/artifact content are never persisted in fixtures or debug output.
- Locked/cantopen DB preserves previous state and marks degraded.
- Poll/probe uses a coherent snapshot generation; stale probe cannot clear fresh `user_action`.
- Probe returns `null`/degraded, not neutral, when the read is partial or schema-incompatible.
- Missing detail after prior tracking does not become completed/error.
- Startup baseline prevents historical terminals from alerting.
- Startup baseline does not emit yellow for stale waiting unless structural evidence is fresh/current.
- Same conversation id can move terminal -> new running episode only when newer user-visible progress appears.
- Late terminal metadata at an old index does not resurrect or re-alert a session.
- Terminal stop timestamps are stable across repeated polls when structural terminal time is available.
- Restart with terminal evidence but no stable terminal time baselines silently instead of creating a new red/trailing-question notification.
- Metadata-only rewrites after red do not emit `activity` and do not clear failed state.
- DB compaction/index reset creates a new store epoch and baselines before diffing.
- Conflict ordering tests cover waiting vs running, waiting vs completion, and waiting vs terminal error.
- Metadata tests assert default Antigravity names are safe short-id/basename names and never prompt-like titles.
- Event/privacy tests assert Antigravity does not write prompts, content, arguments, thinking signatures, or full paths into persisted events/fixtures.
- Resource tests cover symlink/non-regular files, oversized blobs, oversized transcripts, candidate caps, and per-file backoff.
- Health tests distinguish not detected, store missing, store unreadable, schema mismatch, app alive/backend down, and degraded.
- Cursor/Codex/Qoder regression tests continue to pass.

Manual verification should cover:

1. Antigravity not installed or closed -> neutral/not detected.
2. Antigravity open with no active session -> ok/idle.
3. Normal running task -> green.
4. Plan review / continue / user confirmation -> yellow user_action.
5. Permission-like prompt -> yellow user_action.
6. User continues -> clears yellow and returns running.
7. Normal completion with walkthrough/artifact -> idle, not yellow unless final question heuristic applies.
8. Manual stop/cancel -> idle/aborted, not red.
9. True terminal error -> red if structural and non-cancel.
10. Network/auth/quota/geolocation failure -> verify structural outcome before deciding red/yellow/degraded.
11. Auto-update/backend restart during active task -> no crash; health degrades/recovers.
12. Multiple parallel trajectories -> one row per user-visible trajectory, correct aggregate.
13. Large history directory -> no noticeable CPU/disk churn.
14. Event log and debug dumps contain no prompt/message/tool-argument content.
15. Active artifact-review wait -> verify whether trajectory-level waiting evidence exists; do not yellow from `RequestFeedback` alone.
16. Active notify-user / task-boundary / code-acknowledgement wait -> yellow user_action if structurally current.
17. Current DB with WAL/SHM files -> reader uses coherent snapshot or degrades; no stale immutable read.
18. Summary-only recent id -> no session row and no notification.
19. Summary file with sensitive title/workspace/remote/branch strings -> no debug/log/display leakage.
20. Transcript containing `RUNNING` and sensitive tool payloads -> ignored for exact state and never persisted.
21. Yellow wait followed by temporary unreadable DB -> yellow preserved and health degraded.
22. Yellow wait followed by fresh structural no-wait -> yellow clears.
23. Same conversation continued after completion -> new running episode, old ack/ignore marks do not suppress it.
24. Antigravity update/schema migration while app is open -> conservative degradation, no duplicate red/yellow.
25. Multiple Antigravity windows/tasks in the same workspace -> no duplicate rows for subtrajectories.
26. Custom Antigravity home path fixture -> same reader behavior without touching the real local store.
27. Acknowledged red followed by app restart -> no duplicate red if the terminal evidence is the same.
28. Completed task with final question followed by app restart -> ignored trailing-question mark remains effective when terminal timestamp is stable.
29. Metadata/log/transcript rewrite after a terminal error -> red stays failed until user acknowledgement.

## Open Questions

- Are the confirmed `CortexStepStatus` numeric values stable across Antigravity versions after 2.2.1?
- Is there any actual `BlockedOnUser` equivalent field in newer Antigravity builds, or should the implementation rely only on `waiting_steps`/`WAITING`/notify/task-boundary structures?
- Can `TrajectoryUpdate`, `AgentStateUpdate`, and `CascadeTrajectorySummary` be decoded from `.db`/summary blobs without reading content-bearing fields?
- Can `.pb` conversation stores be decoded safely, and do they matter for active sessions after migration?
- How should product-level aggregate priority behave when one session is red and another is yellow?
- Should artifact review ever become exact yellow when represented as `RequestFeedback` on a `DONE` `CODE_ACTION`, or only when trajectory-level waiting evidence exists?
- Should prompt-like Antigravity task names ever be shown in notifications behind an opt-in?
- What is the right stale grace window when an active conversation file disappears while the app/backend remains alive?
- How should remote/cloud Antigravity tasks without local details be represented, if at all?
- Do Windows/Linux Antigravity installations use equivalent `.gemini/antigravity` paths and process names?
- Are there Antigravity "background" tasks that are user-visible enough to track, or should all `implicit`/daemon work remain ignored?
- Does `mode=ro&immutable=1` remain safe when Antigravity writes with WAL enabled, or must all active DB reads use snapshot copy?
- How should `INTERRUPTED`, `CLEARED`, and reserved/deprecated `HALTED` be shown if they appear as current trajectory terminal states?
- What freshness window should startup use for restoring Antigravity yellow without creating old-notification noise?
- Can the implementation reliably detect store epoch changes across Antigravity migrations, or is mtime/inode plus schema fingerprint sufficient?
- Should the first implementation cache a snapshot per tracker tick, or is a short TTL cache enough to prevent poll/probe races?
- Are multiple Antigravity homes/channels realistic enough for v1 namespacing, or should v1 expose only a single override path?
- Should richer user-action reasons be exposed in the UI, or should v1 intentionally keep all Antigravity waits as generic `user_action`?
- Does Antigravity expose a stable terminal timestamp in the DB/trajectory blobs, or do we need to extend `ProbeSnapshot.terminal` with an evidence key/time?
- Should exact Antigravity `user_action` waits remain non-ignorable like Qoder, or does Antigravity's broader wait taxonomy require a user-dismiss path later?

## Additional Issues To Consider Before Implementation

- Add an explicit config/env override for Antigravity home path to support non-default installs and tests.
- Define the `AntigravitySnapshot` / per-session observation shape before writing reader code.
- Decide snapshot cache lifetime and freshness rules shared by poll and probe.
- Define store epoch fingerprint fields for `.db` + WAL/SHM + schema.
- Decide how synthetic terminal events carry stable evidence time/key through poll and probe.
- Implement Antigravity-specific bounded transcript tail parsing instead of using generic transcript paths.
- Decide whether Antigravity degraded health should use the existing generic DB-degraded badge or a per-tool health badge in settings only.
- Decide whether to add a debug-only state dump for Antigravity that redacts all content but includes ids/status/health.
- Define a fixture sanitization checklist before adding test data.
- Consider a small "schema sample" command for manual validation that prints only table names, counts, status enums, and blob lengths.
- Capture Antigravity version in health/debug output without storing account identifiers or tokens.
- Add a debug redaction contract before any Antigravity diagnostics: no transcript lines, no summary strings, no process tokens, no repository remotes, no branch names, no artifact text.
- Add a parser spike for protobuf descriptor-based decoding of only enum/boolean/index fields from `TrajectoryUpdate`/`CascadeTrajectorySummary`.
- Add a manual capture specifically for active artifact-review wait, active permission wait, active notify-user wait, and active task-boundary wait.
- Add manual captures for same-conversation continuation after completion, DB unreadable during wait, and Antigravity update/migration during an active task.
- Decide whether notification text should ever reveal workspace basename, or whether `Antigravity <short-id>` should be the only default.
