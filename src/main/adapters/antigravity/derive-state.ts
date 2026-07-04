// steps 结构行 → 会话观测（add-antigravity-support D3/D7/D10/D26/D30）。
// 单一职责：纯函数解释一份快照的行集合，不做 diff/episode/事件（那是 poller 的职责）。
// ponytail: v1 仅用 steps 结构证据；trajectory 级 blob 解码（D26 首选）留待 parser spike，
// 升级路径是在此函数前插入 trajectory 观测并让其优先。
import type { StepRow } from "./db-reader";
import { classifyStepStatus, isCancelText } from "./status-map";

export type SessionStateKind = "running" | "waiting" | "completed" | "aborted" | "error" | "unknown";

export interface SessionObservation {
  kind: SessionStateKind;
  /** 全表最大 idx（高水位，episode/活性 diff 用，D29） */
  maxIdx: number;
  /** 决定 kind 的证据行 idx（终态/等待证据序比较用，D30/D37） */
  evidenceIdx: number;
}

/**
 * 证据序推导（D30）：waiting/active/terminal 各取最高 idx，最新证据胜出；
 * 平手偏保守取 waiting（当前结构等待优于泛化 running/终态）。
 * unknown/cleared 行不构成证据（最后行不权威，D26），但计入 maxIdx 高水位。
 */
export function deriveObservation(rows: StepRow[]): SessionObservation {
  let maxIdx = -1;
  let waiting = -1;
  let active = -1;
  let terminal: { idx: number; kind: "completed" | "aborted" | "error" } | null = null;

  for (const r of rows) {
    if (r.idx > maxIdx) maxIdx = r.idx;
    switch (classifyStepStatus(r.status)) {
      case "waiting":
        if (r.idx > waiting) waiting = r.idx;
        break;
      case "active":
        if (r.idx > active) active = r.idx;
        break;
      case "done":
        if (!terminal || r.idx > terminal.idx) terminal = { idx: r.idx, kind: "completed" };
        break;
      case "canceled":
        if (!terminal || r.idx > terminal.idx) terminal = { idx: r.idx, kind: "aborted" };
        break;
      case "error":
        if (!terminal || r.idx > terminal.idx) {
          // 取消护栏（D10）：取消/用户中止文案的"错误"按 aborted 处理，不亮红
          terminal = { idx: r.idx, kind: r.errorDetails !== null && isCancelText(r.errorDetails) ? "aborted" : "error" };
        }
        break;
      // cleared/unknown：非证据
    }
  }

  if (waiting >= 0 && waiting >= active && waiting >= (terminal?.idx ?? -1)) {
    return { kind: "waiting", maxIdx, evidenceIdx: waiting };
  }
  if (active >= 0 && active >= (terminal?.idx ?? -1)) {
    return { kind: "running", maxIdx, evidenceIdx: active };
  }
  if (terminal) {
    return { kind: terminal.kind, maxIdx, evidenceIdx: terminal.idx };
  }
  return { kind: "unknown", maxIdx, evidenceIdx: -1 };
}
