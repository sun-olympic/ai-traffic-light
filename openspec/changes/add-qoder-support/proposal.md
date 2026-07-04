## Why

AI Traffic Light already tracks Cursor and Codex sessions, but Qoder agent work is invisible to the desktop traffic-light view. Qoder exposes local task state in its VS Code-style storage, so the app can support Qoder without installing hooks or collecting chat content.

## What Changes

- Add Qoder as a first-class tracked AI tool alongside Cursor and Codex.
- Read Qoder task state from its local `state.vscdb` snapshot and translate task status into existing traffic-light session states.
- Add an exact yellow state for Qoder user action requirements without mislabeling them as command approvals.
- Add Qoder cold-start handling, session identity canonicalization, and duplicate notification prevention.
- Add Qoder metadata and health reporting while keeping prompt, transcript, and AI-modified code content out of persisted event logs.
- Keep Cursor and Codex behavior unchanged.

## Capabilities

### New Capabilities
- `qoder-session-tracking`: Tracks Qoder AI agent sessions, maps Qoder task states to traffic-light states, exposes safe metadata, and reports collector health.
- `ai-session-state`: Defines shared session event and waiting-state behavior used by tracked AI tools.

### Modified Capabilities
- None.

## Impact

- Main-process session tracking, event schema, adapter capability declarations, process liveness, and settings health plumbing.
- Renderer detail labels and settings-page health copy.
- Tests for Qoder snapshot parsing, state mapping, cold-start baseline behavior, alias deduplication, and privacy-safe fixtures.
- No new external services and no Qoder hook installation.
