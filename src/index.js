// ============================================================
// 蜀道AI邮箱 + 招标雷达 Worker
// 改造要点：
//   1. 登录签发会话令牌（D1 sessions），所有 API 以令牌认权（修复 IDOR）
//   2. 口令改 PBKDF2 + 每用户随机盐（兼容旧 SHA-256 哈希，登录时自动升级）
//   3. 删除硬编码后门；管理员 = 会话用户名 admin
//   4. /api/emails/status 字段白名单（修复 SQL 注入）
//   5. 登录/发信限流（D1 rate_limits）
//   6. 软删除按精确地址匹配（修复子串误伤）
//   7. MIME 解析升级：Q编码/多字符集/quoted-printable/附件落 R2
//   8. body_text(纯文本预览) 与 body_html(脱敏富文本) 分离（修复 XSS 面）
//   9. 草稿箱后端；群邮件返回空集（不再误显收件箱数据）
//  10. 招标雷达 5 个 API 后端（tenders/subscriptions/radar）
// ============================================================

// ==================== 第一部分：口令与令牌 ====================

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return Uint8Array.from(bin, m => m.codePointAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// PBKDF2 派生（WebCrypto，Workers 原生可用）
async function pbkdf2(password, saltHex, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
    keyMaterial, 256
  );
  return toHex(new Uint8Array(bits));
}

// 新口令存储格式: pbkdf2$<iterations>$<saltHex>$<hashHex>
async function createPasswordHash(password) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

// 旧版哈希（仅用于存量用户迁移比对，不再用于新口令）
async function legacyHash(password) {
  const msgBuffer = new TextEncoder().encode(password + "ShuDaoSalt2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return toHex(new Uint8Array(hashBuffer));
}

// 校验口令；返回 "ok-new" | "ok-legacy" | false
async function verifyPassword(password, stored) {
  if (!stored) return false;
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const [, iter, salt, hash] = parts;
    const calc = await pbkdf2(password, salt, parseInt(iter, 10) || PBKDF2_ITERATIONS);
    return timingSafeEqual(calc, hash) ? "ok-new" : false;
  }
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const calc = await legacyHash(password);
    return timingSafeEqual(calc, stored.toLowerCase()) ? "ok-legacy" : false;
  }
  return false;
}

// ==================== 第二部分：会话与限流 ====================

async function createSession(env, username) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(token, username, now, now + SESSION_TTL_MS).run();
  // 顺手清理过期会话
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return token;
}

async function getSessionUser(env, request) {
  const auth = request.headers.get("Authorization") || "";
  let token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) token = new URL(request.url).searchParams.get("token") || "";
  if (!token) return null;
  try {
    const row = await env.DB.prepare("SELECT username, expires_at FROM sessions WHERE token = ?").bind(token).first();
    if (!row || row.expires_at < Date.now()) return null;
    return row.username;
  } catch { return null; }
}

function sessionToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return new URL(request.url).searchParams.get("token") || "";
}

// 限流：bucket 内 windowMs 时间窗最多 limit 次
async function rateLimit(env, bucket, limit, windowMs) {
  const now = Date.now();
  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE ts < ?").bind(now - 86400000).run();
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate_limits WHERE bucket = ? AND ts > ?")
      .bind(bucket, now - windowMs).first();
    if (row && row.c >= limit) return false;
    await env.DB.prepare("INSERT INTO rate_limits (bucket, ts) VALUES (?, ?)").bind(bucket, now).run();
    return true;
  } catch { return true; } // 限流表异常时不阻断业务
}

// ==================== 第三部分：MIME 解析与安全脱水 ====================

function decodeBytes(bytes, charset) {
  const candidates = [charset, "utf-8", "gb18030", "latin1"];
  for (const label of candidates) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(bytes); } catch { /* 试下一个 */ }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeQuotedPrintable(str) {
  const s = str.replace(/=\r?\n/g, ""); // 软换行
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// 解 MIME 编码头（=?charset?B|Q?...?=），支持 Q 编码与多字符集
function decodeMimeHeader(headerText) {
  if (!headerText) return "";
  return headerText.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, text) => {
    try {
      const bytes = enc.toUpperCase() === "B"
        ? base64ToBytes(text)
        : decodeQuotedPrintable(text.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    } catch { return m; }
  });
}

