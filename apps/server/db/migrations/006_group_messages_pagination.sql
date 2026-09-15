-- B3 群消息分页：历史消息不再随启动全量载入，改为按时间窗（键集分页）按需读取。
-- 翻页键为 (sent_at, message_id)，需要一个「按群 + 发送时间」的复合索引才能稳定高效。

CREATE INDEX IF NOT EXISTS idx_group_messages_group_sent
  ON group_messages (group_id, sent_at DESC, message_id DESC);
