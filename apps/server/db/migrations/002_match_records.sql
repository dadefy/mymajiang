-- 房间、房间成员、单局记录，以及牌局结算与积分流水的关联。
-- 002 之前 point_ledger 只有管理员操作，没有房间维度；这里补上可空的 room_id。
-- 等待中的房间还没有固定座位，因此 match_room_players.seat 允许为空（PostgreSQL 的
-- UNIQUE 约束把多个 NULL 视为互不相同，所以等待中的房间可以多名成员同时没有座位）。

CREATE TABLE match_rooms (
  room_id UUID PRIMARY KEY,
  rule_version VARCHAR(40) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('waiting', 'playing', 'finished', 'dissolved')),
  owner_id CHAR(10) NOT NULL REFERENCES users(user_id),
  completed_rounds SMALLINT NOT NULL DEFAULT 0 CHECK (completed_rounds BETWEEN 0 AND 8),
  created_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  final_reason VARCHAR(16) CHECK (final_reason IN ('completed', 'dissolved'))
);

CREATE INDEX match_rooms_status_time ON match_rooms (status, created_at DESC);

CREATE TABLE match_room_players (
  room_id UUID NOT NULL REFERENCES match_rooms(room_id),
  user_id CHAR(10) NOT NULL REFERENCES users(user_id),
  seat SMALLINT CHECK (seat BETWEEN 0 AND 3),
  joined_at TIMESTAMPTZ NOT NULL,
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  opening_balance BIGINT,
  raw_delta BIGINT,
  account_delta BIGINT,
  PRIMARY KEY (room_id, user_id),
  UNIQUE (room_id, seat)
);

CREATE INDEX match_room_players_user_time ON match_room_players (user_id, joined_at DESC);

CREATE TABLE match_rounds (
  round_id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES match_rooms(room_id),
  round_number SMALLINT NOT NULL CHECK (round_number BETWEEN 1 AND 8),
  finish_reason VARCHAR(24) NOT NULL CHECK (finish_reason IN ('three-winners', 'wall-exhausted')),
  winner_seats JSONB NOT NULL,
  next_dealer_seat SMALLINT NOT NULL CHECK (next_dealer_seat BETWEEN 0 AND 3),
  deltas JSONB NOT NULL,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  finished_at TIMESTAMPTZ NOT NULL,
  UNIQUE (room_id, round_number)
);

CREATE INDEX match_rounds_room_number ON match_rounds (room_id, round_number);

-- 牌局结算写入的积分流水回指产生它的房间；管理员流水保持为空。
ALTER TABLE point_ledger ADD COLUMN room_id UUID REFERENCES match_rooms(room_id);

CREATE INDEX point_ledger_room_time ON point_ledger (room_id, created_at DESC)
  WHERE room_id IS NOT NULL;