function getParam(headerValue, paramName) {
  if (!headerValue) return "";
  const m = headerValue.match(new RegExp(paramName + "\\s*=\\s*(?:\"([^\"]*)\"|([^;\\s]+))", "i"));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : "";
}

function stripHtmlTags(htmlStr) {
  if (!htmlStr) return "";
  let text = htmlStr;
  text = text.replace(/<(br|\/p|\/div|\/tr|\/h[1-6])[^>]*>/gi, "\n");
  text = text.replace(/<(p|div|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return text.split("\n").map(line => line.trim()).filter(line => line !== "").join("\n");
}

// 服务端 HTML 脱敏：去掉脚本/事件属性/危险协议（存入 body_html 前必过）
function sanitizeHtml(html) {
  if (!html) return "";
  let out = String(html);
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/<\s*\/?\s*(script|iframe|object|embed|form|base|meta|link)[^>]*>/gi, "");
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/(href|src|action|formaction)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"');
  return out;
}

// ==================== 第四部分：收信流水线（email 入口） ====================

function extractMimeParts(rawText) {
  const headerEnd = rawText.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd >= 0 ? rawText.slice(0, headerEnd) : "";
  const bodyAll = headerEnd >= 0 ? rawText.slice(headerEnd).replace(/^\r?\n\r?\n/, "") : rawText;
  const unfoldedHeaders = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const contentType = (unfoldedHeaders.match(/^content-type:\s*(.+)$/im) || [, ""])[1].trim();

  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
    || rawText.match(/boundary="?([^"\r\n]+)"?/i);

  const parts = [];
  if (boundaryMatch) {
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const chunks = rawText.split("--" + boundary);
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed || trimmed === "--") continue;
      const sep = chunk.search(/\r?\n\r?\n/);
      let partHeaders = "", partBody = chunk;
      if (sep >= 0) {
        partHeaders = chunk.slice(0, sep).replace(/\r?\n[ \t]+/g, " ");
        partBody = chunk.slice(sep).replace(/^\r?\n\r?\n/, "");
      }
      partBody = partBody.replace(/\s+$/, "");
      parts.push({ headers: partHeaders.toLowerCase(), rawHeaders: partHeaders, body: partBody });
    }
  } else {
    parts.push({ headers: unfoldedHeaders.toLowerCase(), rawHeaders: unfoldedHeaders, body: bodyAll });
  }
  return parts;
}

function decodePartBody(body, cte) {
  const enc = (cte || "7bit").toLowerCase();
  if (enc.includes("base64")) return base64ToBytes(body);            // bytes
  if (enc.includes("quoted-printable")) return decodeQuotedPrintable(body); // bytes
  return null; // 未编码：直接按文本处理
}

