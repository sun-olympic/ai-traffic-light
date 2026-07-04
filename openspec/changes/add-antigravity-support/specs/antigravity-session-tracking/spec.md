## ADDED Requirements

### Requirement: Antigravity Local State Source
The system SHALL track Antigravity sessions by reading local read-only stores under the Antigravity home (default `~/.gemini/antigravity`), using `conversations/<id>.db` SQLite stores as the primary current-state source. The system MUST NOT modify Antigravity files and MUST NOT depend on Antigravity's local API or VS Code global storage for current-session tracking.

#### Scenario: Antigravity is not installed
- **WHEN** the Antigravity home directory is absent
- **THEN** the system reports Antigravity as not detected without warning and without affecting other tools

#### Scenario: Recent conversation DB is readable
- **WHEN** a recent `conversations/<id>.db` exists and is structurally readable
- **THEN** the system derives session state from its structural fields without writing to any Antigravity file

#### Scenario: Antigravity home override
- **WHEN** a config or environment override for the Antigravity home path is provided
- **THEN** the system reads stores from the override path instead of the default

#### Scenario: Summary-only ids do not create sessions
- **WHEN** a trajectory id appears in the hub summary file but has no local conversation store or brain evidence
- **THEN** the system classifies it as untrackable history and emits no session events

#### Scenario: Old pb conversation stores are history only
- **WHEN** a trajectory only has an old `.pb` conversation store with no proven-safe parser
- **THEN** the system treats it as baseline history and does not emit exact running, waiting, or failed states from it

#### Scenario: Implicit background stores are ignored
- **WHEN** entries exist only under implicit/background stores
- **THEN** the system does not create user-visible session rows for them

### Requirement: Antigravity Read-Only SQLite Access
The system SHALL open Antigravity conversation databases read-only with a lock-safe strategy, and SHALL treat read failures as degraded conditions that preserve prior session state.

#### Scenario: No WAL sidecar uses immutable read
- **WHEN** a conversation DB has no `-wal`/`-shm` sidecar files
- **THEN** the reader opens it with an immutable read-only strategy

#### Scenario: WAL sidecar avoids stale immutable read
- **WHEN** `-wal` or `-shm` sidecar files exist for a conversation DB
- **THEN** the reader does not rely on an immutable open of the main file alone and instead uses a bounded snapshot copy or reports degraded

#### Scenario: Locked or unopenable DB preserves state
- **WHEN** a conversation DB cannot be opened or queried
- **THEN** the system preserves the previous session state, marks Antigravity health degraded, and retries with backoff

#### Scenario: Reads are serialized
- **WHEN** multiple Antigravity conversation DBs are candidates in one poll
- **THEN** the reader reads them one at a time rather than in parallel

### Requirement: Antigravity Status Mapping
The system SHALL normalize Antigravity structural step status (`CortexStepStatus`) and trajectory-level run status into traffic-light session states, treating unknown values conservatively.

#### Scenario: Active statuses become running
- **WHEN** the current structural state shows `PENDING`, `RUNNING`, `GENERATING`, or `QUEUED`
- **THEN** the corresponding session is running

#### Scenario: Structural completion becomes idle
- **WHEN** the trajectory reaches a structural completed terminal state
- **THEN** the session becomes idle unless trailing-question detection marks it waiting

#### Scenario: Cancelled is not red
- **WHEN** the terminal evidence is `CANCELED` or terminal error details match cancellation/user-stop patterns
- **THEN** the session stops as aborted and does not enter failed state

#### Scenario: Non-cancel structural error becomes red
- **WHEN** a non-cancel structural terminal error (`ERROR`, or `INVALID` with error evidence) is observed after baseline
- **THEN** the session enters failed state

#### Scenario: Unknown status is conservative
- **WHEN** an unknown, reserved, or unmapped status value (including value 10/`HALTED` and `INTERRUPTED` without error/cancel context) is observed
- **THEN** the system preserves current state and does not map it to running, waiting, or failed

#### Scenario: Last row alone is not authoritative
- **WHEN** the last step row is a system/history/generic/artifact step but trajectory-level state indicates otherwise
- **THEN** the system prefers trajectory-level structural state over the last row

#### Scenario: Fresh terminal-looking store is in progress
- **WHEN** the structural state looks terminal (all steps DONE, or a trailing error/cancel row) but the store mtime is within the terminal quiet window
- **THEN** the session is treated as running because Antigravity only persists steps on completion and the active step is not visible

#### Scenario: Terminal state is confirmed after write quiescence
- **WHEN** a terminal-looking structural state persists and the store mtime has been quiet beyond the terminal quiet window
- **THEN** the system confirms the terminal state and emits the corresponding stop with the store mtime as its stable timestamp

### Requirement: Antigravity Exact Yellow
The system SHALL enter exact waiting with kind `user_action` only on current structural waiting evidence, never from historical metadata or free text.

#### Scenario: Current waiting step becomes yellow
- **WHEN** the current structural state shows a waiting step (status `WAITING` on a current step) or non-empty trajectory waiting evidence
- **THEN** the session enters waiting with kind `user_action`

#### Scenario: Historical artifact metadata is not yellow
- **WHEN** completed non-current steps contain artifact/feedback/permission metadata
- **THEN** the session does not enter waiting

#### Scenario: Waiting is preserved on read failure
- **WHEN** a session is waiting with kind `user_action` and the store becomes temporarily unreadable
- **THEN** the waiting state is preserved and Antigravity health is degraded

#### Scenario: Fresh no-wait snapshot clears yellow
- **WHEN** a fresh complete structural read of the same store shows no pending wait
- **THEN** the waiting state clears

