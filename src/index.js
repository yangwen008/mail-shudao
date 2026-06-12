export default {
  // 核心：处理外部发送进来的邮件并存入 D1 数据库
  async email(message, env, ctx) {
    const to_address = message.to;
    const from_address = message.from;
    const subject = message.headers.get("subject") || "(无主题)";
    
    let body_text = "";
    try {
      body_text = await new Response(message.raw).text();
      // 简单截取正文，防止原始邮件头过长
      if (body_text.includes("\r\n\r\n")) {
        body_text = body_text.split("\r\n\r\n").slice(1).join("\r\n\r\n");
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
        return new Response(JSON.stringify({ success: true, message: "注册成功！现在可以登录了。" }), { headers: corsHeaders });
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

    // API: 获取邮件列表（支持收件箱/星标/回收站以及关键词搜索）
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

    // API: 修改邮件状态（已读、星标、软删除）
    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      if (!["is_read", "is_starred", "is_deleted"].includes(field)) {
        return new Response("非法操作", { status: 400, headers: corsHeaders });
      }
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // API: 调用 Mailchannels 免费通道发信
    if (url.pathname === "/api/send" && request.method === "POST") {
      const { from_user, to_email, subject, content } = await getJson();
      const from_email = `${from_user}@${url.hostname}`;

      const sendRequest = await fetch("https://api.mailchannels.net/tx/v1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to_email }] }],
          from: { email: from_email, name: from_user },
          subject: subject,
          content: [{ type: "text/plain", value: content }]
        })
      });

      if (sendRequest.status === 202 || sendRequest.status === 200) {
        return new Response(JSON.stringify({ success: true, message: "邮件发送成功！" }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ success: false, message: "发信失败，请检查 SPF 记录配置" }), { status: 500, headers: corsHeaders });
    }

    return new Response("Not Found", { status: 404 });
  }
};