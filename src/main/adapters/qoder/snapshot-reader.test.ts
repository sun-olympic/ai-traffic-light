import { beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalQoderSessionId, normalizeQoderStatus, QoderSnapshotReader, qoderSafeName, qoderTranscriptPath, stripQoderSessionSuffix } from "./snapshot-reader";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-qoder-"));
});

// 全合成 fixture：不含真实 prompt/transcript/代码内容（spec：Fixtures are sanitized）
function makeSnapshot(tasks: Array<Record<string, unknown>>, folder = "/tmp/demo-ws"): string {
  return JSON.stringify({ version: 1, updatedAt: 1783150000000, folders: { [folder]: { updatedAt: 1783150000000, tasks } } });
}

function makeDb(snapshotJson: string | null, name = "state.vscdb"): string {
  const p = join(dir, name);
  const db = new DatabaseSync(p);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  if (snapshotJson !== null) {
    db.prepare("INSERT INTO ItemTable (key, value) VALUES ('aicoding.questTaskListSnapshot', ?)").run(snapshotJson);
  }
  db.close();
  return p;
}

const SYNTH_TASK = {
  id: "task-aaaa1111bbbb2222cccc",
  status: "Running",
  executionSessionId: "task-aaaa1111bbbb2222cccc.session.execution",
  updatedAtTimestamp: 1783150000000,
  createdAt: 1783149000000,
  // 隐私字段（合成占位）：读取器必须丢弃
  query: "synthetic-prompt-text",
  title: "synthetic-title",
  name: "synthetic-name",
  userRequirements: "synthetic-req",
};

describe("normalizeQoderStatus（D4 保守归一化）", () => {
  test("running 族", () => {
    for (const s of ["Running", "planning", "running", "in_progress", "prompting", "streaming"]) {
      expect(normalizeQoderStatus(s)).toBe("running");
    }
  });
  test("user_action 族", () => {
    for (const s of ["ActionRequired", "suspended", "action_required", "actionrequired"]) {
      expect(normalizeQoderStatus(s)).toBe("user_action");
    }
  });
  test("completed 族", () => {
    for (const s of ["Completed", "complete", "end_turn"]) expect(normalizeQoderStatus(s)).toBe("completed");
  });
  test("stopped 族", () => {
    for (const s of ["Stopped", "stop", "cancelled", "canceled"]) expect(normalizeQoderStatus(s)).toBe("stopped");
  });
  test("error 族", () => {
    for (const s of ["Error", "failed", "failure", "error_aborted"]) expect(normalizeQoderStatus(s)).toBe("error");
  });
  test("未知状态不映射为 error（保守）", () => {
    expect(normalizeQoderStatus("SomeFutureStatus")).toBe("unknown");
    expect(normalizeQoderStatus("")).toBe("unknown");
  });
});

describe("canonicalQoderSessionId（D5 别名归一）", () => {
  test("有 executionSessionId 用它", () => {
    expect(canonicalQoderSessionId({ id: "task-1", executionSessionId: "task-1.session.execution" })).toBe("task-1.session.execution");
  });
  test("缺 executionSessionId 回退 <taskId>.session.execution", () => {
    expect(canonicalQoderSessionId({ id: "task-2" })).toBe("task-2.session.execution");
    expect(canonicalQoderSessionId({ id: "task-3", executionSessionId: "" })).toBe("task-3.session.execution");
  });
  test("别名剥离：execution/design 后缀归到同一 task id", () => {
    expect(stripQoderSessionSuffix("task-1.session.execution")).toBe("task-1");
    expect(stripQoderSessionSuffix("task-1.session.design")).toBe("task-1");
    expect(stripQoderSessionSuffix("task-1")).toBe("task-1");
  });
});

describe("qoderSafeName（D6 隐私安全通知名）", () => {
  test("workspace 目录名 + 短 id，不含 prompt", () => {
    expect(qoderSafeName("task-aaaa1111bbbb2222cccc", "/tmp/demo-ws")).toBe("demo-ws · task-aaaa");
    expect(qoderSafeName("task-aaaa1111bbbb2222cccc", null)).toBe("Qoder task task-aaaa");
  });
});

