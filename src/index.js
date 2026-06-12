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
  // 入口 1：处理外部向当前域投递进来的邮件（收信落库）
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

  // 入口 2：多维数据交互
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
        return new Response(JSON.stringify({ success: false, message: "用户已存在" }), { status: 400, headers: corsHeaders });
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

    // API: 发信中继（📎 升级：原生全量注入 Base64 附件，不占数据库体积直接外发）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";
        const attachments = body.attachments || []; // 💡 提取前端送来的附件数组

        let rawUser = "admin";
        if (body.from_user) rawUser = body.from_user.split('@')[0];
        else if (body.from) rawUser = body.from.split('@')[0];
        
        const clean_user = rawUser.trim();
        const from_email = `${clean_user}@shudao.ai`;

        if (!to_email || !content) return new Response("参数不全", { status: 400, headers: corsHeaders });
        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) return new Response("缺失KEY", { status: 500, headers: corsHeaders });

        // 组装发给 Resend 的商业信包
        const resendPayload = {
          from: `${clean_user} <${from_email}>`,
          to: [to_email.trim()],
          subject: subject,
          html: content
        };

        // 💡 附件无缝对接：如果前端传了附件文本，顺理成章地塞进 Resend payload
        if (attachments && attachments.length > 0) {
          resendPayload.attachments = attachments.map(f => ({
            filename: f.filename,
            content: f.content // Resend 官方原生秒懂 Base64
          }));
        }

        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify(resendPayload)
        });

        if (resendResponse.ok) {
          // 在发件箱留存备份时，为了不给你的 D1 带来存储负担，我们只留存纯文字主题和正文
          const cleanSentBody = stripHtmlTags(content) + (attachments.length > 0 ? `\n\n[📎 包含 ${attachments.length} 个发送附件]` : '');
          await env.DB.prepare(
            "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
          ).bind(to_email.trim(), from_email, subject, cleanSentBody).run();
          
          return new Response(JSON.stringify({ success: true, message: "邮件(包含附件)已发送成功！" }), { headers: corsHeaders });
        }
        return new Response(await resendResponse.text(), { status: 400, headers: corsHeaders });
      } catch (err) {
        return new Response(err.message, { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};