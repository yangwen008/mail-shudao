export default {
  // 核心：处理外部发送进来的邮件并存入 D1 数据库
  async email(message, env, ctx) {
    const to_address = message.to;
    const from_address = message.from;
    const subject = message.headers.get("subject") || "(无主题)";
    
    let body_text = "";
    try {
      const rawText = await new Response(message.raw).text();
      if (rawText.includes("Content-Transfer-Encoding: base64")) {
        const parts = rawText.split("\r\n\r\n");
        let base64Str = parts[parts.length - 1].replace(/\s/g, "");
        if (rawText.includes("------=_NextPart")) {
          for (let i = 0; i < parts.length; i++) {
            if (parts[i].includes("Content-Type: text/plain") && parts[i+1]) {
              base64Str = parts[i+1].split("---")[0].replace(/\s/g, "");
              break;
            }
          }
        }
        try {
          const binString = atob(base64Str);
          body_text = new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
        } catch {
          body_text = parts.slice(1).join("\r\n\r\n");
        }
      } else {
        body_text = rawText.includes("\r\n\r\n") ? rawText.split("\r\n\r\n").slice(1).join("\r\n\r\n") : rawText;
      }
    } catch {
      body_text = "[无法解析邮件正文]";
    }

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

    // API: 发信接口（高安全对齐版，彻底破除 401）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        
        const from_user = body.from_user || (body.from ? body.from.split('@')[0] : "admin");
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";

        // 强行锁死主发信后缀
        const from_email = from_user.includes("@") ? from_user : `${from_user}@shudao.ai`;

        if (!to_email || !content) {
          return new Response(JSON.stringify({ success: false, message: "缺少必要参数" }), { status: 400, headers: corsHeaders });
        }

        // 💡 针对 Mailchannels 最新变动，补齐顶级防伪字段，强制对齐发送通道
        const payload = {
          personalizations: [
            { 
              to: [{ email: to_email.trim() }]
            }
          ],
          from: { 
            email: from_email.trim(), 
            name: from_user 
          },
          subject: subject,
          content: [
            { 
              type: "text/html", 
              value: content 
            }
          ],
          // 彻底对齐域名锁
          whitelabel: "shudao.ai"
        };

        const sendRequest = await fetch("https://api.mailchannels.net/tx/v1/send", {
          method: "POST",
          headers: { 
            "content-type": "application/json",
            "accept": "application/json"
          },
          body: JSON.stringify(payload)
        });

        const resText = await sendRequest.text();

        if (sendRequest.status === 202 || sendRequest.status === 200) {
          return new Response(JSON.stringify({ success: true, message: "邮件发送成功！" }), { headers: corsHeaders });
        }
        
        // 抛出真实详情
        return new Response(JSON.stringify({ success: false, message: `投递网关拒绝: ${resText}` }), { status: sendRequest.status, headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: `Worker 运行时异常: ${err.message}` }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};