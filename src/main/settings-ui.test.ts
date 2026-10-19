import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, test, vi } from "vitest";

interface FakeElement {
  value: string;
  checked: boolean;
  innerHTML: string;
  textContent: string;
  onclick?: () => Promise<void>;
}

function settingsPageWithQoderFailure(op: "install" | "uninstall") {
  const elements = new Map<string, FakeElement>();
  let periodicRefresh: (() => Promise<void>) | undefined;
  const element = (id: string): FakeElement => {
    let found = elements.get(id);
    if (!found) {
      found = { value: "", checked: false, innerHTML: "", textContent: "" };
      elements.set(id, found);
    }
    return found;
  };
  const health = {
    hooks: { installed: true }, dbAvailable: true, dbDegraded: false, lastEventAt: 0, cursorAlive: false,
    codex: { state: "not_installed", alive: false, lastEventAt: 0 },
    qoder: { state: "not_detected", alive: false, hooks: { installed: false, detail: "generic status" } },
    antigravity: { state: "not_detected", alive: false, backendAlive: false },
    codebuddy: { state: "not_detected", alive: false },
    workbuddy: { state: "not_detected", alive: false },
  };
  const source = readFileSync(join(__dirname, "../renderer/settings.ts"), "utf8");
  const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  runInNewContext(script, {
    document: { documentElement: { lang: "" }, getElementById: element, querySelectorAll: () => [] },
    tl: {
      getConfig: async () => ({ language: "zh", approvalThresholdMs: 1000, stuckThresholdMs: 60_000, shellWhitelist: [], mcpWhitelist: [], questionWords: [] }),
      health: async () => health,
      qoderHooks: async () => ({ ok: false, installed: false, detail: `${op} failed: EACCES` }),
    },
    setInterval: (callback: () => Promise<void>) => { periodicRefresh = callback; return 0; },
  });
  return { element, refresh: async () => { await periodicRefresh?.(); } };
}

describe("Qoder settings actions", () => {
  test.each(["install", "uninstall"] as const)("shows the %s failure returned by the hook action", async (op) => {
    const page = settingsPageWithQoderFailure(op);
    await vi.waitFor(() => expect(page.element(`qoder-${op}`).onclick).toBeTypeOf("function"));

    await page.element(`qoder-${op}`).onclick!();

    expect(page.element("qoder-action-error").textContent).toBe(`${op} failed: EACCES`);
    await page.refresh();
    expect(page.element("qoder-action-error").textContent).toBe(`${op} failed: EACCES`);
  });
});
