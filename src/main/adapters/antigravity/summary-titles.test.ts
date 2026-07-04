import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityTitleReader } from "./summary-titles";

// —— 合成 protobuf fixture 编码（结构与实测 agyhub_summaries_proto.pb 一致）——
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function lenField(field: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.from([...varint((field << 3) | 2), ...varint(payload.length), ...payload]);
}

function entry(id: string, title: string | null): Uint8Array {
  const enc = new TextEncoder();
  const bodyParts: number[] = [];
  if (title !== null) bodyParts.push(...lenField(1, enc.encode(title)));
  // 混入 varint 字段（f2=104）模拟真实 body 的其他字段
  bodyParts.push((2 << 3) | 0, ...varint(104));
  const inner = Uint8Array.from([...lenField(1, enc.encode(id)), ...lenField(2, Uint8Array.from(bodyParts))]);
  return lenField(1, inner);
}

function writePb(dir: string, entries: Uint8Array[]): string {
  const p = join(dir, "agyhub_summaries_proto.pb");
  writeFileSync(p, Buffer.concat(entries.map((e) => Buffer.from(e))));
  return p;
}

const ID_A = "f2ddb52a-09c0-417f-95c3-5b5c51b32939";
const ID_B = "d9c28bef-3ed8-47f0-8bf3-5109ab2179f0";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-titles-"));
  return () => rmSync(home, { recursive: true, force: true });
});

describe("AntigravityTitleReader（7.0.2 界面同源标题）", () => {
  test("解析 id→标题映射；未知 id 与缺标题 entry 返回 null", () => {
    writePb(home, [entry(ID_A, "@[ai-traffic-light] 菜单栏图标"), entry(ID_B, null)]);
    const r = new AntigravityTitleReader(home);
    expect(r.title(ID_A)).toBe("@[ai-traffic-light] 菜单栏图标");
    expect(r.title(ID_B)).toBeNull();
    expect(r.title("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("home 为 null 或 pb 缺失 → null（回退安全名由调用方处理）", () => {
    expect(new AntigravityTitleReader(null).title(ID_A)).toBeNull();
    expect(new AntigravityTitleReader(home).title(ID_A)).toBeNull();
  });

  test("损坏内容不抛异常，返回 null", () => {
    writeFileSync(join(home, "agyhub_summaries_proto.pb"), Buffer.from([0xff, 0xff, 0xff, 0x07, 0x01]));
    expect(new AntigravityTitleReader(home).title(ID_A)).toBeNull();
  });

  test("超过大小上限的文件跳过（有界读，D22）", () => {
    const p = writePb(home, [entry(ID_A, "t")]);
    writeFileSync(p, Buffer.concat([Buffer.alloc(2_000_000), Buffer.from(entry(ID_A, "t"))]));
    expect(new AntigravityTitleReader(home).title(ID_A)).toBeNull();
  });

  test("mtime 缓存：文件未变不重读，mtime 变化后读到新标题", () => {
    const p = writePb(home, [entry(ID_A, "old title")]);
    utimesSync(p, new Date(1000000), new Date(1000000));
    const r = new AntigravityTitleReader(home);
    expect(r.title(ID_A)).toBe("old title");
    writePb(home, [entry(ID_A, "new title")]);
    utimesSync(p, new Date(2000000), new Date(2000000));
    expect(r.title(ID_A)).toBe("new title");
  });

  test("标题含控制字符/换行时压平（单行面板展示）", () => {
    writePb(home, [entry(ID_A, "line1\nline2\u0000x")]);
    expect(new AntigravityTitleReader(home).title(ID_A)).toBe("line1 line2 x");
  });
});
