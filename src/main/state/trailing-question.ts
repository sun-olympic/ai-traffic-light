// 结尾提问判定（design.md D2a，软黄灯）：stop(completed) 时判定最后一条 assistant 消息是否在向用户提问。
// ponytail: 纯词表+问号启发式，不调 LLM；误判由 UI 忽略按钮兜底，词表可配置迭代。

/** 取文本末尾数句，判断是否在向用户提问。
 *  检查最后 2 句（问句后常跟一句短补充说明，如"发路径就行。"），有一句含问号即判定。 */
export function isTrailingQuestion(text: string, questionWords: string[]): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const sentences = trimmed.split(/(?<=[。！？!?.])\s*/).filter((s) => s.trim());
  const tailCount = Math.min(sentences.length, 2);
  for (let i = sentences.length - tailCount; i < sentences.length; i++) {
    if (/[？?]\s*$/.test(sentences[i])) return true;
  }
  const last = sentences[sentences.length - 1] ?? trimmed;
  return questionWords.some((w) => last.includes(w));
}

/** 从 transcript JSONL 全文中提取最后一条 assistant 消息文本；解析失败返回 null。
 *  兼容多种行格式：Cursor {role, content}/{role, message: {content}}、
 *  WorkBuddy {role, content: [{type: "output_text", text}]} 等。 */
export function lastAssistantText(jsonl: string): string | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as { role?: unknown; content?: unknown; message?: { content?: unknown } };
    if (m.role !== "assistant") continue;
    const content = m.content ?? m.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      // 兼容 type="text"（Cursor）和 type="output_text"（WorkBuddy）等所有带 text 字段的内容块
      const parts = content
        .filter((p): p is { text: string } => typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string")
        .map((p) => p.text);
      if (parts.length) return parts.join("\n");
    }
  }
  return null;
}
