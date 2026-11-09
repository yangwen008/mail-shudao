-- ============================================================
-- 002: emails 表升级（非幂等！只执行一次）
-- 用法: wrangler d1 execute mail_db --remote --file migrations/002_emails_upgrade.sql
-- 如果某列已存在会报 duplicate column，跳过该条即可
-- ============================================================

-- 发信富文本（服务端已脱敏）；收信富文本后续接入
ALTER TABLE emails ADD COLUMN body_html TEXT;

-- 收信附件元数据 JSON: [{filename, key, size, mime}]
ALTER TABLE emails ADD COLUMN attachments_json TEXT;

-- 草稿标记：1=草稿（不参与已发送/收件箱）
ALTER TABLE emails ADD COLUMN is_draft INTEGER DEFAULT 0;
