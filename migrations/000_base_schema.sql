-- ============================================================
-- 000: 基础表结构（全新环境用；含升级后的完整列）
-- 本地开发: wrangler d1 execute mail_db --local --file migrations/000_base_schema.sql
-- 生产环境已有旧表，跳过本文件，只执行 001 + 002
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  to_address       TEXT NOT NULL,
  from_address     TEXT NOT NULL,
  subject          TEXT DEFAULT '(无主题)',
  body_text        TEXT DEFAULT '',
  body_html        TEXT,
  attachments_json TEXT,
  is_starred       INTEGER DEFAULT 0,
  is_draft         INTEGER DEFAULT 0,
  received_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emails_to   ON emails (to_address, received_at);
CREATE INDEX IF NOT EXISTS idx_emails_from ON emails (from_address, received_at);
