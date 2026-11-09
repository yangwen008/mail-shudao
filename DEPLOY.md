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
```

全新环境（本地开发/新库）：
```bash
npx wrangler d1 execute mail_db --local --file migrations/000_base_schema.sql
npx wrangler d1 execute mail_db --local --file migrations/001_auth_radar.sql
```

> 002 给 emails 增加 `body_html` / `attachments_json` / `is_draft` 三列，重复执行会报 duplicate column（报错即忽略该条）。

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

## 五、安全说明（本次整改）
| 原问题 | 处置 |
|---|---|
| admin 硬编码后门口令 | **已删除**。管理员=正常注册的 `admin` 账号；旧暗号不可再登录 |
| 无会话，API 靠 username 参数认权 | 登录签发 30 天会话令牌（D1 sessions 表），全部 API 校验令牌 |
| `/api/emails/status` SQL 注入 | 字段白名单 + 归属校验（非本人邮件 403） |
| SHA-256+固定盐弱哈希 | PBKDF2-SHA256（10 万次迭代）+ 每用户随机盐；**存量旧哈希在用户下次登录时自动升级** |
| 无速率限制 | 注册/登录 10次/分钟/IP；发信 30次/小时/用户；雷达 5次/小时/用户 |

## 六、注意事项
- 老用户无需重置密码，登录成功即自动换新哈希；如需强制全员重置可清空 users.password_hash
- 存量 emails 的 `body_html` 为 NULL，读信时前端会按纯文本/旧 HTML 自动兼容
- 收信附件保存在 R2 `attachments/<uuid>/<文件名>`，下载需会话令牌 + 归属校验
- 群邮件功能目前返回空列表（UI 显示"暂未开放"），待后续实现
