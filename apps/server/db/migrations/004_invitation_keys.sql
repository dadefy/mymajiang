-- 内测不再使用手机短信验证码，也不再有注册申请与人工审核：
-- 由开发方签发一次性邀请密钥，内测用户拿密钥首次激活即建立账号，之后同一把密钥就是该账号的登录凭据。
--
-- 绑定关系存在 users.invitation_key_hash 上，而不是存在密钥表里：
--   * UNIQUE 约束天然保证「一把密钥只能建立一个账号」，不依赖应用层检查；
--   * 激活账号只需要一次 INSERT，不存在「密钥写成功但账号没写」的中间状态。
-- invitation_keys 只负责发放与撤销的账目，明文不落库。
--
-- phone_fingerprint 随验证码一起退出：没有短信就没有可信的手机号，留着它只会逼新账号填假数据。
-- registration_applications 的唯一写入方是已删除的申请接口。

CREATE TABLE invitation_keys (
  key_id UUID PRIMARY KEY,
  key_hash CHAR(64) NOT NULL UNIQUE,
  key_hint VARCHAR(16) NOT NULL,
  note VARCHAR(100) NOT NULL DEFAULT '',
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR(64)
);

CREATE INDEX invitation_keys_created ON invitation_keys (created_at DESC);

ALTER TABLE users ADD COLUMN invitation_key_hash CHAR(64) UNIQUE;
ALTER TABLE users DROP COLUMN phone_fingerprint;

DROP TABLE registration_applications;
