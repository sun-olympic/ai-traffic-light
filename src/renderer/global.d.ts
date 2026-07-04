// preload 暴露的完整渲染层 API（window.tl），widget/settings 共用
interface CodexHealth {
  state: "not_installed" | "disabled" | "installed_inactive" | "ok";
  installed: boolean;
  detail?: string;
  disabled: boolean;
  trusted: boolean;
  alive: boolean;
  lastEventAt: number;
}

interface QoderHealthView {
  state: "not_detected" | "ok" | "degraded";
  alive: boolean;
}

interface AntigravityHealthView {
  state: "not_detected" | "ok" | "degraded" | "schema_mismatch" | "permission_denied";
  alive: boolean;
  backendAlive: boolean;
}

interface TlGlobalApi {
  onState(cb: (p: unknown) => void): void;
  onPlaySound(cb: (file: string) => void): void;
  action(type: string, tool: string, sessionId: string): Promise<void>;
  resize(w: number, h: number): Promise<"left" | "right">;
  getConfig(): Promise<Record<string, unknown>>;
  setConfig(partial: Record<string, unknown>): Promise<Record<string, unknown>>;
  hooks(op: string): Promise<{ installed: boolean; detail?: string }>;
  codexHooks(op: string): Promise<CodexHealth>;
  codexTrustTerminal(): Promise<{ command: string }>;
  health(): Promise<{
    hooks: { installed: boolean; detail?: string };
    dbAvailable: boolean;
    dbDegraded: boolean;
    lastEventAt: number;
    cursorAlive: boolean;
    codex: CodexHealth;
    qoder: QoderHealthView;
    antigravity: AntigravityHealthView;
  }>;
  sound(op: string, color: string, filePath?: string): Promise<{ ok: boolean }>;
}

declare const tl: TlGlobalApi;
