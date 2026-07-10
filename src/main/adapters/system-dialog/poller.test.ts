import { describe, expect, test } from "vitest";
import type { TrafficEvent } from "../../../shared/events";
import { detectMacAuthDialogs, SystemDialogPoller } from "./poller";

const NOW = 1_783_580_000_000;

describe("detectMacAuthDialogs", () => {
  test("detects a macOS SecurityAgent authentication prompt", () => {
    const table = [
      "  PID     ELAPSED COMM             ARGS",
      "25455       00:03 /System/Library/ /System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent",
    ].join("\n");

    expect(detectMacAuthDialogs(table, "darwin")).toEqual([
      {
        sessionId: "macos-authentication",
        title: "macOS authentication prompt",
      },
    ]);
  });

  test("ignores SecurityAgent text on non-macOS platforms", () => {
    expect(detectMacAuthDialogs("SecurityAgent", "linux")).toEqual([]);
  });

  test("detects osascript password or text input prompts", () => {
    const table = [
      "  PID     ELAPSED COMM             ARGS",
      "93077       01:18 osascript        osascript -e display dialog \"请输入密码\" default answer \"\" with title \"WorkBuddy 安全验证\" buttons {\"取消\", \"确定\"} default button \"确定\" with icon caution hidden answer true",
    ].join("\n");

    expect(detectMacAuthDialogs(table, "darwin")).toEqual([
      {
        sessionId: "macos-input-dialog",
        title: "macOS input prompt",
      },
    ]);
  });

  test("deduplicates parent shell and osascript child for the same input prompt", () => {
    const table = [
      "93076       01:18 /bin/zsh         /bin/zsh -c eval 'osascript -e display dialog \"x\" default answer \"\" hidden answer true'",
      "93077       01:18 osascript        osascript -e display dialog \"x\" default answer \"\" hidden answer true",
    ].join("\n");

    expect(detectMacAuthDialogs(table, "darwin")).toHaveLength(1);
  });
});

describe("SystemDialogPoller", () => {
  test("emits user_action_required once while prompt is visible and stop when it disappears", () => {
    const emitted: TrafficEvent[] = [];
    let dialogs = [{ sessionId: "macos-authentication", title: "macOS authentication prompt" }];
    const poller = new SystemDialogPoller({
      read: () => dialogs,
      emit: (ev) => emitted.push(ev),
      clock: () => NOW,
    });

    poller.poll();
    poller.poll();
    dialogs = [];
    poller.poll();

    expect(emitted.map((ev) => [ev.tool, ev.sessionId, ev.event, ev.meta])).toEqual([
      ["system", "macos-authentication", "user_action_required", { title: "macOS authentication prompt" }],
      ["system", "macos-authentication", "stop", { status: "completed" }],
    ]);
  });

  test("probeSnapshot returns user_action_pending only while prompt is active", () => {
    let dialogs = [{ sessionId: "macos-authentication", title: "macOS authentication prompt" }];
    const poller = new SystemDialogPoller({
      read: () => dialogs,
      emit: () => {},
      clock: () => NOW,
    });

    poller.poll();
    expect(poller.probeSnapshot("macos-authentication")?.pending).toEqual({ kind: "user_action_pending" });

    dialogs = [];
    poller.poll();
    expect(poller.probeSnapshot("macos-authentication")?.pending).toEqual({ kind: "none" });
  });

  test("can track a system dialog as a side-channel without emitting a system session", () => {
    let dialogs = [{ sessionId: "macos-input-dialog", title: "macOS input prompt" }];
    const poller = new SystemDialogPoller({
      read: () => dialogs,
      clock: () => NOW,
    });

    poller.poll();

    expect(poller.activeBlocker()).toEqual({
      key: "macos-input-dialog",
      source: "system_dialog",
      title: "macOS input prompt",
    });

    dialogs = [];
    poller.poll();
    expect(poller.activeBlocker()).toBeNull();
  });
});
