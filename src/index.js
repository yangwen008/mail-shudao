// 辅助函数 1：消灭 =?UTF-8?B?...?= 邮件头乱码
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

// 辅助函数 2：安全还原正文中的 Base64 字符串
function safeDecodeBase64(base64Str) {
  try {
    const cleanStr = base64Str.replace(/\s/g, "");
    const binString = atob(cleanStr);
    return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
  } catch {
    return "";
  }
}

// 辅助函数 3：终极 HTML 标签剥离器（强力脱水，不留任何死角标签）
function stripHtmlTags(htmlStr) {
  if (!htmlStr) return "";
  let text = htmlStr;
  // 1. 先把常见的换行标签和块级标签替换成标准换行，保证排版不全缩成一团
  text = text.replace(/<(p|div|br|tr)[^>]*>/gi, "\n");
  // 2. 强力抹除所有剩余的类似 <...any...> 的标签
  text = text.replace(/<[^>]+>/g, "");
  // 3. 还原常见的 HTML 转义字符（如 &nbsp; &lt; &gt;）
  text = text.replace(/&nbsp;/g, " ")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">")
             .replace(/&amp;/g, "&");
  // 4. 清洗掉多余的连续空白和首尾空行
  return text.split("\n").map(line => line.trim()).filter(line => line !== "").join("\n");
}

export default {
  // 核心：处理外部投递进来的邮件
  async email(message, env, ctx) {
    const to_address = message.to;
    const from_address = message.from;
    
    const rawSubject = message.headers.get("subject") || "(无主题)";
    const subject = decodeMimeHeader(rawSubject);
    
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
          
          const isHtml = partHeaders.includes("text/html");
          const isPlain = partHeaders.includes("text/plain");
          const isBase64 = partHeaders.includes("base64");
          
          if (isHtml || isPlain) {
            let cleanBody = partBody.split(`\r\n--`)[0].trim();
            
            if (isBase64) {
              cleanBody = safeDecodeBase64(cleanBody);
            }
            
            if (isHtml) {
              extractedHtml = cleanBody;
            } else if (isPlain) {
              extractedPlain = cleanBody;
            }
          }
        }
        
        // 判定提取路由
        if (extractedPlain) {
          body_text = extractedPlain;
        } else if (extractedHtml) {
          body_text = extractedHtml;
        } else {
          body_text = "[邮件内容为空]";
        }
        
      } else {
        const isBase64 = rawText.includes("Content-Transfer-Encoding: base64");
        let contentPart = rawText.includes("\r\n\r\n") ? rawText.split("\r\n\r\n").slice(1).join("\r\n\r\n") : rawText;
        
        if (isBase64) {
          if (contentPart.includes("\r\n--")) contentPart = contentPart.split("\r\n--")[0];
          body_text = safeDecodeBase64(contentPart);
        } else {
          body_text = contentPart;
        }
      }

      // 💡 核心收尾：在这里对最终生成的 body_text 执行终极脱水，确保不管什么路径进来的代码全部灰飞烟灭
      body_text = stripHtmlTags(body_text);

    } catch (err) {
      body_text = `[邮件解析异常]: ${err.message}`;
    }

    // 存入干净的纯文本
    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
    ).bind(to_address, from_address, subject, body_text).run();
  },

  // 核心：处理网页前端的 HTTP 请求
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

    // API: 登录验证
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await getJson();
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?")
        .bind(username, password).first();
      if (user) {
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ success: false, message: "密码错误或用户不存在" }), { status: 401, headers: corsHeaders });
    }

    // API: 获取邮件列表
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const filter = url.searchParams.get("filter") || "inbox";
      const q = url.searchParams.get("q") || "";

      let sql = "SELECT * FROM emails WHERE to_address LIKE ? ";
      let params = [`${username}@%`];

      if (filter === "starred") {
        sql += "AND is_starred = 1 AND is_deleted = 0 ";
      } else if (filter === "trash") {
        sql += "AND is_deleted = 1 ";
      } else {
        sql += "AND is_deleted = 0 ";
      }

      if (q) {
        sql += "AND (subject LIKE ? OR body_text LIKE ? OR from_address LIKE ?) ";
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }

      sql += "ORDER BY received_at DESC";

      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // API: 修改邮件状态
    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      if (!["is_read", "is_starred", "is_deleted"].includes(field)) {
        return new Response("非法操作", { status: 400, headers: corsHeaders });
      }
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // API: 发信接口
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const from_user = body.from_user || (body.from ? body.from.split('@')[0] : "admin");
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";
        const from_email = from_user.includes("@") ? from_user : `${from_user}@shudao.ai`;

        if (!to_email || !content) {
          return new Response(JSON.stringify({ success: false, message: "缺少必要参数" }), { status: 400, headers: corsHeaders });
        }

        if (env.RESEND_API_KEY) {
          const sendRequest = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: `${from_user} <${from_email.trim()}>`, to: [to_email.trim()], subject: subject, html: content })
          });
          if (sendRequest.ok) return new Response(JSON.stringify({ success: true, message: "邮件发送成功！" }), { headers: corsHeaders });
        }

        const sendRequest = await fetch("https://api.mailchannels.net/tx/v1/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to_email.trim() }] }],
            from: { email: from_email.trim(), name: from_user },
            subject: subject,
            content: [{ type: "text/html", value: content }],
            whitelabel: "shudao.ai"
          })
        });

        const resText = await sendRequest.text();
        if (sendRequest.status === 202 || sendRequest.status === 200) {
          return new Response(JSON.stringify({ success: true, message: "邮件发送成功！" }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ success: false, message: `投递网关拒绝: ${resText}` }), { status: sendRequest.status, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: `运行时异常: ${err.message}` }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};