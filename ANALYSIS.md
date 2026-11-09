# mail-shudao 代码全量分析

> ⚠️ **2026-11-09 更新：下方第 7 节 P0/P1 问题已完成整改**，详见 README.md / DEPLOY.md。
> 45 项冒烟测试全部通过（tests/smoke.mjs）。待办：群邮件功能、雷达推送策略、已读未读/搜索/分页。

> 分析时间：2026-11-09 | 仓库：https://github.com/yangwen008/mail-shudao（单 commit `f685fac`）
> 部署：Cloudflare Workers + D1（`mail_db`）+ 静态 Assets（`./public`），自定义域 `mail.shudao.ai`
> 声明使用 R2，但当前代码/wrangler.toml **没有任何 R2 绑定**（附件走 base64 直传 Resend）

---

## 1. 整体架构

```
外部邮件 ──(Cloudflare Email Routing, MX)──▶ worker.email() ──解析MIME──▶ D1 emails 表
浏览器 ──▶ worker.fetch() ──▶ /api/* (JSON) ──▶ D1 / Resend API
                  └─▶ 其余路径 ──▶ env.assets (public/ 静态页)
发信 ──▶ /api/send ──▶ Resend (api.resend.com) ──成功后──▶ D1 存底稿
```

- 单文件 Worker：`src/index.js`（234 行），两个入口：
  - `email(message, env)`：Email Routing 收信钩子
  - `fetch(request, env)`：HTTP 网关（API + 静态资源回落）
- 前端：Vue 2.6 + axios（jsdelivr CDN），纯静态 HTML，无构建流程。

## 2. 文件清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/index.js` | Worker：收信 + 全部 API | 主逻辑 |
| `wrangler.toml` | D1 绑定 `DB`、assets、自定义域路由 | 现行 |
| `public/mail_login.html` | 邮箱登录（只有登录，无注册入口） | `/` 默认落地页 |
| `public/mail_index.html` | 邮箱主界面（收件/已发/星标/删除/写信） | 现行 |
| `public/login.html` | 旧版登录（带注册切换，登录后跳 `index.html`） | **遗留副本** |
| `public/index.html` | 旧版邮箱主界面（与 mail_index 几乎逐字相同） | **遗留副本** |
| `public/zb_login.html` | 招标雷达登录（带行情滚动装饰） | 现行（雷达系统） |
| `public/zb_index.html` | 招标雷达控制台 | **调用了 5 个不存在的 API** |

`mail_index.html` 与 `index.html` 是同一份代码的两份拷贝（仅跳转目标不同），维护时需双改，建议合并。

## 3. 数据结构（由代码反推的 D1 schema）

### users 表
| 列 | 类型 | 说明 |
|---|---|---|
| username | TEXT UNIQUE | 邮箱前缀（`@shudao.ai` 被代码剥掉），主键性质 |
| password_hash | TEXT | SHA-256( password + 固定盐 "ShuDaoSalt2026" ) |

### emails 表
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| to_address | TEXT | 完整收件地址，如 `foo@shudao.ai` |
| from_address | TEXT | 完整发件地址 |
| subject | TEXT | 已解码主题 |
| body_text | TEXT | 收信=去标签纯文本；发信=**原始富文本 HTML**（双重语义！） |
| received_at | TIMESTAMP | 默认 CURRENT_TIMESTAMP（推断） |
| is_starred | INTEGER 0/1 | 星标 |

**注意**：仓库里没有 schema.sql，以上是推断。建表语句需要你从 D1 控制台导出或补一份 migration。

### 命名约定（软删除机制）
- 删除 = 把地址改写成 `<user>_deleted@shudao.ai`（改 `to_address` 或 `from_address`）
- 回收站 = 查询 `to_address = ? OR from_address = ?`（查 `user_deleted@...`）
- 彻底删除 = `DELETE FROM emails WHERE id = ?`

