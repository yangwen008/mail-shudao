-- ============================================================
-- 004: 多域名架构（非幂等！只执行一次，且必须在 003 之后）
-- 用法: wrangler d1 execute mail_db --remote --file migrations/004_multi_domain.sql
--
-- 账号身份从"用户名前缀"升级为"完整邮箱地址"：
--   旧: username = 'bob'            （域名写死 shudao.ai）
--   新: username = 'bob@shudao.ai'  （bob@zjd.cn 是独立账号）
-- ============================================================

-- 重建 users 表（SQLite 无法直接改主键）
CREATE TABLE IF NOT EXISTS users_v2 (
  username      TEXT PRIMARY KEY,        -- 完整地址 user@domain
  password_hash TEXT NOT NULL,
  status        TEXT DEFAULT 'pending'   -- pending | approved | rejected
);

INSERT INTO users_v2 (username, password_hash, status)
SELECT CASE WHEN username LIKE '%@%' THEN username ELSE username || '@shudao.ai' END,
       password_hash,
       COALESCE(status, 'pending')
FROM users;

DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

-- 会话与审核令牌同步升级为完整地址
UPDATE sessions SET username = CASE WHEN username LIKE '%@%' THEN username ELSE username || '@shudao.ai' END;

UPDATE review_actions SET username = CASE WHEN username LIKE '%@%' THEN username ELSE username || '@shudao.ai' END;
