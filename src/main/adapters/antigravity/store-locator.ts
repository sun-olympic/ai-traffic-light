// Antigravity 本地存储定位（add-antigravity-support D1/D22/D23/D33/D35）。
// 单一职责：只负责 home 路径解析与 conversations/*.db 候选发现，不打开/不解析任何数据库内容。
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 发现的会话库候选；canonical session id = 文件 basename（design D4） */
export interface DbCandidate {
  sessionId: string;
  dbPath: string;
  /** max(db, -wal, -shm) 的 mtime（毫秒）——判断"是否变化/是否新鲜"的依据（D31/D35） */
  mtime: number;
  hasWal: boolean;
  /** inode：store epoch 指纹的一部分（APFS 替换/迁移检测，D29/D35） */
  ino: number;
}

/**
 * Antigravity home：环境变量覆盖优先（测试/非默认安装，D33）；默认仅 macOS（D23），
 * 其余平台 null = not detected。
 */
export function defaultAntigravityHome(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string | null {
  const override = env.TL_ANTIGRAVITY_HOME;
  if (override) return override;
  if (platform !== "darwin") return null;
  return path.join(os.homedir(), ".gemini/antigravity");
}

/** 每轮候选上限（D22 有界轮询）；超出的更旧库留给后续轮次（活跃库 mtime 靠前必然入选） */
const DEFAULT_CANDIDATE_CAP = 20;

/** lstat：不跟随符号链接（D35）；不存在/不可读返回 null */
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * 发现近期 conversations/*.db 候选：仅常规文件（忽略符号链接/目录），
 * 按 max(db/-wal/-shm) mtime 降序，cap 截断。不读文件内容。
 */
export function discoverCandidates(home: string, cap: number = DEFAULT_CANDIDATE_CAP): DbCandidate[] {
  const dir = path.join(home, "conversations");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: DbCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith(".db")) continue;
    const dbPath = path.join(dir, name);
    const st = lstatOrNull(dbPath);
    if (!st?.isFile()) continue;
    const wal = lstatOrNull(`${dbPath}-wal`);
    const shm = lstatOrNull(`${dbPath}-shm`);
    out.push({
      sessionId: name.slice(0, -3),
      dbPath,
      mtime: Math.max(st.mtimeMs, wal?.mtimeMs ?? 0, shm?.mtimeMs ?? 0),
      hasWal: wal !== null || shm !== null,
      ino: st.ino,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, cap);
}
