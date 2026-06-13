// ========================================================
// 🔐 第一部分：安全加固防线（边缘端纯原生 SHA-256 加盐哈希算法）
// ========================================================
async function hashPassword(password) {
  const msgBuffer = new TextEncoder().encode(password + "ShuDaoSalt2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ========================================================
// 🛠️ 第二部分：辅助工具函数（邮件 MIME 解码与 HTML 脱水安全防御）
// ========================================================
function decodeMimeHeader(headerText) {
  if (!headerText) return "(无主题)";
  const regex = /=\?UTF-8\?B\?([^\?]+)\?=/gi;
  return headerText.replace(regex, (match, p1) => {
    try {
      const binString = atob(p1);
      return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
    } catch { return match; }
  });
}

function safeDecodeBase64(base64Str) {
  try {
    const cleanStr = base64Str.replace(/\s/g, "");
    const binString = atob(cleanStr);
    return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
  } catch { return ""; }
}

function stripHtmlTags(htmlStr) {
  if (!htmlStr) return "";
  let text = htmlStr;
  text = text.replace(/<(p|div|br|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return text.split("\n").map(line => line.trim()).filter(line => line !== "").join("\n");
}

// ========================================================
// 🚀 第三部分：邮局核心物理入口接驳中枢
// ========================================================
export default {
  // 1. 边缘端原生 MX 记录邮件收网捕获器
  async email(message, env, ctx) {
    const to_address = message.to;
    const from_address = message.from;
    const subject = decodeMimeHeader(message.headers.get("subject") || "(无主题)");
    
    let body_text = "";
    try {
      const rawText = await new Response(message.raw).text();
      const contentTypeHeader = message.headers.get("content-type") || "";
      const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i) || rawText.match(/boundary="?([^"\r\n]+)"?/i);
      
      if (boundaryMatch) {
        const boundary = boundaryMatch[1] || boundaryMatch[2];
        const parts = rawText.split(`--${boundary}`);
        let extractedHtml = ""; let extractedPlain = "";
        for (const part of parts) {
          if (part.trim() === "" || part.trim() === "--") continue;
          const headerBodySplit = part.split("\r\n\r\n");
          if (headerBodySplit.length < 2) continue;
          const partHeaders = headerBodySplit[0].toLowerCase();
          const partBody = headerBodySplit.slice(1).join("\r\n\r\n");
          if (partHeaders.includes("text/html") || partHeaders.includes("text/plain")) {
            let cleanBody = partBody.split(`\r\n--`)[0].trim();
            if (partHeaders.includes("base64")) cleanBody = safeDecodeBase64(cleanBody);
            if (partHeaders.includes("text/html")) extractedHtml = cleanBody;
            else extractedPlain = cleanBody;
          }
        }
        body_text = extractedPlain || extractedHtml || "[邮件内容为空]";
      } else {
        let contentPart = rawText.includes("\r\n\r\n") ? rawText.split("\r\n\r\n").slice(1).join("\r\n\r\n") : rawText;
        body_text = rawText.includes("Content-Transfer-Encoding: base64") ? safeDecodeBase64(contentPart.split("\r\n--")[0]) : contentPart;
      }
      body_text = stripHtmlTags(body_text);
    } catch (err) { body_text = `[邮件解析异常]: ${err.message}`; }

    // 强攻砸入 D1 账本邮箱表
    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
    ).bind(to_address, from_address, subject, body_text).run();
  },

  // 2. 邮局 Web 客户端 HTTP 路由请求网关
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const getJson = async () => { try { return await request.json(); } catch { return {}; } };

    // 🛡️ 物理网页静态翻牌器死锁
    if (url.pathname === "/") {
      return env.assets.fetch(new Request(new URL("/mail_login.html", request.url)));
    }

    // ================= API 控制中枢 =================
    if (url.pathname === "/api/register" && request.method === "POST") {
      const { username, password } = await getJson();
      try {
        const secureHash = await hashPassword(password);
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").bind(username, secureHash).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch {
        return new Response(JSON.stringify({ success: false, message: "凭证名前缀已被占用" }), { status: 400, headers: corsHeaders });
      }
    }
    
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await getJson();
      const secureHash = await hashPassword(password);
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").bind(username, secureHash).first();
      if (user) return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      return new Response(JSON.stringify({ success: false }), { status: 401, headers: corsHeaders });
    }

    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const filter = url.searchParams.get("filter") || "inbox";
      const userAddress = `${username}@shudao.ai`;
      const deletedAddress = `${username}_deleted@shudao.ai`;
      let sql = ""; let params = [];

      if (filter === "trash") {
        sql = "SELECT * FROM emails WHERE to_address = ? OR from_address = ? ORDER BY received_at DESC";
        params.push(deletedAddress, deletedAddress);
      } else if (filter === "sent") {
        sql = "SELECT * FROM emails WHERE from_address = ? AND to_address NOT LIKE '%_deleted%' ORDER BY received_at DESC";
        params.push(userAddress);
      } else if (filter === "starred" || filter === "vip") {
        sql = "SELECT * FROM emails WHERE to_address = ? AND is_starred = 1 ORDER BY received_at DESC";
        params.push(userAddress);
      } else {
        sql = "SELECT * FROM emails WHERE to_address = ? AND from_address NOT LIKE ? ORDER BY received_at DESC";
        params.push(userAddress, `%${username}%`);
      }
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      if (field === 'permanent_delete') {
        await env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      if (field === 'execute_delete') {
        const targetUser = value.trim();
        const currentMail = await env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first();
        if (currentMail) {
          let updateField = "to_address"; let newAddress = `${targetUser}_deleted@shudao.ai`;
          if (currentMail.from_address.includes(targetUser)) updateField = "from_address";
          await env.DB.prepare(`UPDATE emails SET ${updateField} = ? WHERE id = ?`).bind(newAddress, id).run();
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
      }
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";
        const attachments = body.attachments || [];
        let rawUser = "admin";
        if (body.from_user) rawUser = body.from_user.split('@')[0];
        else if (body.from) rawUser = body.from.split('@')[0];
        const clean_user = rawUser.trim();
        const from_email = `${clean_user}@shudao.ai`;

        if (!to_email || !content) return new Response(JSON.stringify({ success: false, message: "参数不全" }), { status: 400, border: corsHeaders });
        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) return new Response(JSON.stringify({ success: false, message: "缺失密匙环境变量" }), { status: 500, headers: corsHeaders });

        const resendPayload = { from: `${clean_user} <${from_email}>`, to: [to_email.trim()], subject: subject, html: content };
        if (attachments && attachments.length > 0) {
          resendPayload.attachments = attachments.map(f => ({ filename: f.filename, content: f.content }));
        }
        
        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify(resendPayload)
        });
        
        if (resendResponse.ok) {
          await env.DB.prepare("INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)").bind(to_email.trim(), from_email, subject, content).run();
          return new Response(JSON.stringify({ success: true, message: "富文本邮件已投递外发成功！" }), { headers: corsHeaders });
        }
        return new Response(await resendResponse.text(), { status: 400, headers: corsHeaders });
      } catch (err) { return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: corsHeaders }); }
    }

    return env.assets.fetch(request);
  }
};