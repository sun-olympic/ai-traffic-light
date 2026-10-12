import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { QoderSessionNameReader } from "./session-name-reader";

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "qoder-names-"));
  const dbPath = join(dir, "main.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT)");
  db.prepare("INSERT INTO chat_sessions VALUES (?, ?)").run("chat-123", "Fix traffic light status");
  db.prepare("INSERT INTO chat_sessions VALUES (?, ?)").run("chat-empty", "  ");
  db.exec("CREATE TABLE chat_session_messages (session_id TEXT, sequence INTEGER, payload_json TEXT)");
  const message = db.prepare("INSERT INTO chat_session_messages VALUES (?, ?, ?)");
  message.run("chat-question", 1, JSON.stringify({ role: "user", text: "Please help" }));
  message.run("chat-question", 2, JSON.stringify({ role: "assistant", text: "Which option should I use?" }));
  message.run("chat-answered", 1, JSON.stringify({ role: "assistant", text: "Which option should I use?" }));
  message.run("chat-answered", 2, JSON.stringify({ role: "user", text: "Option A" }));
  message.run("chat-done", 1, JSON.stringify({ role: "assistant", text: "Everything is complete." }));
  db.close();
  return dbPath;
}

describe("QoderSessionNameReader", () => {
  test("reads the title by Qoder chat session ID without needing the stale task snapshot", () => {
    const reader = new QoderSessionNameReader(makeDb());
    expect(reader.title("chat-123")).toBe("Fix traffic light status");
    expect(reader.title("unknown-session")).toBeNull();
    reader.close();
  });

  test("ignores blank titles and unavailable databases", () => {
    const reader = new QoderSessionNameReader(makeDb());
    expect(reader.title("chat-empty")).toBeNull();
    expect(new QoderSessionNameReader(join(tmpdir(), "missing-qoder.sqlite")).title("chat-123")).toBeNull();
    reader.close();
  });

  test("returns only the latest unanswered assistant turn for Qoder waiting detection", () => {
    const reader = new QoderSessionNameReader(makeDb());
    const latestAssistantMessage = Reflect.get(reader, "latestAssistantMessage") as ((id: string) => string | null) | undefined;
    expect(typeof latestAssistantMessage).toBe("function");
    expect(latestAssistantMessage!.call(reader, "chat-question")).toBe("Which option should I use?");
    expect(latestAssistantMessage!.call(reader, "chat-answered")).toBeNull();
    expect(latestAssistantMessage!.call(reader, "chat-done")).toBe("Everything is complete.");
    reader.close();
  });

  test("detects an unanswered trailing assistant question but not answered or completed turns", () => {
    const reader = new QoderSessionNameReader(makeDb());
    const latestAssistantQuestion = Reflect.get(reader, "latestAssistantQuestion") as ((id: string, words: string[]) => string | null) | undefined;
    expect(typeof latestAssistantQuestion).toBe("function");
    expect(latestAssistantQuestion!.call(reader, "chat-question", [])).toBe("Which option should I use?");
    expect(latestAssistantQuestion!.call(reader, "chat-answered", [])).toBeNull();
    expect(latestAssistantQuestion!.call(reader, "chat-done", [])).toBeNull();
    reader.close();
  });
});
