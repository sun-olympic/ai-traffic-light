// 结尾提问判定（design.md D2a，软黄灯）：stop(completed) 时判定最后一条 assistant 消息是否在向用户提问。
// ponytail: 纯词表+问号启发式，不调 LLM；误判由 UI 忽略按钮兜底，词表可配置迭代。

/** 取文本最后一个非空段落/句子，判断是否疑问 */
export function isTrailingQuestion(text: string, questionWords: string[]): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // 结尾句：最后一个句读符号切分后的尾段（含该符号）
  const sentences = trimmed.split(/(?<=[。！？!?.])\s*/).filter((s) => s.trim());
  const last = sentences[sentences.length - 1] ?? trimmed;
  if (/[？?]\s*$/.test(last)) return true;
  return questionWords.some((w) => last.includes(w));
}

/** 从 Cursor transcript JSONL 全文中提取最后一条 assistant 消息文本；解析失败返回 null。
 *  兼容两种行格式：{role, content} 与真实 Cursor 的 {role, message: {content}}。 */
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
      const parts = content
        .filter((p): p is { type: string; text: string } => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text")
        .map((p) => p.text);
      if (parts.length) return parts.join("\n");
    }
  }
  return null;
}
