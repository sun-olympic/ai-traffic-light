// CortexStepStatus 数值映射与取消护栏（add-antigravity-support D3/D10）。
// 单一职责：纯枚举解释，无 IO、无会话语义（会话级推导在 derive-state）。

/** 步骤状态类别；unknown 永不直接映射为红/黄（D18） */
export type StepClass = "active" | "waiting" | "done" | "canceled" | "error" | "cleared" | "unknown";

// Antigravity 2.2.1 二进制描述符确认的数值（design D3）：
// 1=PENDING 2=RUNNING 8=GENERATING 11=QUEUED 为 active；9=WAITING；3=DONE；
// 4=INVALID 7=ERROR 为 error 候选（经取消护栏）；5=CLEARED；6=CANCELED；
// 0=UNSPECIFIED、10=保留/HALTED、12=INTERRUPTED（无上下文）及未来新值一律 unknown。
const STATUS_CLASS: Record<number, StepClass> = {
  1: "active",
  2: "active",
  8: "active",
  11: "active",
  9: "waiting",
  3: "done",
  4: "error",
  7: "error",
  5: "cleared",
  6: "canceled",
};

export function classifyStepStatus(status: number): StepClass {
  return STATUS_CLASS[status] ?? "unknown";
}

/** 取消/用户中止文案特征（D10）；命中则终态按 aborted 处理，不亮红 */
const CANCEL_PATTERNS = [
  "context canceled",
  "context cancelled",
  "user canceled",
  "user cancelled",
  "cancelled by user",
  "canceled by user",
  "manage_task cancel",
  "aborted",
] as const;

export function isCancelText(text: string): boolean {
  const t = text.toLowerCase();
  return CANCEL_PATTERNS.some((p) => t.includes(p));
}