#### Scenario: Stale snapshot does not clear yellow
- **WHEN** a probe snapshot is older than or partial relative to the waiting evidence
- **THEN** the waiting state is not cleared

### Requirement: Antigravity Startup Baseline and Episodes
The system SHALL baseline existing Antigravity state at startup without fresh alerts, and SHALL track per-session episodes so reused conversation ids, late writes, and store epoch changes do not produce false alerts or resurrections.

#### Scenario: Historical terminal is silent on startup
- **WHEN** the app starts and a conversation store already contains a terminal state
- **THEN** no fresh failed or trailing-question notification is emitted for that historical state

#### Scenario: New terminal after baseline alerts
- **WHEN** a baselined session later transitions to a non-cancel structural terminal error
- **THEN** the normal failed-session notification is emitted

#### Scenario: Continued conversation starts a new episode
- **WHEN** newer user-visible structural progress (higher step index in the same store epoch) appears after a terminal state
- **THEN** the session becomes running as a new episode and old acknowledgement/ignore marks do not suppress it

#### Scenario: Late writes do not resurrect terminals
- **WHEN** metadata-only writes or evidence at or below the terminal index appear after a terminal state
- **THEN** no activity is emitted and the terminal state is unchanged

#### Scenario: Store epoch reset re-baselines
- **WHEN** the step index resets, the DB file is replaced, or the store is migrated
- **THEN** the system treats it as a new store epoch and baselines before emitting new alerts

#### Scenario: Terminal timestamps are stable
- **WHEN** the same structural terminal evidence is observed across polls or restarts
- **THEN** the emitted stop timestamp is stable so acknowledgement and ignore marks remain effective

### Requirement: Antigravity Transcript Tail Use
The system SHALL use Antigravity transcripts only as a bounded, in-memory tail source for trailing-question detection after structural completion, bypassing the generic transcript reader.

#### Scenario: Trailing question after completion
- **WHEN** a session completes structurally and the bounded transcript tail yields a final assistant message that is a trailing question
- **THEN** the session is marked waiting with kind `trailing_question` via the resolved-message path

#### Scenario: Transcript running is ignored
- **WHEN** transcript lines report `RUNNING` while the structural store indicates terminal
- **THEN** the transcript does not override the structural state

#### Scenario: Stop events carry no transcript path
- **WHEN** the system emits an Antigravity stop event
- **THEN** the event does not include a raw transcript path for the generic reader

#### Scenario: Missing transcript skips detection
- **WHEN** no readable transcript tail exists after structural completion
- **THEN** the session completes without trailing-question detection and without error

### Requirement: Antigravity Privacy Boundary
The system SHALL keep Antigravity-derived events memory-only and SHALL NOT persist Antigravity prompt/message content, tool arguments, artifact text, code diffs, thinking, workspace URIs, repository remotes, branch names, tokens, or full local paths. The panel MAY display the interface-sourced session title locally (Qoder precedent), truncated with hover-to-reveal.

#### Scenario: No events are persisted
- **WHEN** Antigravity state transitions are processed
- **THEN** no Antigravity-derived events are written to the persisted event log

#### Scenario: Panel shows interface-sourced session title
- **WHEN** a session title is readable from the local summary store
- **THEN** the panel row displays that title (same text the Antigravity UI shows), falling back to the safe short-id name when unavailable, and the title is never persisted or logged

#### Scenario: Notifications use safe names
- **WHEN** an Antigravity notification is emitted
- **THEN** it uses a safe name of the form `Antigravity <short-id>` (optionally with workspace basename) and never prompt-like titles

#### Scenario: Fixtures are sanitized
- **WHEN** Antigravity reader tests use fixtures
- **THEN** fixtures contain synthetic structural data without real prompts, transcripts, tool arguments, or code content

### Requirement: Antigravity Metadata and Health
The system SHALL expose Antigravity liveness and multi-state collection health without requiring Antigravity to be installed, and SHALL never derive lamp states from logs or process arguments.

#### Scenario: Missing Antigravity is neutral
- **WHEN** Antigravity is not detected
- **THEN** settings health shows a neutral not-detected state without warnings

#### Scenario: Schema mismatch is degraded
- **WHEN** a conversation store exists but required tables/columns are missing or blobs needed for exact state are unreadable
- **THEN** settings health shows schema mismatch/degraded and prior session states are preserved

#### Scenario: Permission denied is a health state
- **WHEN** the Antigravity home exists but cannot be read due to permissions
- **THEN** settings health reports the permission problem rather than showing "no sessions"

#### Scenario: Logs never drive lamp states
- **WHEN** Antigravity log files contain error-looking lines
- **THEN** no session becomes yellow or red because of log text

### Requirement: Antigravity Stale State Handling
The system SHALL prevent stale Antigravity state from keeping sessions green or yellow indefinitely, and SHALL NOT treat disappearance of local state as completion.

#### Scenario: Antigravity exits while store says running
- **WHEN** Antigravity processes are not alive and a session remains running beyond the liveness grace period
- **THEN** the session leaves running state with a tool-exited outcome

#### Scenario: Disappearing store is not completion
- **WHEN** a tracked session's conversation store disappears while Antigravity is alive
- **THEN** the system keeps the last known state for a grace window, marks health degraded, and lets normal session GC remove it

#### Scenario: Bounded polling
- **WHEN** the Antigravity directory contains many historical files
- **THEN** each poll scans only recent conversation DBs by mtime with a capped candidate count and does not parse `.pb` history in the hot path
