// 持久化标记（知悉/忽略/错过提问）读写：~/.ai-traffic-light/marks.json
import * as fs from "node:fs";
import path from "node:path";

export function loadMarks(file: string): Map<string, string> {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

export function persistMarks(file: string, marks: Map<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(marks)), { mode: 0o600 });
}
