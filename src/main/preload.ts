import { contextBridge, ipcRenderer } from "electron";

export interface RendererApi {
  onState(cb: (payload: unknown) => void): void;
  onPlaySound(cb: (file: string) => void): void;
  action(type: "ignore" | "ack" | "clearMark", tool: string, sessionId: string): Promise<void>;
  resize(width: number, height: number): Promise<"left" | "right">;
  getConfig(): Promise<unknown>;
  setConfig(partial: unknown): Promise<unknown>;
  hooks(op: "status" | "install" | "uninstall"): Promise<unknown>;
  codexHooks(op: "status" | "install" | "uninstall"): Promise<unknown>;
  codexTrustTerminal(): Promise<unknown>;
  health(): Promise<unknown>;
  sound(op: "preview" | "setCustom" | "reset", color: "yellow" | "red", filePath?: string): Promise<unknown>;
}

const api: RendererApi = {
  onState: (cb) => ipcRenderer.on("state:update", (_e, payload) => cb(payload)),
  onPlaySound: (cb) => ipcRenderer.on("sound:play", (_e, file) => cb(file)),
  action: (type, tool, sessionId) => ipcRenderer.invoke("action", type, tool, sessionId),
  resize: (width, height) => ipcRenderer.invoke("window:resize", width, height),
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial),
  hooks: (op) => ipcRenderer.invoke("hooks", op),
  codexHooks: (op) => ipcRenderer.invoke("codexHooks", op),
  codexTrustTerminal: () => ipcRenderer.invoke("codexTrust:terminal"),
  health: () => ipcRenderer.invoke("health:get"),
  sound: (op, color, filePath) => ipcRenderer.invoke("sound", op, color, filePath),
};

contextBridge.exposeInMainWorld("tl", api);
