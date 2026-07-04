// 事件文件监听与轮转（design.md D3）：
// - chokidar 监听 events.jsonl 追加，按字节偏移增量读取；
// - 轮转由 App 主进程执行（hook 脚本只追加）；
// - 目录/文件权限 700/600（事件含命令文本）。
import chokidar, { type FSWatcher } from "chokidar";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import { parseEventLine, type TrafficEvent } from "../shared/events";

const EVENTS_FILE = "events.jsonl";

export function ensureSecureDir(home: string): void {
  fsSync.mkdirSync(home, { recursive: true, mode: 0o700 });
  fsSync.chmodSync(home, 0o700);
  const f = path.join(home, EVENTS_FILE);
  if (fsSync.existsSync(f)) fsSync.chmodSync(f, 0o600);
}

/** 超过 maxBytes 时把当前文件归档为带时间戳文件，只保留最近 keep 个归档 */
export function rotateIfNeeded(home: string, maxBytes: number, keep: number): void {
  const f = path.join(home, EVENTS_FILE);
  let size = 0;
  try {
    size = fsSync.statSync(f).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  // 同一毫秒内连续轮转时避免归档名冲突覆盖
  let ts = Date.now();
  while (fsSync.existsSync(path.join(home, `events-${ts}.jsonl`))) ts++;
  fsSync.renameSync(f, path.join(home, `events-${ts}.jsonl`));
  const archives = fsSync
    .readdirSync(home)
    .filter((x) => x.startsWith("events-") && x.endsWith(".jsonl"))
    .sort();
  for (const stale of archives.slice(0, Math.max(0, archives.length - keep))) {
    fsSync.rmSync(path.join(home, stale), { force: true });
  }
}

export class EventFileWatcher {
  private readonly home: string;
  private readonly onEvent: (ev: TrafficEvent) => void;
  private watcher: FSWatcher | null = null;
  private offset = 0;
  private partial = "";
  private lastTs = 0;
  private reading = Promise.resolve();

  constructor(home: string, onEvent: (ev: TrafficEvent) => void) {
    this.home = home;
    this.onEvent = onEvent;
  }

  private get file(): string {
    return path.join(this.home, EVENTS_FILE);
  }

  async start(): Promise<void> {
    ensureSecureDir(this.home);
    await this.readIncrement();
    this.watcher = chokidar.watch(this.file, {
      ignoreInitial: true,
      usePolling: false,
      alwaysStat: true,
    });
    this.watcher.on("add", () => this.trigger());
    this.watcher.on("change", () => this.trigger());
  }

  private trigger(): void {
    // catch 保链：任何一次读取/处理抛错只记录，不能让 reading 变 rejected 导致后续增量读永久停摆
    this.reading = this.reading.then(() => this.readIncrement()).catch((err) => console.error("[event-file] read failed:", err));
  }

  /** 轮询兜底（design.md Risks）：睡眠唤醒/卷重挂载后 fsevents 可能丢事件，调用方挂周期 tick 上补读增量 */
  poll(): void {
    this.trigger();
  }

  private async readIncrement(): Promise<void> {
    let fh: fsSync.promises.FileHandle;
    try {
      fh = await fs.open(this.file, "r");
    } catch {
      return;
    }
    try {
      const stat = await fh.stat();
      if (stat.size < this.offset) {
        // 文件被轮转重建，从头读
        this.offset = 0;
        this.partial = "";
      }
      if (stat.size === this.offset) return;
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      this.offset = stat.size;
      const chunk = this.partial + buf.toString("utf-8");
      const lines = chunk.split("\n");
      this.partial = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        const ev = parseEventLine(l);
        if (!ev) continue;
        this.lastTs = ev.ts;
        try {
          this.onEvent(ev);
        } catch (err) {
          // 单条事件处理抛错不吞掉同批后续行（offset 已前移，跳过即永久丢失）
          console.error("[event-file] onEvent failed:", err);
        }
      }
    } finally {
      await fh.close();
    }
  }

  /** 最后一条事件的时间戳（0=尚无事件），用于采集通道健康度判定 */
  lastEventAt(): number {
    return this.lastTs;
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    await this.reading;
  }
}