## 4. API 一览（worker 已实现）

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/api/register` | 注册（用户名去域名后入库） | 无 |
| POST | `/api/login` | 登录（哈希比对；**含硬编码 admin 后门**） | — |
| GET | `/api/emails?username=&filter=` | 列表。filter: inbox/sent/trash/starred/vip | **无（信任参数）** |
| PATCH | `/api/emails/status` | {id, field, value}：星标/软删/彻底删/任意列更新 | **无** |
| POST | `/api/send` | 经 Resend 外发 + 存 D1 | 无 |
| GET | 其它 | `env.assets.fetch` 静态资源 | — |

**前端调用但 worker 不存在的 API**（zb_index.html）：
`/api/subscribe/get`、`/api/subscribe/save`、`/api/tenders/list`、`/api/tenders/create`、`/api/radar/force-trigger` —— 招标雷达后端尚未实现。

## 5. 收信流水线（email handler）

1. 取 `message.to / from / subject`（主题仅解 `=?UTF-8?B?..?=` base64）。
2. 读 `message.raw`，按 boundary 手工切 multipart。
3. 每段看 header：`text/html` / `text/plain`、`base64` 则解码。
4. 取 `plain || html`，`stripHtmlTags()` 去标签转纯文本。
5. `INSERT INTO emails`。

局限：不支持 quoted-printable、非 UTF-8 字符集、嵌套 multipart、附件落盘（R2 未用上）。

## 6. 发信流水线（/api/send）

1. 取 `from_user`→前缀，拼 `<user>@shudao.ai`。
2. 组装 Resend payload（from/to/subject/html + 附件 base64）。
3. POST Resend；成功后把**原始 HTML** 存进 `body_text`。
4. 已发送列表 = `from_address = user@... AND to NOT LIKE '%_deleted%'`。

## 7. 已发现的问题（按严重度）

### 🔴 P0 安全
1. **硬编码管理员后门口令**（src/index.js `/api/login`）：`admin` + 固定明文暗号直接放行。该代码在**公开 GitHub 仓库**中，等于全网皆知的万能密码。→ 必须删除并换用环境变量/管理员表；你已发布的任何凭据应视为泄露。
2. **无会话/令牌体系**：登录只回 `{success:true}`，前端把用户名存 localStorage，之后所有 API 靠 `?username=` 参数认人。任何人改参数即可读写任意邮箱（IDOR），PATCH 可改/删任意邮件。
3. **SQL 注入**：`/api/emails/status` 的 `field` 直接拼进 `UPDATE emails SET ${field} = ?`，攻击者可注入任意 SQL 片段。必须白名单字段。
4. **弱口令哈希**：SHA-256 + 全局固定盐（盐在公开仓库），可彩虹/暴力破解。应换 PBKDF2/bcrypt/scrypt（Workers 可用 WebCrypto PBKDF2）+ 每用户随机盐。
5. **无速率限制**：登录/注册/发信可无限调用（发信还会烧 Resend 配额、可被当垃圾邮件炮）。
6. CORS `*` 全开 + 无 CSRF 防护。

### 🟠 P1 功能缺陷
7. `filter=draft`（草稿箱）和 `group`（群邮件）UI 有入口但后端无实现，落到默认收件箱查询，显示错误数据。
8. 软删除判定 `from_address.includes(targetUser)` 是子串匹配：用户 `admin` 会误伤 `admin2` 的邮件；且改写地址对"已删除"过滤与展示互相靠字符串约定，脆弱。
9. `decodeMimeHeader` 只解 UTF-8 base64，`=??UTF-8?Q?..?=`（Q编码）和 GBK 等主题会乱码。
10. 收信只留纯文本，富文本/图片/附件全部丢失（R2 未接）。
11. `body_text` 一列双语义（收信纯文本 vs 发信 HTML），读信视图用 `v-html` 渲染 —— 发信内容回显时存在 XSS 注入面（尤其"再次编辑"把内容塞回 contenteditable）。
12. 登录页两套（login.html 有注册、mail_login.html 无注册），入口不一致；index.html/mail_index.html 双份拷贝。

### 🟡 P2 体验/工程质量
13. 前端所有交互用 `alert/confirm`；错误处理粗糙。
14. 无分页（`SELECT *` 全量）、无搜索、无已读/未读状态列。
15. 无 schema/migrations 文件、无 README、无测试、无 CI。
16. `wrangler.toml` 的 `ALLOWED_DOMAINS/DOMAINS` 变量代码中未使用。
17. `formatTime` 用本地时区拼"月日"，跨时区会偏。

## 8. 建议的演进路线

**第一批（安全止血）**
1. 删后门 + 口令换环境变量；口令哈希改 PBKDF2 + 随机盐。
2. 登录签发 session token（D1 sessions 表或 JWT + secret），所有 API 校验 token，废弃 `?username=` 认权。
3. `/api/emails/status` 字段白名单（`is_starred` 等）。
4. 登录/发信加限流（如 D1 计数或 Cloudflare WAF/Rate Limiting）。

**第二批（补全功能）**
5. 补 draft/group 后端；已读未读、搜索、分页。
6. MIME 解析升级（quoted-printable、Q编码、多字符集、附件）。
7. 附件落 R2（补 wrangler R2 绑定），emails 加 attachments 元数据列。
8. 招标雷达 5 个 API 的后端（tenders/subscribe 表 + 雷达抓取逻辑）。

**第三批（工程化）**
9. schema.sql/migrations 入库；合并重复 HTML；README；基础测试。
