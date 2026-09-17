-- 座位控制权 + 暂离标记。
--
-- 这两个字段回答的是**两个不同的问题**，所以不合成一个 status：
--
--   control  谁在操作这个座位
--            HUMAN   = 玩家自己操作
--            TRUSTEE = 服务器按 MahjongGame.autoAct() 的确定性策略代打
--
--   away     人在不在牌桌上（暂离 = 返回了大厅）
--
-- 与之并列的第三个维度「实时连接」（connected）**刻意不持久化**：
-- 进程重启后所有 socket 本来就不存在，此时"全部未连接"是事实而不是丢失。
-- 所以重启后出现 `connected = false` + `control = TRUSTEE` 是完全正常的状态，
-- 含义是「这个人现在没连上，但服务器应该继续替他打」。
--
-- control 的两条转换路径：
--   * 玩家主动点「退出游戏」      → HUMAN → TRUSTEE，立即生效，不等待 120 秒；
--   * 异常断线满 120 秒（无人回来）→ HUMAN → TRUSTEE。
--     120 秒是「人工控制权还给你留着」的期限，**不是**「禁止重新进入」的期限 ——
--     到期后玩家依然能回到这一局，只是要先点「重新接管」。
--   * 玩家点「重新接管」并通过服务端校验 → TRUSTEE → HUMAN。
--
-- ⚠️ 默认值的意义：历史数据与新建座位一律按「人工控制 + 未暂离」处理，
--    因此**不需要回头 UPDATE 任何既有行**。
-- ⚠️ 服务启动时**绝对不能**无条件把 active match 的 control 刷成 'human' ——
--    那会把托管状态清掉，正是这两个字段要解决的问题。

ALTER TABLE match_room_players
  ADD COLUMN control VARCHAR(16) NOT NULL DEFAULT 'human';

ALTER TABLE match_room_players
  ADD CONSTRAINT match_room_players_control_check CHECK (control IN ('human', 'trustee'));

ALTER TABLE match_room_players
  ADD COLUMN away BOOLEAN NOT NULL DEFAULT false;

-- 控制权最近一次变更的时刻。只用于排查与界面展示，不参与任何判断。
ALTER TABLE match_room_players
  ADD COLUMN control_changed_at TIMESTAMPTZ;
