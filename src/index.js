// ================= 辅助工具函数：彻底解决乱码与 HTML 源码泄露 =================

// 辅助函数 1：消灭邮件主题中出现的 =?UTF-8?B?...?= 这种 RFC 乱码
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

// 辅助函数 2：安全还原邮件中被 Base64 加密的正文明文
function safeDecodeBase64(base64Str) {
  try {
    const cleanStr = base64Str.replace(/\s/g, "");
    const binString = atob(cleanStr);
    return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
  } catch {
    return "";
  }
}

// 辅助函数 3：强力脱水 HTML 标签，保证前端干净排版，绝不露出一行 <div> 源码
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

// ================= Worker 核心中央控制引擎 =================

export default {
  // 核心入口 1：处理外部向当前域投递进来的邮件（收信级自动化归档）
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
        // 多段复合式复杂格式解析结构
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
        // 单独明文或简单型 Base64 文本解析
        let contentPart = rawText.includes("\r\n\r\n") ? rawText.split("\r\n\r\n").slice(1).join("\r\n\r\n") : rawText;
        body_text = rawText.includes("Content-Transfer-Encoding: base64") ? safeDecodeBase64(contentPart.split("\r\n--")[0]) : contentPart;
      }
      body_text = stripHtmlTags(body_text);
    } catch (err) {
      body_text = `[邮件解析异常]: ${err.message}`;
    }

    // 💡 智能感知群邮件：凡是包含系统订阅列表 ID、大宗群发标记，或者主题携带“订阅”的，直接打上 is_group 钢印
    const rawHeaders = message.headers.toString().toLowerCase();
    const isGroup = (rawHeaders.includes("list-id") || rawHeaders.includes("precedence: bulk") || subject.includes("订阅")) ? 1 : 0;

    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text, is_group) VALUES (?, ?, ?, ?, ?)"
    ).bind(to_address, from_address, subject, body_text, isGroup).run();
  },

  // 核心入口 2：处理上游 HTML 前端页面派发过来的所有 API 交互（fetch 接口层）
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
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
          .bind(username, password).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch {
        return new Response(JSON.stringify({ success: false, message: "被占用" }), { status: 400, headers: corsHeaders });
      }
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await getJson();
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").bind(username, password).first();
      if (user) return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      return new Response(JSON.stringify({ success: false }), { status: 401, headers: corsHeaders });
    }

    // 💡 API: 获取邮件列表（🚀 核心重构：无缝支撑前端 QQ 邮箱全套 7 大菜单的多维 SQL 过滤选择器）
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const filter = url.searchParams.get("filter") || "inbox";
      const userAddress = `${username}@shudao.ai`;

      let sql = "SELECT * FROM emails WHERE ";
      let params = [];

      switch (filter) {
        case "sent":
          // ▲ 已发送：发件人为我，且未被丢进回收站
          sql += "from_address = ? AND is_deleted = 0";
          params.push(userAddress);
          break;
        case "trash":
          // 🗑️ 已删除：标记了软删除的所有往来信件
          sql += "(to_address = ? OR from_address = ?) AND is_deleted = 1";
          params.push(userAddress, userAddress);
          break;
        case "starred":
          // ⭐ 星标邮件：属于我接收、且加星、未删除的信件
          sql += "to_address = ? AND is_starred = 1 AND is_deleted = 0";
          params.push(userAddress);
          break;
        case "vip":
          // 🔖 重要联系人：降级采用高优先级的星标信息进行智能拉取
          sql += "to_address = ? AND is_starred = 1 AND is_deleted = 0";
          params.push(userAddress);
          break;
        case "group":
          // 👥 群邮件：归档标签为 group 且未删除的邮件
          sql += "to_address = ? AND is_group = 1 AND is_deleted = 0";
          params.push(userAddress);
          break;
        case "draft":
          // 📄 草稿箱
          sql += "from_address = ? AND is_draft = 1 AND is_deleted = 0";
          params.push(userAddress);
          break;
        case "inbox":
        default:
          // 📁 收件箱：发给我的、非群发的、非草稿的、健康的未删除信件
          sql += "to_address = ? AND is_group = 0 AND is_draft = 0 AND is_deleted = 0";
          params.push(userAddress);
          break;
      }

      sql += " ORDER BY received_at DESC";
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // API: 局部状态机更新（修改星标、已读、执行软删除）
    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // API: 高级发信网关（💡 顶级主域 shudao.ai 物理锁死版，成功外发后自动本地归档，生成已发送数据）
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
        const from_email = `${clean_user}@shudao.ai`; // 强锁顶级主域

        if (!to_email || !content) {
          return new Response(JSON.stringify({ success: false, message: "缺少必要参数（收件人或内容为空）" }), { status: 400, headers: corsHeaders });
        }

        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ success: false, message: "缺失 RESEND_API_KEY" }), { status: 500, headers: corsHeaders });
        }

        // 调用 Resend 官方核心通道外发
        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey.trim()}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: `${clean_user} <${from_email}>`,
            to: [to_email.trim()],
            subject: subject,
            html: content
          })
        });

        const resText = await resendResponse.text();
        let resData = {};
        try { resData = JSON.parse(resText); } catch(e) {}

        if (resendResponse.ok) {
          // 💡 绝杀落库：发信成功后，顺带往 D1 里插一条记录，发件人是我，收件人是目标，打入“已发送”列表！
          const cleanSentBody = stripHtmlTags(content);
          await env.DB.prepare(
            "INSERT INTO emails (to_address, from_address, subject, body_text, is_draft, is_deleted) VALUES (?, ?, ?, ?, 0, 0)"
          ).bind(to_email.trim(), from_email, subject, cleanSentBody).run();

          return new Response(JSON.stringify({ success: true, message: "邮件已发送，并成功存入发件箱！" }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ 
          success: false, 
          message: `Resend拒绝投递 [使用账号 ${from_email}]: ${resData.message || resText}` 
        }), { status: resendResponse.status, headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: `系统路由异常: ${err.message}` }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};