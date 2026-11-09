-- ============================================================
-- 003: 注册审核流（非幂等！只执行一次）
-- 用法: wrangler d1 execute mail_db --remote --file migrations/003_user_approval.sql
-- ============================================================

-- 用户状态：pending(待审核) | approved(已通过) | rejected(已拒绝)；新注册默认 pending
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'pending';

-- 审核动作令牌（邮件里的审核链接用，单次有效、7 天过期）
CREATE TABLE IF NOT EXISTS review_actions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 存量用户视为已通过（此 UPDATE 仅在迁移时执行一次，勿重复跑本文件！）
UPDATE users SET status = 'approved';
