## ADDED Requirements

### Requirement: Qoder Local State Source
The system SHALL track Qoder sessions by reading Qoder's local task snapshot from `state.vscdb` in read-only mode.

#### Scenario: Qoder snapshot is readable
- **WHEN** Qoder local storage contains `ItemTable.aicoding.questTaskListSnapshot`
- **THEN** the system reads task entries without modifying Qoder files

#### Scenario: Qoder is not installed
- **WHEN** Qoder local storage is absent
- **THEN** the system reports Qoder as not detected without warning and without affecting Cursor or Codex tracking

#### Scenario: Qoder DB is temporarily unavailable
- **WHEN** Qoder storage exists but cannot be opened or queried
- **THEN** the system marks Qoder collection as degraded and retries later without throwing uncaught errors

### Requirement: Qoder Status Mapping
The system SHALL normalize Qoder task statuses into traffic-light session states.

#### Scenario: Running task becomes green
- **WHEN** a Qoder task status normalizes to running
- **THEN** the corresponding traffic-light session is running

#### Scenario: Action required task becomes yellow
- **WHEN** a Qoder task status normalizes to action required
- **THEN** the corresponding traffic-light session is waiting with kind `user_action`

#### Scenario: Completed task becomes idle
- **WHEN** a Qoder task status normalizes to completed
- **THEN** the corresponding traffic-light session leaves running or waiting state and becomes idle unless trailing-question detection marks it waiting

#### Scenario: Stopped task is not red
- **WHEN** a Qoder task status normalizes to stopped or cancelled
- **THEN** the corresponding traffic-light session becomes idle and does not enter failed state

#### Scenario: Error task becomes red after baseline
- **WHEN** a Qoder task transitions to an error status after the startup baseline
- **THEN** the corresponding traffic-light session enters failed state

#### Scenario: Unknown status is conservative
- **WHEN** a Qoder task has an unrecognized status
- **THEN** the system does not map it directly to failed state

### Requirement: Qoder Startup Baseline
The system SHALL establish a startup baseline for Qoder tasks before emitting new Qoder alerts.

#### Scenario: Historical error is silent on startup
- **WHEN** the app starts and the Qoder snapshot already contains an error task
- **THEN** the system does not emit a fresh failed-session notification for that historical task

#### Scenario: New error after startup alerts
- **WHEN** a baseline Qoder task later transitions from running or action required to error
- **THEN** the system emits the normal failed-session notification

#### Scenario: Historical action required is restored without duplicate notifications
- **WHEN** the app starts and the Qoder snapshot already contains an action-required task
- **THEN** the system may restore the visible yellow state but does not repeatedly notify on every poll

#### Scenario: Unchanged action required does not repeat notifications
- **WHEN** a Qoder task remains action required across multiple unchanged snapshot polls
- **THEN** the system emits at most one notification for that unchanged waiting episode

### Requirement: Qoder Session Identity
The system SHALL canonicalize Qoder task and session aliases into one tracked session.

#### Scenario: Execution session id is canonical
- **WHEN** a Qoder task has an `executionSessionId`
- **THEN** the system uses that value as the canonical session id

#### Scenario: Missing execution session id fallback
- **WHEN** a Qoder task has no `executionSessionId`
- **THEN** the system uses `<taskId>.session.execution` as the canonical session id

#### Scenario: Aliases are deduplicated
- **WHEN** Qoder data refers to the same task as both `task-*` and `task-*.session.execution`
- **THEN** the UI shows only one session row and marks use the canonical session id

### Requirement: Qoder Privacy Boundary
The system SHALL avoid persisting Qoder prompt text, transcript text, and AI-modified code content.

#### Scenario: Events exclude prompt-like names
- **WHEN** the system writes Qoder-derived events to the app event log
- **THEN** the event metadata excludes Qoder `query`, prompt-like `title`, local history text, transcript text, and AI-modified content

#### Scenario: Notifications use safe fallback labels
- **WHEN** the system sends a Qoder notification
- **THEN** the notification uses a safe task label rather than raw prompt text

#### Scenario: Fixtures are sanitized
- **WHEN** Qoder reader tests use fixtures
- **THEN** fixture data contains synthetic task content and does not include real prompts, transcripts, or code modifications

### Requirement: Qoder Metadata and Health
The system SHALL expose Qoder metadata and collection health without requiring Qoder to be installed.

#### Scenario: Safe metadata is available
- **WHEN** Qoder task metadata is available
- **THEN** the detail view can show safe session identity and workspace information for the Qoder session

#### Scenario: Missing Qoder is neutral
- **WHEN** Qoder is not detected on the machine
- **THEN** settings health shows a neutral not-detected state

#### Scenario: Schema mismatch is degraded
- **WHEN** Qoder storage exists but the expected snapshot key or schema is missing
- **THEN** settings health shows Qoder collection as degraded

### Requirement: Qoder Stale State Handling
The system SHALL prevent stale Qoder snapshot state from keeping sessions green or yellow indefinitely.

#### Scenario: Qoder exits while snapshot still says running
- **WHEN** Qoder is not alive and an unchanged snapshot still reports a task as running beyond the liveness grace period
- **THEN** the session leaves running state with an unknown stop/tool-exited outcome

#### Scenario: Disappearing task is not assumed complete
- **WHEN** a task disappears from the Qoder snapshot
- **THEN** the system does not treat the disappearance alone as successful completion

#### Scenario: Tracker garbage collection still applies
- **WHEN** a Qoder session has no fresh events beyond the configured session GC threshold
- **THEN** the system may remove the session according to existing session GC behavior

### Requirement: Qoder Transcript Use
The system SHALL use Qoder transcript files only as an optional source for trailing-question detection.

#### Scenario: Completed task with local transcript ending in question
- **WHEN** a newly completed Qoder task has a readable local transcript whose last assistant message is a trailing question
- **THEN** the system marks the session waiting with kind `trailing_question`

#### Scenario: Missing transcript skips trailing question
- **WHEN** a Qoder task completes but no local transcript is available
- **THEN** the system completes the session without error and without trailing-question detection

#### Scenario: ai_tracker is not authoritative state
- **WHEN** Qoder `ai_tracker` files change for a task whose snapshot state is terminal
- **THEN** the system does not resurrect the task as running solely because of `ai_tracker` activity
