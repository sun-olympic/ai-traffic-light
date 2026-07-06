// state.vscdb 的全部 SQL 与字段名集中于此（design.md Risks：逆向接口单点收敛）
// 禁止 LIKE 前缀扫描（实测 6.5s），只允许主键范围查询（实测 11~40ms）。

/** 气泡表主键范围查询：取某会话最新 N 条气泡的 toolFormerData 关键字段。
 * result 只对 ask_question 提取（空答案判定用）：其他工具的 result 可能是大段输出，无脑提取拖慢查询 */
export const BUBBLE_RANGE_SQL = `
  SELECT key,
         json_extract(value, '$.toolFormerData.name')   AS toolName,
         json_extract(value, '$.toolFormerData.status') AS status,
         json_extract(value, '$.toolFormerData.userDecision') AS userDecision,
         json_extract(value, '$.toolFormerData.additionalData.status') AS additionalStatus,
         json_extract(value, '$.toolFormerData.additionalData.blockReason') AS blockReason,
         json_extract(value, '$.toolFormerData.additionalData.reviewData.status') AS reviewStatus,
         CASE WHEN json_extract(value, '$.toolFormerData.name') = 'ask_question'
              THEN json_extract(value, '$.toolFormerData.result') END AS result
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

/**
 * composerHeaders 会话头（ItemTable 单键大 JSON，2026-07-05 实测）：
 * hasBlockingPendingActions 弹窗挂起标志（作答后 ~3s 翻 false，远快于气泡 pending 翻转的惰性落库）；
 * conversationCheckpointLastUpdatedAt 会话检查点时间（作答/编辑时前进）。
 * json_each 在 SQLite 内展开，避免 100KB+ 整块 JSON 每 tick 进 JS。
 */
export const COMPOSER_HEADER_SQL = `
  SELECT json_extract(j.value, '$.hasBlockingPendingActions')           AS blocking,
         json_extract(j.value, '$.conversationCheckpointLastUpdatedAt') AS checkpointAt
  FROM ItemTable, json_each(json_extract(ItemTable.value, '$.allComposers')) AS j
  WHERE ItemTable.key = 'composer.composerHeaders'
    AND json_extract(j.value, '$.composerId') = ?`;

/** 挂起等待（提问/审批）的统一判据字段值（实验实测，design.md Context 8/9） */
export const PENDING_ADDITIONAL_STATUS = "pending";
export const REVIEW_REQUESTED = "Requested";
export const DECISION_ACCEPTED = "accepted";
export const ASK_QUESTION_TOOL = "ask_question";
/** 提问表单"Other/自由输入"选项的占位 id（2026-07-06 实测）：result 里只有它且无文本 = 有效空答案 */
export const FREEFORM_OTHER_ID = "__freeform_other__";
