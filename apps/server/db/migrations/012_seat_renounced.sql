-- 012: 座位的「主动退出」标记（renounced）。
--
-- 语义（2026-09-18 产品确认）：renounced=true 表示
--   「这个玩家当前仍处于一次明确的主动退出状态」，
-- 不是历史记录「这个人曾经点过退出」。
--
-- 写入点（与 packages/domain/src/rooms.ts 一一对应）：
--   * quitToTrustee()      → true  （WS quit 帧，明确的主动退出）；
--   * 120 秒保护期到期转托管 → false （网络断线 ≠ 主动退出）；
--   * resumeControl()      → false （重新接管，回到人工）；
--   * reconnect()          → false （真人重新进入牌局/重建连接，即使 control 仍是 trustee
--                                    —— 人回来了就不能再被视为「放弃了这场比赛」）。
--
-- additive：DEFAULT FALSE 让升级时所有进行中的牌局（包括历史上的 trustee 座位）
-- 全部回到「非主动退出」，绝不把历史托管误判成 quit。
ALTER TABLE match_room_players
  ADD COLUMN renounced BOOLEAN NOT NULL DEFAULT FALSE;