function bytesToLatin1Str(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export default {
  // 1. 边缘端 MX 收信：解析 MIME（含附件）→ D1 + R2
  async email(message, env, ctx) {
    const to_address = message.to;
    const from_address = message.from;
    const subject = decodeMimeHeader(message.headers.get("subject") || "") || "(无主题)";

    let body_text = "";
    let body_html = "";
    const attachmentsMeta = [];

    try {
      const rawText = await new Response(message.raw).text();
      const parts = extractMimeParts(rawText);

      for (const part of parts) {
        const ct = (part.headers.match(/^content-type:\s*(.+)$/im) || [, "text/plain"])[1].trim();
        const cte = (part.headers.match(/^content-transfer-encoding:\s*(.+)$/im) || [, "7bit"])[1].trim();
        const disposition = (part.headers.match(/^content-disposition:\s*(.+)$/im) || [, ""])[1].trim();
        const mainType = ct.split(";")[0].trim().toLowerCase();
        const charset = getParam(ct, "charset") || "utf-8";
        const filename = decodeMimeHeader(getParam(disposition, "filename") || getParam(ct, "name") || "");

        const isAttachment = disposition.toLowerCase().includes("attachment")
          || (!!filename && !mainType.startsWith("text/"))
          || (!mainType.startsWith("text/") && mainType !== "multipart/alternative");

        if (isAttachment) {
          // 附件 → R2（未绑定 R2 时跳过，不阻断收信）
          if (env.ATTACHMENTS) {
            try {
              const bytes = decodePartBody(part.body, cte) || new TextEncoder().encode(part.body);
              const safeName = (filename || "attachment").replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
              const key = `attachments/${crypto.randomUUID()}/${safeName}`;
              await env.ATTACHMENTS.put(key, bytes, {
                httpMetadata: { contentType: mainType || "application/octet-stream" }
              });
              attachmentsMeta.push({ filename: safeName, key, size: bytes.length, mime: mainType });
            } catch (e) { console.error("附件入库失败:", e.message); }
          }
          continue;
        }

        if (mainType === "text/html" || mainType === "text/plain") {
          const decodedBytes = decodePartBody(part.body, cte);
          const text = decodedBytes ? decodeBytes(decodedBytes, charset) : part.body;
          if (mainType === "text/html") body_html = sanitizeHtml(text);
          else if (!body_text) body_text = text;
        }
      }

      if (!body_text) body_text = body_html ? stripHtmlTags(body_html) : "[邮件内容为空]";
    } catch (err) {
      body_text = `[邮件解析异常]: ${err.message}`;
    }

    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text, body_html, attachments_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      to_address, from_address, subject, body_text,
      body_html || null,
      attachmentsMeta.length ? JSON.stringify(attachmentsMeta) : null
    ).run();
  },

  // 2. HTTP 网关
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "Content-Type": "application/json", ...corsHeaders }
    });

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const getJson = async () => { try { return await request.json(); } catch { return {}; } };
    const ip = request.headers.get("cf-connecting-ip") || "unknown";

    // 审核页壳（浏览器打开的 HTML，非 JSON）
    const reviewPage = (inner) => new Response(
      `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>蜀道AI邮箱 - 注册审核</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1e293b;padding:40px 48px;border-radius:12px;text-align:center;max-width:440px;line-height:1.8}button{padding:12px 28px;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin:8px}.ok{background:#2563eb;color:#fff}.no{background:#475569;color:#fff}</style></head><body><div class="card">${inner}</div></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );

    // 首页 → 邮局登录（/index.html 等旧路径由静态跳转桩接管）
    if (url.pathname === "/") {
      return env.assets.fetch(new Request(new URL("/mail_login.html", request.url)));
    }

    // ==================== 账号体系 ====================

    if (url.pathname === "/api/register" && request.method === "POST") {
      if (!(await rateLimit(env, `register:${ip}`, 10, 60000))) return json({ success: false, message: "操作过于频繁，请稍后再试" }, 429);
      const { username, password } = await getJson();
      const cleanUser = username ? username.split("@")[0].trim() : "";
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(cleanUser)) return json({ success: false, message: "账号仅允许字母/数字/._- 且不超过64位" }, 400);
      if (!password || password.length < 6) return json({ success: false, message: "密码至少 6 位" }, 400);
      try {
        const secureHash = await createPasswordHash(password);

        // ---- 注册审核策略：新用户默认 pending；引导场景自动通过 ----
        let status = "pending";
        const total = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
        const adminExists = await env.DB.prepare("SELECT username FROM users WHERE username = 'admin'").first();
        if ((total && total.c === 0) || (cleanUser === "admin" && !adminExists)) {
          status = "approved"; // 系统引导：首个注册用户 / 首个 admin 自动通过，避免无人可审的死锁
        }
        await env.DB.prepare("INSERT INTO users (username, password_hash, status) VALUES (?, ?, ?)")
          .bind(cleanUser, secureHash, status).run();

        if (status === "approved") {
          const token = await createSession(env, cleanUser);
          return json({ success: true, token, username: cleanUser });
        }

        // ---- 待审核：生成一次性审核动作，通知送进 admin 管理员邮箱 ----
        const reviewToken = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const now = Date.now();
        await env.DB.prepare("INSERT INTO review_actions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)")
          .bind(reviewToken, cleanUser, now, now + 7 * 24 * 3600 * 1000).run();

        const approveUrl = `${url.origin}/api/admin/review?token=${reviewToken}&decision=approve`;
        const rejectUrl = `${url.origin}/api/admin/review?token=${reviewToken}&decision=reject`;
        const notifyHtml = `<p>新用户 <b>${cleanUser}</b> 申请注册 <b>${cleanUser}@shudao.ai</b> 邮箱账号。</p>
          <p>请审核：</p>
          <p><a href="${approveUrl}">✅ 通过</a> &nbsp;|&nbsp; <a href="${rejectUrl}">❌ 拒绝</a></p>
          <p style="color:#94a3b8;font-size:12px;">链接 7 天内有效且仅可使用一次；点击后需在页面确认，防止邮件安全网关误触。</p>`;
        await env.DB.prepare(
          "INSERT INTO emails (to_address, from_address, subject, body_text, body_html, is_draft) VALUES ('admin@shudao.ai', 'system@shudao.ai', ?, ?, ?, 0)"
        ).bind(`【注册审核】${cleanUser} 申请开通邮箱`, stripHtmlTags(notifyHtml), sanitizeHtml(notifyHtml)).run();

        return json({ success: true, pending: true, message: "注册申请已提交，请等待管理员审核通过后再登录" });
      } catch {
        return json({ success: false, message: "账号前缀已被占用" }, 400);
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!(await rateLimit(env, `login:${ip}`, 10, 60000))) return json({ success: false, message: "尝试过于频繁，请稍后再试" }, 429);
      const { username, password } = await getJson();
      const cleanUser = username ? username.split("@")[0].trim() : "";
      try {
        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(cleanUser).first();
        if (user) {
          const verdict = await verifyPassword(password, user.password_hash);
          if (verdict) {
            // 注册审核门禁：未通过审核不发会话
            if (user.status === "pending") {
              return json({ success: false, message: "注册申请审核中，请等待管理员通过后再登录" }, 403);
            }
            if (user.status === "rejected") {
              return json({ success: false, message: "注册申请未通过审核" }, 403);
            }
            // 存量旧哈希 → 登录成功时静默升级为 PBKDF2
            if (verdict === "ok-legacy") {
              try {
                const upgraded = await createPasswordHash(password);
                await env.DB.prepare("UPDATE users SET password_hash = ? WHERE username = ?").bind(upgraded, cleanUser).run();
              } catch { /* 升级失败不影响本次登录 */ }
            }
            const token = await createSession(env, cleanUser);
            return json({ success: true, token, username: cleanUser });
          }
        }
      } catch (dbErr) {
        console.error("D1 登录查询异常:", dbErr.message);
      }
      return json({ success: false, message: "账号或密码错误" }, 401);
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      const token = sessionToken(request);
      if (token) {
        try { await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run(); } catch { }
      }
      return json({ success: true });
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false }, 401);
      return json({ success: true, username: user });
    }

    // ==================== 注册审核（管理员邮箱链接流） ====================

    // 管理员点邮件链接 → 二次确认页（防邮件网关预取自动通过）
    if (url.pathname === "/api/admin/review" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const decision = url.searchParams.get("decision") === "reject" ? "reject" : "approve";
      const row = await env.DB.prepare("SELECT * FROM review_actions WHERE token = ?").bind(token).first();
      if (!row || row.expires_at < Date.now()) {
        return reviewPage(`<h2>⚠️ 链接无效或已过期</h2><p>请在管理员邮箱中重新处理，或让申请人重新注册。</p>`);
      }
      const label = decision === "reject" ? "拒绝" : "通过";
      return reviewPage(`
        <h2>📋 注册审核</h2>
        <p>申请人：<b style="font-size:22px;">${row.username}</b>@shudao.ai</p>
        <p>确认<b>${label}</b>该用户的注册申请？</p>
        <form method="POST" action="/api/admin/review">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="decision" value="${decision}">
          <button class="${decision === "reject" ? "no" : "ok"}" type="submit">确认${label}</button>
        </form>`);
    }

    // 确认页提交 → 生效并通知申请人
    if (url.pathname === "/api/admin/review" && request.method === "POST") {
      let params = {};
      try {
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("form-urlencoded") || ct.includes("multipart/form-data")) {
          params = Object.fromEntries((await request.formData()).entries());
        } else {
          params = await getJson();
        }
      } catch { params = {}; }
      const token = String(params.token || "");
      const decision = params.decision === "reject" ? "rejected" : "approved";

      const row = await env.DB.prepare("SELECT * FROM review_actions WHERE token = ?").bind(token).first();
      if (!row || row.expires_at < Date.now()) {
        return reviewPage(`<h2>⚠️ 链接无效或已过期</h2>`);
      }
      await env.DB.prepare("UPDATE users SET status = ? WHERE username = ? AND status = 'pending'")
        .bind(decision, row.username).run();
      await env.DB.prepare("DELETE FROM review_actions WHERE username = ?").bind(row.username).run();

      // 结果通知回申请人邮箱
      const label = decision === "approved" ? "已通过" : "未通过";
      const bodyHtml = decision === "approved"
        ? `<p>您的注册申请<b>已通过</b>！现在可以用 <b>${row.username}</b> 登录蜀道AI邮箱。</p>`
        : `<p>很遗憾，您的注册申请<b>未通过</b>审核。如有疑问请联系管理员。</p>`;
      await env.DB.prepare(
        "INSERT INTO emails (to_address, from_address, subject, body_text, body_html, is_draft) VALUES (?, 'system@shudao.ai', ?, ?, ?, 0)"
      ).bind(`${row.username}@shudao.ai`, `【注册审核】申请${label}`, stripHtmlTags(bodyHtml), sanitizeHtml(bodyHtml)).run();

      return reviewPage(`<h2>✅ 操作完成</h2><p>用户 <b>${row.username}</b> 的注册申请已<b>${label}</b>。</p><p>结果已通知至申请人邮箱。</p>`);
    }

    // 管理员：待审列表（供面板/程序化查询）
    if (url.pathname === "/api/admin/pending" && request.method === "GET") {
      const user = await getSessionUser(env, request);
      if (user !== "admin") return json({ success: false, message: "仅管理员可用" }, 403);
      const { results } = await env.DB.prepare("SELECT username, status FROM users WHERE status = 'pending' ORDER BY username").all();
      return json(results);
    }

    // ==================== 邮件 API（一律以会话认权） ====================

    if (url.pathname === "/api/emails" && request.method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);

      const filter = url.searchParams.get("filter") || "inbox";
      const userAddress = `${user}@shudao.ai`;
      const deletedAddress = `${user}_deleted@shudao.ai`;
      let sql = "", params = [];

      if (filter === "trash") {
        sql = "SELECT * FROM emails WHERE to_address = ? OR from_address = ? ORDER BY received_at DESC";
        params = [deletedAddress, deletedAddress];
      } else if (filter === "sent") {
        // 排除已被收件人软删除的信（地址被改写为 *_deleted@shudao.ai）
        sql = "SELECT * FROM emails WHERE from_address = ? AND is_draft = 0 AND to_address NOT LIKE '%\\_deleted@shudao.ai' ESCAPE '\\' ORDER BY received_at DESC";
        params = [userAddress];
      } else if (filter === "draft") {
        sql = "SELECT * FROM emails WHERE from_address = ? AND is_draft = 1 ORDER BY received_at DESC";
        params = [userAddress];
      } else if (filter === "group") {
        // 群邮件功能尚未开放：返回空集，避免误显其他文件夹数据
        return json([]);
      } else if (filter === "starred" || filter === "vip") {
        sql = "SELECT * FROM emails WHERE (to_address = ? OR from_address = ?) AND is_starred = 1 AND is_draft = 0 ORDER BY received_at DESC";
        params = [userAddress, userAddress];
      } else {
        sql = "SELECT * FROM emails WHERE to_address = ? AND from_address <> ? AND is_draft = 0 ORDER BY received_at DESC";
        params = [userAddress, userAddress];
      }
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      // 出口侧再脱敏一次（纵深防御：存量数据/绕过入口的数据也安全）
      for (const row of results) {
        if (row.body_html) row.body_html = sanitizeHtml(row.body_html);
      }
      return json(results);
    }

    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);

      const body = await getJson();
      const id = parseInt(body.id, 10);
      const field = String(body.field || "");
      const value = body.value;
      if (!Number.isInteger(id) || id <= 0) return json({ success: false, message: "无效的邮件ID" }, 400);

      const userAddress = `${user}@shudao.ai`;
      const deletedAddress = `${user}_deleted@shudao.ai`;
      const mail = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first();
      if (!mail) return json({ success: false, message: "邮件不存在" }, 404);

      // 归属校验（精确地址匹配，含软删除改写后的地址）
      const norm = a => (a || "").replace("_deleted@", "@");
      const isOwner = norm(mail.to_address) === userAddress || norm(mail.from_address) === userAddress;
      if (!isOwner) return json({ success: false, message: "无权操作该邮件" }, 403);

      if (field === "permanent_delete") {
        await env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
        return json({ success: true });
      }

      if (field === "execute_delete") {
        if (mail.is_draft) {
          // 草稿直接删除
          await env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
        } else if (mail.from_address === userAddress) {
          // 自己发出的信：改写 from
          await env.DB.prepare("UPDATE emails SET from_address = ? WHERE id = ?").bind(deletedAddress, id).run();
        } else {
          // 收到的信：改写 to
          await env.DB.prepare("UPDATE emails SET to_address = ? WHERE id = ?").bind(deletedAddress, id).run();
        }
        return json({ success: true });
      }

      // 其余字段白名单（阻断 SQL 注入）
      const ALLOWED_FIELDS = new Set(["is_starred"]);
      if (!ALLOWED_FIELDS.has(field)) return json({ success: false, message: "不支持的字段" }, 400);
      const v = value ? 1 : 0;
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(v, id).run();
      return json({ success: true });
    }

    // ---------- 发信（经 Resend 外发） ----------
    if (url.pathname === "/api/send" && request.method === "POST") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);
      if (!(await rateLimit(env, `send:${user}`, 30, 3600000))) return json({ success: false, message: "发信过于频繁，请稍后再试" }, 429);

      try {
        const body = await getJson();
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        const from_email = `${user}@shudao.ai`;

        if (!to_email || !content) return json({ success: false, message: "收件人与内容必填" }, 400);
        if (attachments.length > 10) return json({ success: false, message: "附件最多 10 个" }, 400);
        for (const f of attachments) {
          if (!f || typeof f.content !== "string" || f.content.length > 14_000_000) {
            return json({ success: false, message: "附件过大或格式错误（单个约限 10MB）" }, 400);
          }
        }

        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) return json({ success: false, message: "服务端未配置 RESEND_API_KEY" }, 500);

        const safeHtml = sanitizeHtml(content);
        const resendPayload = {
          from: `${user} <${from_email}>`,
          to: [String(to_email).trim()],
          subject,
          html: safeHtml
        };
        if (attachments.length > 0) {
          resendPayload.attachments = attachments.map(f => ({
            filename: String(f.filename || "attachment").replace(/[^\w.\-\u4e00-\u9fa5]/g, "_"),
            content: f.content
          }));
        }

        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify(resendPayload)
        });

        if (resendResponse.ok) {
          await env.DB.prepare(
            "INSERT INTO emails (to_address, from_address, subject, body_text, body_html, is_draft) VALUES (?, ?, ?, ?, ?, 0)"
          ).bind(String(to_email).trim(), from_email, subject, stripHtmlTags(safeHtml), safeHtml).run();
          // 若由草稿发起，发送成功后清掉草稿
          const draftId = parseInt(body.draft_id, 10);
          if (Number.isInteger(draftId) && draftId > 0) {
            await env.DB.prepare("DELETE FROM emails WHERE id = ? AND from_address = ? AND is_draft = 1")
              .bind(draftId, from_email).run();
          }
          return json({ success: true, message: "邮件已投递成功！" });
        }
        return json({ success: false, message: await resendResponse.text() }, 400);
      } catch (err) {
        return json({ success: false, message: err.message }, 500);
      }
    }

    // ---------- 草稿 ----------
    if (url.pathname === "/api/drafts/save" && request.method === "POST") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);
      const body = await getJson();
      const userAddress = `${user}@shudao.ai`;
      const safeHtml = sanitizeHtml(body.content || "");
      const plain = stripHtmlTags(safeHtml);
      const to = body.to ? String(body.to).trim() : "";
      const subject = body.subject ? String(body.subject) : "(无主题草稿)";
      const id = parseInt(body.id, 10);

      if (Number.isInteger(id) && id > 0) {
        const mail = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first();
        if (!mail || mail.from_address !== userAddress || !mail.is_draft) {
          return json({ success: false, message: "草稿不存在" }, 404);
        }
        await env.DB.prepare("UPDATE emails SET to_address = ?, subject = ?, body_text = ?, body_html = ? WHERE id = ?")
          .bind(to, subject, plain, safeHtml, id).run();
        return json({ success: true, id });
      }
      const res = await env.DB.prepare(
        "INSERT INTO emails (to_address, from_address, subject, body_text, body_html, is_draft) VALUES (?, ?, ?, ?, ?, 1)"
      ).bind(to, userAddress, subject, plain, safeHtml).run();
      return json({ success: true, id: res.meta && res.meta.last_row_id });
    }

    // ---------- 附件下载（R2） ----------
    if (url.pathname === "/api/attachments" && request.method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);
      const key = url.searchParams.get("key") || "";
      if (!key.startsWith("attachments/")) return json({ success: false, message: "无效附件" }, 400);
      if (!env.ATTACHMENTS) return json({ success: false, message: "服务端未启用附件存储" }, 500);

      const userAddress = `${user}@shudao.ai`;
      const deletedAddress = `${user}_deleted@shudao.ai`;
      const escapedKey = key.replace(/[%_\\]/g, c => "\\" + c);
      const owned = await env.DB.prepare(
        "SELECT id FROM emails WHERE (to_address IN (?, ?) OR from_address IN (?, ?)) AND attachments_json LIKE ? ESCAPE '\\' LIMIT 1"
      ).bind(userAddress, deletedAddress, userAddress, deletedAddress, `%${escapedKey}%`).first();
      if (!owned) return json({ success: false, message: "无权访问该附件" }, 403);

      const obj = await env.ATTACHMENTS.get(key);
      if (!obj) return json({ success: false, message: "附件不存在" }, 404);
      const filename = key.split("/").pop() || "attachment";
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          ...corsHeaders
        }
      });
    }

    // ==================== 招标雷达 API ====================

    if (url.pathname === "/api/tenders/list" && request.method === "GET") {
      const viewer = await getSessionUser(env, request);
      const isAdmin = viewer === "admin";
      const category = url.searchParams.get("category") || "IT";
      try {
        let sql = "SELECT * FROM tenders WHERE industry_category = ?";
        const params = [category];
        if (!isAdmin) sql += " AND status = 'approved'";
        sql += " ORDER BY id DESC LIMIT 200";
        const { results } = await env.DB.prepare(sql).bind(...params).all();
        return json(results);
      } catch {
        return json([]);
      }
    }

    if (url.pathname === "/api/tenders/create" && request.method === "POST") {
      const user = await getSessionUser(env, request);
      if (user !== "admin") return json({ success: false, message: "仅管理员可发布" }, 403);
      const body = await getJson();
      const title = String(body.title || "").trim();
      if (!title) return json({ success: false, message: "项目名称必填" }, 400);
      const category = ["IT", "DESIGN", "CONSTRUCT"].includes(body.industry_category) ? body.industry_category : "IT";
      await env.DB.prepare(
        "INSERT INTO tenders (title, industry_category, budget, region, source_platform, source_url, contact_info, status) VALUES (?, ?, ?, ?, '自发库', '', ?, 'approved')"
      ).bind(title, category, String(body.budget || "详见标书"), String(body.region || ""), String(body.contact_info || "")).run();
      return json({ success: true });
    }

    if (url.pathname === "/api/subscribe/get" && request.method === "GET") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);
      const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE username = ?").bind(user).first();
      return json(row || { username: user, keywords: "", exclude_keywords: "", push_strategy: 1 });
    }

    if (url.pathname === "/api/subscribe/save" && request.method === "POST") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);
      const body = await getJson();
      await env.DB.prepare(
        `INSERT INTO subscriptions (username, keywords, exclude_keywords, push_strategy, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(username) DO UPDATE SET keywords = excluded.keywords,
           exclude_keywords = excluded.exclude_keywords, push_strategy = excluded.push_strategy,
           updated_at = CURRENT_TIMESTAMP`
      ).bind(user, String(body.keywords || ""), String(body.exclude_keywords || ""), parseInt(body.push_strategy, 10) || 1).run();
      return json({ success: true, message: "雷达策略已保存" });
    }

    if (url.pathname === "/api/radar/force-trigger" && request.method === "POST") {
      const user = await getSessionUser(env, request);
      if (!user) return json({ success: false, message: "未登录" }, 401);
      if (!(await rateLimit(env, `radar:${user}`, 5, 3600000))) return json({ success: false, message: "触发过于频繁" }, 429);

      const sources = (env.RADAR_SOURCES || "").split(",").map(s => s.trim()).filter(Boolean);
      if (sources.length === 0) {
        return json({ success: true, message: "雷达就绪，但未配置情报源（环境变量 RADAR_SOURCES，逗号分隔 RSS/Atom 地址）", added: 0 });
      }
      let added = 0;
      for (const src of sources) {
        try {
          const res = await fetch(src, { headers: { "User-Agent": "ShuDaoRadar/1.0" }, signal: AbortSignal.timeout(8000) });
          const xml = await res.text();
          const blocks = [...xml.matchAll(/<(item|entry)[\s\S]*?<\/\1>/gi)];
          for (const m of blocks.slice(0, 100)) {
            const block = m[0];
            const pick = tag => {
              const t = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
              return t ? decodeMimeHeader(t[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : "";
            };
            const title = pick("title");
            if (!title) continue;
            const link = pick("link") || pick("guid") || pick("id");
            const desc = stripHtmlTags(pick("description") || pick("summary")).slice(0, 300);
            if (link) {
              const dup = await env.DB.prepare("SELECT id FROM tenders WHERE source_url = ?").bind(link).first();
              if (dup) continue;
            }
            const hay = title + desc;
            const category = /设计|规划|勘察|图纸|BIM|建模/i.test(hay) ? "DESIGN"
              : /施工|土建|公路|桥梁|隧道|房建|市政|养护/i.test(hay) ? "CONSTRUCT" : "IT";
            await env.DB.prepare(
              "INSERT INTO tenders (title, industry_category, budget, region, source_platform, source_url, status) VALUES (?, ?, '详见标书', '', ?, ?, 'approved')"
            ).bind(title, category, new URL(src).hostname, link || "").run();
            added++;
          }
        } catch (e) { console.error("雷达源抓取失败:", src, e.message); }
      }
      return json({ success: true, message: `雷达对账完成，新增 ${added} 条情报`, added });
    }

    // ==================== 静态资源回落 ====================
    return env.assets.fetch(request);
  }
};
