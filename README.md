# 蜀道AI邮箱 + 招标雷达 (mail-shudao)

Cloudflare Workers 全栈应用：邮件收发（Email Routing + Resend）+ 招标情报雷达。

- 线上：https://mail.shudao.ai/ （多域名：mail.zjd.cn 等，见 DEPLOY.md 接入清单）
- 架构：Workers（`src/index.js`）+ D1（用户/邮件/会话/招标）+ R2（附件）+ 静态 Vue2 页面（`public/`）
- **多域名**：账号 = 完整地址（`bob@shudao.ai` 与 `bob@zjd.cn` 独立），域名白名单在 wrangler.toml `DOMAINS`

## 目录
```
src/index.js            Worker：收信钩子 + 全部 API
public/                 静态前端（Vue2 + axios）
  index.html            智能入口（有令牌→邮箱，无→登录）
  mail_login.html       邮箱登录/注册
  mail_index.html       邮箱主界面（收件/已发/草稿/星标/回收站/写信/附件）
  zb_login.html         招标雷达登录
  zb_index.html         招标雷达控制台
  login.html            旧路径跳转桩 → /mail_login.html
migrations/             D1 迁移（000 全新建表 / 001 会话与雷达 / 002 存量升级）
tests/smoke.mjs         冒烟测试（45 项断言）
DEPLOY.md               部署手册
ANALYSIS.md             代码分析与问题清单
```

## 本地开发
```bash
npx wrangler d1 execute mail_db --local --file migrations/000_base_schema.sql
npx wrangler d1 execute mail_db --local --file migrations/001_auth_radar.sql
npx wrangler dev            # http://localhost:8787
node tests/smoke.mjs        # 需先在本地库注入测试数据（见脚本头部）
```

## API 一览
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/domains | 公开 | 域名白名单 + 默认域名（按访问入口推断） |
| POST | /api/register | 限流 | 注册（新用户进审核流，引导账号自动通过） |
| POST | /api/login | 限流 | 登录（仅 approved 账号），返回会话令牌 |
| GET | /api/admin/review?token&decision | 链接 | 审核二次确认页（防预取） |
| POST | /api/admin/review | 链接令牌 | 执行通过/拒绝，通知申请人 |
| GET | /api/admin/pending | admin | 待审用户列表 |
| POST | /api/logout | 令牌 | 注销会话 |
| GET | /api/me | 令牌 | 当前用户 |
| GET | /api/emails?filter= | 令牌 | inbox/sent/draft/trash/starred/vip/group |
| PATCH | /api/emails/status | 令牌+归属 | 星标/软删/彻底删（字段白名单） |
| POST | /api/send | 令牌+限流 | Resend 外发 + 存底稿 |
| POST | /api/drafts/save | 令牌 | 保存/更新草稿 |
| GET | /api/attachments?key= | 令牌+归属 | R2 附件下载 |
| GET | /api/tenders/list?category= | 公开 | 招标列表（admin 可见 pending） |
| POST | /api/tenders/create | admin | 发布招标 |
| GET/POST | /api/subscribe/get\|save | 令牌 | 雷达订阅策略 |
| POST | /api/radar/force-trigger | 令牌+限流 | 抓取 RADAR_SOURCES 情报源 |

## 安全机制
- 口令：PBKDF2-SHA256（100k 迭代）+ 每用户随机盐；旧 SHA-256 哈希登录时自动升级
- 会话：30 天 Bearer 令牌（D1 sessions），全部 API 服务端认权
- HTML：入库/出库双重脱敏（script/事件属性/危险协议剥离）
- 限流：注册/登录 10/min/IP，发信 30/h/用户
- 注册审核：新用户 pending 不可登录；admin 邮箱收✅/❌一次性审核链接（确认页防邮件网关预取），结果通知申请人
