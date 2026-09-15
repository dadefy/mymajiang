-- 进行中那一局的引擎状态快照，用于进程重启后接着打。
--
-- 单独一张表是有意的：这份数据在一局之内被高频覆盖（每次出牌、碰杠、响应都会写一次），
-- 一局结束就被丢弃或覆盖，不该混进 match_rooms 里。
--
-- state 里含牌墙与全部手牌，属于服务端机密，永远不能下发给客户端。
-- room_id 做主键：一个房间同时只有一局在进行。

CREATE TABLE match_round_states (
  room_id UUID PRIMARY KEY REFERENCES match_rooms(room_id),
  round_number SMALLINT NOT NULL CHECK (round_number BETWEEN 1 AND 8),
  state JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL
);
