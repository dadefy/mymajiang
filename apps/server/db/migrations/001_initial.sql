CREATE TABLE registration_applications (
  application_id UUID PRIMARY KEY,
  phone_fingerprint CHAR(64) NOT NULL,
  nickname VARCHAR(24) NOT NULL,
  avatar_url VARCHAR(500) NOT NULL,
  application_note VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason VARCHAR(200),
  submitted_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  reviewed_by VARCHAR(64)
);

CREATE UNIQUE INDEX registration_pending_phone_unique
  ON registration_applications (phone_fingerprint)
  WHERE status IN ('pending', 'approved');

CREATE TABLE users (
  user_id CHAR(10) PRIMARY KEY CHECK (user_id ~ '^[0-9]{10}$'),
  phone_fingerprint CHAR(64) NOT NULL UNIQUE,
  nickname VARCHAR(24) NOT NULL,
  avatar_url VARCHAR(500) NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN ('active', 'temporarily_banned', 'permanently_banned', 'deleted')),
  points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
  active_match_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE point_ledger (
  ledger_id UUID PRIMARY KEY,
  user_id CHAR(10) NOT NULL REFERENCES users(user_id),
  entry_type VARCHAR(24) NOT NULL CHECK (entry_type IN ('admin_adjustment', 'admin_reversal', 'match_settlement')),
  delta BIGINT NOT NULL CHECK (delta <> 0),
  balance_before BIGINT NOT NULL CHECK (balance_before >= 0),
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  reason VARCHAR(200) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  reversal_of UUID REFERENCES point_ledger(ledger_id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX point_ledger_user_time ON point_ledger (user_id, created_at DESC);

CREATE TABLE admin_audit_log (
  audit_id UUID PRIMARY KEY,
  action VARCHAR(40) NOT NULL CHECK (action IN ('account_status_change')),
  actor_id VARCHAR(64) NOT NULL,
  target_user_id CHAR(10) NOT NULL REFERENCES users(user_id),
  before_value JSONB NOT NULL,
  after_value JSONB NOT NULL,
  reason VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX admin_audit_log_target_time ON admin_audit_log (target_user_id, created_at DESC);
CREATE INDEX admin_audit_log_actor_time ON admin_audit_log (actor_id, created_at DESC);

CREATE TABLE friend_requests (
  request_id UUID PRIMARY KEY,
  requester_id CHAR(10) NOT NULL REFERENCES users(user_id),
  target_id CHAR(10) NOT NULL REFERENCES users(user_id),
  status VARCHAR(12) NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  CHECK (requester_id <> target_id)
);

CREATE UNIQUE INDEX friend_requests_pending_pair_unique
  ON friend_requests (LEAST(requester_id, target_id), GREATEST(requester_id, target_id))
  WHERE status = 'pending';

CREATE INDEX friend_requests_target_status_time
  ON friend_requests (target_id, status, created_at DESC);

CREATE TABLE friendships (
  user_low_id CHAR(10) NOT NULL REFERENCES users(user_id),
  user_high_id CHAR(10) NOT NULL REFERENCES users(user_id),
  source_request_id UUID NOT NULL UNIQUE REFERENCES friend_requests(request_id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_low_id, user_high_id),
  CHECK (user_low_id < user_high_id)
);

CREATE INDEX friendships_high_user ON friendships (user_high_id);

CREATE TABLE chat_groups (
  group_id UUID PRIMARY KEY,
  group_no CHAR(8) NOT NULL UNIQUE CHECK (group_no ~ '^[0-9]{8}$'),
  name VARCHAR(50) NOT NULL,
  owner_id CHAR(10) NOT NULL REFERENCES users(user_id),
  notice VARCHAR(500) NOT NULL DEFAULT '',
  all_muted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE group_members (
  group_id UUID NOT NULL REFERENCES chat_groups(group_id),
  user_id CHAR(10) NOT NULL REFERENCES users(user_id),
  role VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  muted_until TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE group_messages (
  message_id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES chat_groups(group_id),
  sender_id CHAR(10) NOT NULL REFERENCES users(user_id),
  message_type VARCHAR(16) NOT NULL CHECK (message_type IN ('text', 'image', 'voice', 'emoji', 'room_invite', 'system')),
  content TEXT NOT NULL,
  voice_seconds SMALLINT CHECK (voice_seconds BETWEEN 1 AND 60),
  sent_at TIMESTAMPTZ NOT NULL,
  recalled_at TIMESTAMPTZ,
  recalled_by VARCHAR(64)
);

CREATE INDEX group_messages_group_time ON group_messages (group_id, sent_at DESC);
