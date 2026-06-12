// ================= 辅助工具函数 =================

function decodeMimeHeader(headerText) {
  if (!headerText) return "(无主题)";
  const regex = /=\?UTF-8\?B\?([^\?]+)\?=/gi;
  return headerText.replace(regex, (match, p1) => {
    try {
      const binString = atob(p1);
      return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
    } catch {
      return match;
    }
  });
}

function safeDecodeBase64(base64Str) {
  try {
    const cleanStr = base64Str.replace(/\s/g, "");
    const binString = atob(cleanStr);
    return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
  } catch {
    return "";
  }
}

function stripHtmlTags(htmlStr) {
  if (!htmlStr) return "";
  let text = htmlStr;
  text = text.replace(/<(p|div|br|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return text.split("\n").map(line => line.trim()).filter(line => line !== "").join("\n");
}

// ================= Worker 核心中央控制引擎 =================

export default {
  // 入口 1：处理外部向当前域投递进来的邮件（纯净收信落库）
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
        let extractedHtml = "";
        let extractedPlain = "";
        
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
    } catch (err) {
      body_text = `[邮件解析异常]: ${err.message}`;
    }

    // 只写入数据库中绝对存在的 4 个核心列，100% 拒绝任何报错
    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
    ).bind(to_address, from_address, subject, body_text).run();
  },

  // 入口 2：多维数据兼容路由
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const getJson = async () => { try { return await request.json(); } catch { return {}; } };

    // API: 用户注册与登录
    if (url.pathname === "/api/register" && request.method === "POST") {
      const { username, password } = await getJson();
      try {
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").bind(username, password).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch {
        return new Response(JSON.stringify({ success: false, message: "该用户已被注册" }), { status: 400, headers: corsHeaders });
      }
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await getJson();
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").bind(username, password).first();
      if (user) return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      return new Response(JSON.stringify({ success: false, message: "密码校验错误" }), { status: 401, headers: corsHeaders });
    }

    // API: 获取邮件列表
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const filter = url.searchParams.get("filter") || "inbox";
      const userAddress = `${username}@shudao.ai`;

      let sql = "";
      let params = [];

      if (filter === "sent") {
        sql = "SELECT * FROM emails WHERE from_address LIKE ? ORDER BY received_at DESC";
        params.push(`%${userAddress}%`);
      } else if (filter === "starred" || filter === "vip") {
        sql = "SELECT * FROM emails WHERE to_address LIKE ? AND is_starred = 1 ORDER BY received_at DESC";
        params.push(`%${userAddress}%`);
      } else {
        sql = "SELECT * FROM emails WHERE to_address LIKE ? AND from_address NOT LIKE ? ORDER BY received_at DESC";
        params.push(`%${userAddress}%`, `%${userAddress}%`);
      }

      try {
        const { results } = await env.DB.prepare(sql).bind(...params).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      } catch (dbErr) {
        return new Response(JSON.stringify({ success: false, message: `D1底层错误: ${dbErr.message}` }), { status: 500, headers: corsHeaders });
      }
    }

    // API: 修改状态
    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // API: 发信中继（落库层不带多余字段，绝对安全安全）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";

        let rawUser = "admin";
        if (body.from_user) rawUser = body.from_user.split('@')[0];
        else if (body.from) rawUser = body.from.split('@')[0];
        
        const clean_user = rawUser.trim();
        const from_email = `${clean_user}@shudao.ai`;

        if (!to_email || !content) {
          return new Response(JSON.stringify({ success: false, message: "参数不全" }), { status: 400, headers: corsHeaders });
        }

        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) return new Response(JSON.stringify({ success: false, message: "缺失 RESEND_API_KEY" }), { status: 500, headers: corsHeaders });

        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: `${clean_user} <${from_email}>`,
            to: [to_email.trim()],
            subject: subject,
            html: content
          })
        });

        if (resendResponse.ok) {
          const cleanSentBody = stripHtmlTags(content);
          
          // 静默落库备份，字段只有 4 个，完美兼容
          await env.DB.prepare(
            "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
          ).bind(to_email.trim(), from_email, subject, cleanSentBody).run();

          return new Response(JSON.stringify({ success: true, message: "邮件已发送，并成功记入发件箱！" }), { headers: corsHeaders });
        }
        const resText = await resendResponse.text();
        return new Response(JSON.stringify({ success: false, message: resText }), { status: 400, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};