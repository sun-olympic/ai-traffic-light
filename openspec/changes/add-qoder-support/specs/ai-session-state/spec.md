## ADDED Requirements

### Requirement: Generic User Action Waiting State
The system SHALL support a generic exact waiting state named `user_action` for tools whose native state indicates that the user must take an unspecified action.

#### Scenario: User action event enters waiting
- **WHEN** a tracked session receives a `user_action_required` event
- **THEN** the session enters `waiting` state with waiting kind `user_action`

#### Scenario: User action waiting is exact
- **WHEN** a session is waiting with kind `user_action`
- **THEN** the waiting state is treated as exact and cannot be ignored as a soft warning

#### Scenario: Activity clears user action waiting
- **WHEN** a session waiting with kind `user_action` receives a subsequent activity, prompt, execution, or stop event
- **THEN** the previous `user_action` waiting state is cleared according to existing session transition rules

### Requirement: Backward-Compatible Event Schema
The system SHALL accept existing v1 and v2 event log entries after adding the `user_action_required` event type.

#### Scenario: Existing events replay after schema extension
- **WHEN** the event log contains valid v1 or v2 Cursor or Codex events
- **THEN** the parser accepts those events and replays them without requiring migration

#### Scenario: New user action event is accepted
- **WHEN** the event log contains a valid event with type `user_action_required`
- **THEN** the parser accepts the event and routes it to the session tracker

### Requirement: Exact Yellow Push Capability
The system SHALL allow an adapter to provide exact yellow waiting states through pushed or diff-derived events by declaring `yellowPush: true`.

#### Scenario: Push-based exact yellow adapter validates
- **WHEN** an adapter declares `yellow: "exact"` and `yellowPush: true`
- **THEN** adapter validation passes even if the adapter does not provide a `probe()` method

#### Scenario: Exact yellow adapter without source fails validation
- **WHEN** an adapter declares `yellow: "exact"` without `yellowPush: true` and without `probe()`
- **THEN** adapter validation reports the missing exact yellow signal source

### Requirement: User Action Display
The system SHALL display `user_action` waiting sessions with user-facing copy that describes a generic user action, not command approval.

#### Scenario: Qoder user action label
- **WHEN** a Qoder session is waiting with kind `user_action`
- **THEN** the detail view labels it as waiting for user action

#### Scenario: Non-approval notification
- **WHEN** a notification is emitted for a `user_action` waiting session
- **THEN** the notification does not describe the state as command approval
