-- 解散群改为软删除。
--
-- 在此之前 dissolveGroup 是硬删除：先删 group_messages、group_members，再删 chat_groups。
-- 结果是群一解散，全部历史消息随群一起消失，谁也无从查证 —— 群主误操作也救不回来。
--
-- 现在只打一个时间戳，群、成员与消息都留在库里：
--   * 群列表、进群、发言、群管理一律拒绝已解散的群（在领域层判断）；
--   * 但历史消息仍可读 —— `/v1/groups/:groupId/messages` 只要求「是群成员」，
--     而成员行不再被删除，所以解散前在群里的人还能回看。
-- 这样「解散」在用户看来仍然是群没了，但对数据是可追溯的。
--
-- 可空列，对已有数据无影响：NULL 表示群还在。

ALTER TABLE chat_groups ADD COLUMN dissolved_at TIMESTAMPTZ;
