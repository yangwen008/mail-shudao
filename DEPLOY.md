# mail-shudao 部署手册（DEPLOY.md）

## 一、前置条件
- Cloudflare 账户（Workers Paid 非必须，D1/R2 免费额度够用）
- 本机登录 wrangler：`npx wrangler login`
- 邮件收发依赖：Cloudflare Email Routing（shudao.ai 的 MX 指向 Cloudflare）+ Resend API Key

## 二、一次性准备

### 1. 创建 R2 桶（附件存储）
在 Cloudflare 控制台 R2 创建桶 **`mail-attachments`**（或改 `wrangler.toml` 里的 `bucket_name`）。
不建桶直接部署会绑定失败。

### 2. 执行数据库迁移（**先迁移后部署！**）

生产库已有 users/emails 旧表：
```bash
npx wrangler d1 execute mail_db --remote --file migrations/001_auth_radar.sql   # 幂等
npx wrangler d1 execute mail_db --remote --file migrations/002_emails_upgrade.sql  # ⚠️ 只执行一次
npx wrangler d1 execute mail_db --remote --file migrations/003_user_approval.sql   # ⚠️ 只执行一次（注册审核）
npx wrangler d1 execute mail_db --remote --file migrations/004_multi_domain.sql    # ⚠️ 只执行一次（多域名，必须在 003 后）
```

全新环境（本地开发/新库）：
```bash
npx wrangler d1 execute mail_db --local --file migrations/000_base_schema.sql
npx wrangler d1 execute mail_db --local --file migrations/001_auth_radar.sql
```

> 002 给 emails 增加 `body_html` / `attachments_json` / `is_draft` 三列；003 给 users 增加 `status` 列并建 `review_actions` 表。两者均**只执行一次**，重复执行会报 duplicate column（报错即忽略该条）。

### 3. 配置密钥
```bash
npx wrangler secret put RESEND_API_KEY    # 发信密钥
```

### 4.（可选）招标雷达情报源
`wrangler.toml` 的 `[vars]` 里取消注释并配置：
```toml
RADAR_SOURCES = "https://example.com/tenders.xml,https://example.org/feed"
```
逗号分隔的 RSS/Atom 地址；不配置时"全网雷达突击对账"只返回就绪提示。

## 三、部署
```bash
npx wrangler deploy
```

## 四、部署后验证清单
1. 打开 https://mail.shudao.ai/ → 落到登录页
2. 注册新账号 → 自动登录进入邮箱
3. **旧后门口令已失效**：用 admin + 旧暗号登录必须失败
4. 给 `任意用户@shudao.ai` 发一封外部邮件 → 收件箱出现（含附件可下载）
5. 网页写信发送 → 对方能收到
6. 草稿：写信 → 存草稿 → 草稿箱可见 → 再次编辑/删除
7. 招标雷达：`/zb_login.html` 登录 → `/zb_index.html` 发布/浏览项目
8. admin 账号：用注册创建（用户名 `admin`，密码自设）；非 admin 在雷达页发布应被拒
9. **注册审核**：新注册用户提示“等待审核”且无法登录 → `admin@shudao.ai` 邮箱收到【注册审核】通知 → 点“✅ 通过” → 二次确认页确认 → 申请人邮箱收到结果通知 → 可登录

## 五、安全说明（本次整改）
| 原问题 | 处置 |
|---|---|
| admin 硬编码后门口令 | **已删除**。管理员=正常注册的 `admin` 账号；旧暗号不可再登录 |
| 无会话，API 靠 username 参数认权 | 登录签发 30 天会话令牌（D1 sessions 表），全部 API 校验令牌 |
| `/api/emails/status` SQL 注入 | 字段白名单 + 归属校验（非本人邮件 403） |
| SHA-256+固定盐弱哈希 | PBKDF2-SHA256（10 万次迭代）+ 每用户随机盐；**存量旧哈希在用户下次登录时自动升级** |
| 无速率限制 | 注册/登录 10次/分钟/IP；发信 30次/小时/用户；雷达 5次/小时/用户 |
| 注册即用、无审核 | **注册审核流**：新用户 pending 状态不可登录，admin 邮箱收审核通知，链接单次有效 7 天过期，二次确认防邮件网关预取；结果通知回申请人 |

## 六、多域名架构（@shudao.ai / @zjd.cn / …）
- 账号身份 = **完整邮箱地址**：`bob@shudao.ai` 与 `bob@zjd.cn` 是完全独立的账号（独立密码/邮箱/审核）
- 允许域名白名单：`wrangler.toml` 的 `DOMAINS = "shudao.ai,zjd.cn"`，新增域名改这里即可
- 登录/注册页有域名下拉框（`GET /api/domains` 提供列表；默认域名按访问入口推断：mail.zjd.cn → zjd.cn）
- 注册审核按域名分发：`eve@zjd.cn` 的申请通知进 `admin@zjd.cn`；每个域名的首个 admin 自动通过
- 软删除地址约定随域名：`bob_deleted@zjd.cn`
- **新域名接入清单**：
  1. `DOMAINS` 白名单加域名 → 部署
  2. 绑定 `mail.<域名>` 自定义域（先清掉冲突 DNS 记录；wrangler.toml routes 里有注释模板）
  3. **收信**：该域名的 MX 指向 Cloudflare Email Routing
  4. **发信**：在 Resend 后台验证该域名（SPF/DKIM），否则外发会被拒
  5. 注册该域名的 `admin@<域名>` 账号（自动通过）
## 七、注册审核机制
- 新注册 → `users.status = 'pending'`，登录被 403 拦截
- 通知邮件自动投进 `admin@<申请人域名>` 收件箱（如 `admin@zjd.cn`），含 ✅通过 / ❌拒绝 链接
- 链接对应 `review_actions` 表一次性令牌：点开是确认页（防邮件安全网关自动预取误审），确认后才生效
- 通过 → 用户可登录；拒绝 → 永久拦截；结果都会发邮件通知申请人
- **引导规则**：空库首个注册用户 / 各域名首个 `admin` 账号自动通过（避免无人可审的死锁）；存量老用户迁移时已批量置为 approved
- 管理员可随时查待审列表：`GET /api/admin/pending`（需 admin 会话）

## 八、注意事项
- 老用户无需重置密码，登录成功即自动换新哈希；如需强制全员重置可清空 users.password_hash
- 存量 emails 的 `body_html` 为 NULL，读信时前端会按纯文本/旧 HTML 自动兼容
- 收信附件保存在 R2 `attachments/<uuid>/<文件名>`，下载需会话令牌 + 归属校验
- 群邮件功能目前返回空列表（UI 显示"暂未开放"），待后续实现