describe("qoderTranscriptPath（D7 尾问检测数据源定位）", () => {
  test("按任务短 id 在 projects 下定位；无记录（远程任务/缓存缺失）返回 null", () => {
    const conv = join(dir, "projects", "demo-abc123", "conversation-history", "task-aaa");
    mkdirSync(conv, { recursive: true });
    writeFileSync(join(conv, "task-aaa.jsonl"), "{}\n");
    expect(qoderTranscriptPath(dir, "task-aaaXYZ-rest-of-id")).toBe(join(conv, "task-aaa.jsonl"));
    expect(qoderTranscriptPath(dir, "task-zzz-not-there")).toBeNull();
    expect(qoderTranscriptPath(join(dir, "nope"), "task-aaaXYZ")).toBeNull();
  });
});

describe("QoderSnapshotReader", () => {
  test("读取任务只保留安全字段 + 界面标题（query/userRequirements 等 prompt 字段被丢弃）", () => {
    const p = makeDb(makeSnapshot([SYNTH_TASK]));
    const r = new QoderSnapshotReader(p);
    const snap = r.read();
    expect(snap).not.toBeNull();
    expect(snap!.tasks).toHaveLength(1);
    const t = snap!.tasks[0];
    expect(t.canonicalId).toBe("task-aaaa1111bbbb2222cccc.session.execution");
    expect(t.taskId).toBe("task-aaaa1111bbbb2222cccc");
    expect(t.status).toBe("running");
    expect(t.workspacePath).toBe("/tmp/demo-ws");
    // 界面标题保留供本地面板展示（name 优先于 title）；原始 prompt/需求文本不得残留
    expect(t.displayName).toBe("synthetic-name");
    expect(JSON.stringify(t)).not.toContain("synthetic-prompt-text");
    expect(JSON.stringify(t)).not.toContain("synthetic-req");
    expect(r.health()).toBe("ok");
  });

  test("name 缺失回退 title，均缺失为 null", () => {
    const p = makeDb(makeSnapshot([{ ...SYNTH_TASK, name: "" }, { ...SYNTH_TASK, id: "task-2", name: undefined, title: undefined }]));
    const tasks = new QoderSnapshotReader(p).read()!.tasks;
    expect(tasks[0].displayName).toBe("synthetic-title");
    expect(tasks[1].displayName).toBeNull();
  });

  test("__virtual__ 目录任务 workspacePath 为 null", () => {
    const p = makeDb(makeSnapshot([SYNTH_TASK], "__virtual__"));
    const t = new QoderSnapshotReader(p).read()!.tasks[0];
    expect(t.workspacePath).toBeNull();
  });

  test("文件不存在 → not_detected，read 返回 null，不告警", () => {
    const r = new QoderSnapshotReader(join(dir, "nope.vscdb"));
    expect(r.read()).toBeNull();
    expect(r.health()).toBe("not_detected");
  });

  test("路径为 null（非 macOS 平台）→ not_detected", () => {
    const r = new QoderSnapshotReader(null);
    expect(r.read()).toBeNull();
    expect(r.health()).toBe("not_detected");
  });

  test("库存在但快照键缺失 → degraded", () => {
    const p = makeDb(null);
    const r = new QoderSnapshotReader(p);
    expect(r.read()).toBeNull();
    expect(r.health()).toBe("degraded");
  });

  test("快照 JSON 损坏 → degraded，不抛异常", () => {
    const p = makeDb("{broken-json");
    const r = new QoderSnapshotReader(p);
    expect(r.read()).toBeNull();
    expect(r.health()).toBe("degraded");
  });

  test("缺 id 的坏任务行跳过，其余正常解析", () => {
    const p = makeDb(makeSnapshot([{ status: "Running" }, SYNTH_TASK]));
    expect(new QoderSnapshotReader(p).read()!.tasks).toHaveLength(1);
  });
});
