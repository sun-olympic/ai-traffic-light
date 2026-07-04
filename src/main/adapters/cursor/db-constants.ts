// state.vscdb 的全部 SQL 与字段名集中于此（design.md Risks：逆向接口单点收敛）
// 禁止 LIKE 前缀扫描（实测 6.5s），只允许主键范围查询（实测 11~40ms）。

/** 气泡表主键范围查询：取某会话最新 N 条气泡的 toolFormerData 关键字段 */
export const BUBBLE_RANGE_SQL = `
  SELECT key,
         json_extract(value, '$.toolFormerData.name')   AS toolName,
         json_extract(value, '$.toolFormerData.status') AS status,
         json_extract(value, '$.toolFormerData.userDecision') AS userDecision,
         json_extract(value, '$.toolFormerData.additionalData.status') AS additionalStatus,
         json_extract(value, '$.toolFormerData.additionalData.blockReason') AS blockReason,
         json_extract(value, '$.toolFormerData.additionalData.reviewData.status') AS reviewStatus
  FROM cursorDiskKV
  WHERE key > ? AND key < ?
  ORDER BY rowid DESC
  LIMIT ?`;

export function bubbleRangeParams(sessionId: string, limit: number): [string, string, number] {
  return [`bubbleId:${sessionId}:`, `bubbleId:${sessionId}:zzzzzzzz`, limit];
}

/** composerData 元数据：会话名/创建时间（status 字段不实时，仅冷启动参考） */
export const COMPOSER_DATA_SQL = `
  SELECT json_extract(value, '$.name')      AS name,
         json_extract(value, '$.createdAt') AS createdAt,
         json_extract(value, '$.status')    AS status
  FROM cursorDiskKV
  WHERE key = ?`;

export function composerDataParams(sessionId: string): [string] {
  return [`composerData:${sessionId}`];
}

/** 冷启动兜底：最近更新的 N 个会话（composerData 前缀是短键空间，范围扫描代价可控） */
export const RECENT_SESSIONS_SQL = `
  SELECT substr(key, ${"composerData:".length + 1}) AS sessionId,
         json_extract(value, '$.name')          AS name,
         json_extract(value, '$.createdAt')     AS createdAt,
         json_extract(value, '$.lastUpdatedAt') AS lastUpdatedAt
  FROM cursorDiskKV
  WHERE key > 'composerData:' AND key < 'composerData:zzzzzzzz'
  ORDER BY lastUpdatedAt DESC
  LIMIT ?`;

/** 挂起等待（提问/审批）的统一判据字段值（实验实测，design.md Context 8/9） */
export const PENDING_ADDITIONAL_STATUS = "pending";
export const REVIEW_REQUESTED = "Requested";
export const DECISION_ACCEPTED = "accepted";
export const ASK_QUESTION_TOOL = "ask_question";
