import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Antigravity 界面同源会话标题读取器（tasks 7.0.2，用户决策：面板显示标题，通知保持安全名）。
 *
 * 数据源：`<home>/agyhub_summaries_proto.pb` —— 顶层重复 field1 = { f1: trajectory-uuid, f2: { f1: title, ... } }
 * （结构由真机盲解验证，见 design D26/D32）。无 proto descriptor，用最小 wire-format 游标只提取
 * id→title 映射；其余字段一律跳过。标题仅限面板本地展示：不落 events.jsonl、不进 debug 输出、不做通知。
 */

const MAX_PB_BYTES = 1_000_000; // 有界读（D22）：实测 ~40KB，1MB 上限防异常膨胀
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Field {
  field: number;
  wire: number;
  sub?: Uint8Array;
}

/** 最小 protobuf wire-format 解析：只认 varint(0) 与 length-delimited(2)，其余定长跳过；损坏即中止 */
function parseFields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    let shift = 0;
    let tag = 0;
    while (true) {
      if (i >= b.length) return out;
      const c = b[i++];
      tag |= (c & 0x7f) << shift;
      if (!(c & 0x80)) break;
      shift += 7;
    }
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      while (i < b.length && b[i++] & 0x80); // varint 值不需要，跳过
      out.push({ field, wire });
    } else if (wire === 2) {
      let len = 0;
      let s = 0;
      while (true) {
        if (i >= b.length) return out;
        const c = b[i++];
        len |= (c & 0x7f) << s;
        if (!(c & 0x80)) break;
        s += 7;
      }
      if (len < 0 || i + len > b.length) return out;
      out.push({ field, wire, sub: b.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return out; // 未知 wire type：文件损坏或格式漂移，放弃剩余部分
    }
  }
  return out;
}

function decodeTitles(buf: Uint8Array): Map<string, string> {
  const titles = new Map<string, string>();
  const dec = new TextDecoder();
  for (const entry of parseFields(buf)) {
    if (entry.field !== 1 || entry.wire !== 2 || !entry.sub) continue;
    const kv = parseFields(entry.sub);
    const idField = kv.find((f) => f.field === 1 && f.wire === 2)?.sub;
    const body = kv.find((f) => f.field === 2 && f.wire === 2)?.sub;
    if (!idField || !body) continue;
    const id = dec.decode(idField);
    if (!UUID_RE.test(id)) continue;
    const titleField = parseFields(body).find((f) => f.field === 1 && f.wire === 2)?.sub;
    if (!titleField || titleField.length === 0) continue;
    // 控制字符压平为空格：标题是单行面板文本
    const title = dec
      .decode(titleField)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim();
    if (title) titles.set(id, title);
  }
  return titles;
}

export class AntigravityTitleReader {
  private cache: Map<string, string> = new Map();
  private cachedMtime = -1;

  constructor(private readonly home: string | null) {}

  /** 会话标题（与 Antigravity 界面同源）；不可得时 null，调用方回退安全短 id 名 */
  title(sessionId: string): string | null {
    if (!this.home) return null;
    const p = join(this.home, "agyhub_summaries_proto.pb");
    try {
      const st = statSync(p);
      if (st.size > MAX_PB_BYTES) return null;
      if (st.mtimeMs !== this.cachedMtime) {
        this.cache = decodeTitles(readFileSync(p));
        this.cachedMtime = st.mtimeMs;
      }
    } catch {
      return null; // 缺失/权限问题：标题不可得，不是错误
    }
    return this.cache.get(sessionId) ?? null;
  }
}
