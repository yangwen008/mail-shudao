-- ============================================================
-- 001: 会话令牌 / 限流 / 招标雷达 / 订阅  (幂等，可重复执行)
-- 用法: wrangler d1 execute mail_db --remote --file migrations/001_auth_radar.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket ON rate_limits (bucket, ts);

CREATE TABLE IF NOT EXISTS tenders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  industry_category TEXT DEFAULT 'IT',        -- IT | DESIGN | CONSTRUCT
  budget            TEXT DEFAULT '详见标书',
  region            TEXT DEFAULT '',
  source_platform   TEXT DEFAULT '自发库',
  source_url        TEXT DEFAULT '',
  contact_info      TEXT DEFAULT '',
  status            TEXT DEFAULT 'approved',  -- approved | pending
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tenders_category ON tenders (industry_category, status);

CREATE TABLE IF NOT EXISTS subscriptions (
  username         TEXT PRIMARY KEY,
  keywords         TEXT DEFAULT '',
  exclude_keywords TEXT DEFAULT '',
  push_strategy    INTEGER DEFAULT 1,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
