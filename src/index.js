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

// 外部收信脱水安全防线
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
  // 入口 1：处理外部向当前域投递进来的邮件（自动安全脱水收信）
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

    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
    ).bind(to_address, from_address, subject, body_text).run();
  },

  // 入口 2：多维数据接口
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const getJson = async () => { try { return await request.json(); } catch { return {}; } };

    // API: 用户登录注册
    if (url.pathname === "/api/register" && request.method === "POST") {
      const { username, password } = await getJson();
      try {
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").bind(username, password).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch {
        return new Response(JSON.stringify({ success: false, message: "凭证被占用" }), { status: 400, headers: corsHeaders });
      }
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await getJson();
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").bind(username, password).first();
      if (user) return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      return new Response(JSON.stringify({ success: false }), { status: 401, headers: corsHeaders });
    }

    // API: 获取邮件列表
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const filter = url.searchParams.get("filter") || "inbox";
      const userAddress = `${username}@shudao.ai`;
      const deletedAddress = `${username}_deleted@shudao.ai`;

      let sql = "";
      let params = [];

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

      try {
        const { results } = await env.DB.prepare(sql).bind(...params).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      } catch (dbErr) {
        return new Response(JSON.stringify({ success: false, message: dbErr.message }), { status: 500, headers: corsHeaders });
      }
    }

    // API: 修改状态与影子删除/永久删除分流网关
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
          let updateField = "to_address";
          let newAddress = `${targetUser}_deleted@shudao.ai`;
          if (currentMail.from_address.includes(targetUser)) updateField = "from_address";
          await env.DB.prepare(`UPDATE emails SET ${updateField} = ? WHERE id = ?`).bind(newAddress, id).run();
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
      }

      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // API: 发信中继（💡 升级：直接在外发请求中完美投递前端传来的富文本 HTML 流）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || ""; // 这里接收的是带格式的 HTML 字符串
        const attachments = body.attachments || [];

        let rawUser = "admin";
        if (body.from_user) rawUser = body.from_user.split('@')[0];
        else if (body.from) rawUser = body.from.split('@')[0];
        
        const clean_user = rawUser.trim();
        const from_email = `${clean_user}@shudao.ai`;

        if (!to_email || !content) return new Response(JSON.stringify({ success: false, message: "参数不全" }), { status: 400, headers: corsHeaders });
        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) return new Response(JSON.stringify({ success: false, message: "缺失KEY" }), { status: 500, headers: corsHeaders });

        const resendPayload = {
          from: `${clean_user} <${from_email}>`,
          to: [to_email.trim()],
          subject: subject,
          html: content // 💡 传给 Resend 的 html 字段，对方收到就是漂亮完整的网页格式邮件！
        };

        if (attachments && attachments.length > 0) {
          resendPayload.attachments = attachments.map(f => ({
            filename: f.filename,
            content: f.content
          }));
        }

        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify(resendPayload)
        });

        if (resendResponse.ok) {
          // 💡 为了让你的已发送箱也能预览你精心排版的富文本，我们这里直接原汁原味地存入 HTML 字符串！
          await env.DB.prepare(
            "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
          ).bind(to_email.trim(), from_email, subject, content).run();
          
          return new Response(JSON.stringify({ success: true, message: "富文本邮件已成功投递外发！" }), { headers: corsHeaders });
        }
        return new Response(await resendResponse.text(), { status: 400, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};