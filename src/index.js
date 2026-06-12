// ================= 辅助工具函数：解决乱码、解析与脱水 =================

// 辅助函数 1：消灭邮件主题中出现的 =?UTF-8?B?...?= 这种乱码
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

// 辅助函数 2：安全还原被 Base64 加密的邮件正文段落
function safeDecodeBase64(base64Str) {
  try {
    const cleanStr = base64Str.replace(/\s/g, "");
    const binString = atob(cleanStr);
    return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
  } catch {
    return "";
  }
}

// 辅助函数 3：强力脱水 HTML 标签，确保前端展示纯净文本，防止标签源码裸露
function stripHtmlTags(htmlStr) {
  if (!htmlStr) return "";
  let text = htmlStr;
  text = text.replace(/<(p|div|br|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">")
             .replace(/&amp;/g, "&");
  return text.split("\n").map(line => line.trim()).filter(line => line !== "").join("\n");
}

// ================= Worker 核心逻辑引擎 =================

export default {
  // 核心入口 1：处理外部投递进来的邮件并无缝存入 D1 数据库（收信）
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
        // 多段式高复杂度邮件结构解析（如来自 Gmail / QQ 的富文本邮件）
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
        // 基础明文或单段 Base64 邮件流解析
        let contentPart = rawText.includes("\r\n\r\n") ? rawText.split("\r\n\r\n").slice(1).join("\r\n\r\n") : rawText;
        body_text = rawText.includes("Content-Transfer-Encoding: base64") ? safeDecodeBase64(contentPart.split("\r\n--")[0]) : contentPart;
      }
      body_text = stripHtmlTags(body_text);
    } catch (err) {
      body_text = `[邮件解析异常]: ${err.message}`;
    }

    // 执行存库
    await env.DB.prepare("INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)")
      .bind(to_address, from_address, subject, body_text).run();
  },

  // 核心入口 2：响应前端网页的 HTTP 交互请求（API 路由与发信）
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const getJson = async () => { try { return await request.json(); } catch { return {}; } };

    // API: 用户注册
    if (url.pathname === "/api/register" && request.method === "POST") {
      const { username, password } = await getJson();
      if (!username || !password) return new Response("缺少参数", { status: 400, headers: corsHeaders });
      try {
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
          .bind(username, password).run();
        return new Response(JSON.stringify({ success: true, message: "注册成功！" }), { headers: corsHeaders });
      } catch {
        return new Response(JSON.stringify({ success: false, message: "该用户名已被占用" }), { status: 400, headers: corsHeaders });
      }
    }

    // API: 用户登录
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await getJson();
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").bind(username, password).first();
      if (user) return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      return new Response(JSON.stringify({ success: false, message: "密码错误" }), { status: 401, headers: corsHeaders });
    }

    // API: 拉取收件列表
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const { results } = await env.DB.prepare("SELECT * FROM emails WHERE to_address LIKE ? ORDER BY received_at DESC").bind(`${username}@%`).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // API: 局部更新邮件属性（星标、已读、状态修改）
    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // API: 发信接口（💡 顶级主域 shudao.ai 物理锁死版，完美通关！）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";

        // 强力剥离任何前端混入的后缀，确保干净提取前缀
        let rawUser = "admin";
        if (body.from_user) rawUser = body.from_user.split('@')[0];
        else if (body.from) rawUser = body.from.split('@')[0];
        
        const clean_user = rawUser.trim();
        
        // 💡 核心改动：移出过渡时期的 mail. 二级前缀，完美对齐通过验证的主域名！
        const from_email = `${clean_user}@shudao.ai`; 

        if (!to_email || !content) {
          return new Response(JSON.stringify({ success: false, message: "缺少必要参数（收件人或内容为空）" }), { status: 400, headers: corsHeaders });
        }

        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ success: false, message: "配置错误：未检测到 RESEND_API_KEY，请在 Cloudflare 变量中添加。" }), { status: 500, headers: corsHeaders });
        }

        // 呼叫 Resend 高誉度网关出网投递
        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey.trim()}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: `${clean_user} <${from_email}>`, // 拼装成完全合规的主域发件头
            to: [to_email.trim()],
            subject: subject,
            html: content
          })
        });

        const resText = await resendResponse.text();
        let resData = {};
        try { resData = JSON.parse(resText); } catch(e) {}

        if (resendResponse.ok) {
          return new Response(JSON.stringify({ success: true, message: "邮件通过主域名 shudao.ai 通道成功发送！" }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ 
          success: false, 
          message: `Resend拒绝投递 [尝试发件人: ${from_email}]: ${resData.message || resText}` 
        }), { status: resendResponse.status, headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: `代码运行异常: ${err.message}` }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};