-- 管理员账号体系。
--
-- 在此之前管理员只是一个「能签出管理员 JWT 的能力」：没有账号、没有凭据，
-- 开发环境靠启动时打印一枚 2 小时令牌进后台 —— 任何能读到日志的人都能进管理后台。
--
-- 现在管理员是一等公民：有账号、有密码哈希（scrypt，明文不落库），登录后才能拿到令牌。
--
-- password_hash 存的是自描述串 `scrypt$N=...,r=...,p=...$salt$hash`，
-- 把参数一起写进去，将来调强参数时老哈希仍然可验证，可以逐个升级。
--
-- 失败次数与锁定不落库：单进程部署下进程内计数就够用，重启即清零本身就是合理的兜底。
-- 多实例部署时再改成共享存储（已记在文档的已知限制里）。

CREATE TABLE admin_accounts (
  admin_id VARCHAR(64) PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role VARCHAR(24) NOT NULL CHECK (role IN ('super_admin', 'review_admin')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
