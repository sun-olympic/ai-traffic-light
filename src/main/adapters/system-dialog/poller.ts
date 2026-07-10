import { EVENT_SCHEMA_VERSION, type TrafficEvent } from "../../../shared/events";
import type { ProbeSnapshot, UserActionBlocker } from "../adapter";

export interface SystemDialog {
  sessionId: string;
  title: string;
}

export interface SystemDialogPollerDeps {
  read: () => SystemDialog[] | null;
  emit?: (ev: TrafficEvent) => void;
  clock: () => number;
}

const MACOS_AUTH_SESSION_ID = "macos-authentication";
const MACOS_AUTH_TITLE = "macOS authentication prompt";
const MACOS_INPUT_SESSION_ID = "macos-input-dialog";
const MACOS_INPUT_TITLE = "macOS input prompt";
const SECURITY_AGENT_RE = /\bSecurityAgent\b/;
const OSASCRIPT_RE = /\bosascript\b/;
const OSASCRIPT_INPUT_DIALOG_RE = /\bdisplay\s+dialog\b/i;
const OSASCRIPT_INPUT_FIELD_RE = /\b(default\s+answer|hidden\s+answer)\b/i;

export function detectMacAuthDialogs(processTable: string, platform: NodeJS.Platform = process.platform): SystemDialog[] {
  if (platform !== "darwin") return [];
  const dialogs = new Map<string, SystemDialog>();
  for (const line of processTable.split(/\r?\n/)) {
    if (SECURITY_AGENT_RE.test(line)) {
      dialogs.set(MACOS_AUTH_SESSION_ID, { sessionId: MACOS_AUTH_SESSION_ID, title: MACOS_AUTH_TITLE });
    }
    if (OSASCRIPT_RE.test(line) && OSASCRIPT_INPUT_DIALOG_RE.test(line) && OSASCRIPT_INPUT_FIELD_RE.test(line)) {
      dialogs.set(MACOS_INPUT_SESSION_ID, { sessionId: MACOS_INPUT_SESSION_ID, title: MACOS_INPUT_TITLE });
    }
  }
  return [...dialogs.values()];
}

export class SystemDialogPoller {
  private readonly deps: SystemDialogPollerDeps;
  private readonly active = new Map<string, SystemDialog>();

  constructor(deps: SystemDialogPollerDeps) {
    this.deps = deps;
  }

  poll(): void {
    const snap = this.deps.read();
    if (snap === null) return;

    const current = new Map(snap.map((d) => [d.sessionId, d]));
    for (const [id, dialog] of current) {
      if (!this.active.has(id)) {
        this.emit(id, "user_action_required", { title: dialog.title });
      }
    }
    for (const id of this.active.keys()) {
      if (!current.has(id)) {
        this.emit(id, "stop", { status: "completed" });
      }
    }
    this.active.clear();
    for (const [id, dialog] of current) this.active.set(id, dialog);
  }

  probeSnapshot(sessionId: string): ProbeSnapshot {
    return {
      pending: this.active.has(sessionId) ? { kind: "user_action_pending" } : { kind: "none" },
      executing: false,
      stuckCandidate: false,
      missedQuestion: false,
    };
  }

  dialogInfo(sessionId: string): SystemDialog | undefined {
    return this.active.get(sessionId);
  }

  hasInputPrompt(): boolean {
    return this.active.has(MACOS_INPUT_SESSION_ID);
  }

  activeBlocker(): UserActionBlocker | null {
    const dialog = this.active.get(MACOS_INPUT_SESSION_ID)
      ?? this.active.get(MACOS_AUTH_SESSION_ID)
      ?? (this.active.values().next().value as SystemDialog | undefined);
    return dialog ? { key: dialog.sessionId, source: "system_dialog", title: dialog.title } : null;
  }

  private emit(sessionId: string, event: TrafficEvent["event"], meta: Record<string, unknown>): void {
    this.deps.emit?.({ v: EVENT_SCHEMA_VERSION, tool: "system", sessionId, event, ts: this.deps.clock(), meta });
  }
}
