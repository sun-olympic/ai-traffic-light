// Antigravity transcript 有界尾部解析（add-antigravity-support D9/D38）。
// 单一职责：结构完成后取"最后一条 assistant 文本"供尾问检测；只在内存处理，
// 绝不整文件读取、绝不持久化、绝不用于精确 running/waiting/error 判定。
import * as fs from "node:fs";
import path from "node:path";

/** 尾部读取窗口上限（D35）：transcript 可达数 MB，仅末尾窗口参与解析 */
const DEFAULT_MAX_TAIL_BYTES = 64 * 1024;

/** 定位 brain/<id>/.system_generated/logs 下 mtime 最新的 transcript*.jsonl；无 → null */
function latestTranscriptPath(home: string, sessionId: string): string | null {
  const dir = path.join(home, "brain", sessionId, ".system_generated", "logs");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { p: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.startsWith("transcript") || !name.endsWith(".jsonl")) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { p, mtime: st.mtimeMs };
    } catch {
      /* 单文件 stat 失败跳过 */
    }
  }
  return best?.p ?? null;
}

/** 读文件末尾至多 maxBytes 字节；失败 → null */
function readTail(p: string, maxBytes: number): string | null {
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const fd = fs.openSync(p, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buf.toString("utf-8");
    // 窗口截断的首行不完整，丢弃（保守：宁可少看一行）
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch {
    return null;
  }
}

/**
 * 结构完成后的尾问文本来源：最后一条 source=assistant 且 content 为字符串的行。
 * 任何不确定（缺文件/无匹配行/schema 意外）一律 null——跳过尾问比误报安全（D38）。
 */
export function readAntigravityTranscriptTail(home: string, sessionId: string, maxBytes: number = DEFAULT_MAX_TAIL_BYTES): string | null {
  const p = latestTranscriptPath(home, sessionId);
  if (p === null) return null;
  const text = readTail(p, maxBytes);
  if (text === null) return null;
  let last: string | null = null;
  for (const lineText of text.split("\n")) {
    if (!lineText.trim()) continue;
    try {
      const o = JSON.parse(lineText) as Record<string, unknown>;
      // 只认助手对用户的回复：旧 fixture 为 source="assistant"；现行 transcript 为 source="MODEL" 且 type="PLANNER_RESPONSE"。
      // 其余 MODEL 记录（RUN_COMMAND/VIEW_FILE…）的 content 是工具输出，不是回复，不能进尾问判定。
      if (o.source === "assistant" || (o.source === "MODEL" && o.type === "PLANNER_RESPONSE")) {
        // 末条回复正文为空 → 置 null，不回退更早文本（D38：不确定即跳过）
        if (typeof o.content === "string") last = o.content.trim() ? o.content : null;
      }
    } catch {
      /* 坏行忽略 */
    }
  }
  return last;
}
