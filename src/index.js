// ================= 辅助工具函数：彻底解决乱码与排版 =================

// 辅助函数 1：消灭邮件主题中出现的 =?UTF-8?B?...?= 这种 RFC 2047 乱码
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

// 辅助函数 2：安全还原邮件各 Part 区块中被 Base64 加密的密文
function safeDecodeBase64(base64Str) {
  try {
    const cleanStr = base64Str.replace(/\s/g, "");
    const binString = atob(cleanStr);
    return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
  } catch {
    return "";
  }
}

// 辅助函数 3：强力脱水 HTML 标签，确保前端不管用何种方式渲染，都绝对不会展示 <div> 标签源码
function stripHtmlTags(htmlStr) {
  if (!htmlStr) return "";
  let text = htmlStr;
  // 将段落和换行标签替换为标准换行符，保护最基本的中文阅读排版
  text = text.replace(/<(p|div|br|tr)[^>]*>/gi, "\n");
  // 抹除所有剩余的类似 <...any...> 的 HTML 骨架标签
  text = text.replace(/<[^>]+>/g, "");
  // 完美还原 HTML 常见的转义特殊字符
  text = text.replace(/&nbsp;/g, " ")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">")
             .replace(/&amp;/g, "&");
  // 清理行首尾多余的连续空格和垃圾空行
  return text.split("\n").map(line => line.trim()).filter(line => line !== "").join("\n");
}

// ================= Worker 核心逻辑 =================

export default {
  // 核心 1：解析外部发送进来的邮件并存入 D1 数据库（收信端）
  async email(message, env, ctx) {
    const to_address = message.to;
    const from_address = message.from;
    
    // 动态洗净可能乱码的邮件主题
    const subject = decodeMimeHeader(message.headers.get("subject") || "(无主题)");
    
    let body_text = "";
    try {
      const rawText = await new Response(message.raw).text();
      const contentTypeHeader = message.headers.get("content-type") || "";
      
      // 正则匹配并提取多段式邮件的 boundary 边界分隔符
      const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i) || rawText.match(/boundary="?([^"\r\n]+)"?/i);
      
      if (boundaryMatch) {
        // 多段式邮件解析路由 (例如来自 Gmail / QQ 邮箱的高复杂度嵌套结构)
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
            // 如果此段落数据被 Base64 编码，执行动态还原
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
        // 优先采用 text/plain 段，如果没有则降级使用 text/html 富文本段
        body_text = extractedPlain || extractedHtml || "[邮件内容为空]";
        
      } else {
        // 简单邮件解析路由 (没有嵌套边界符的普通直发明文或基础 Base64 邮件)
        const isBase64 = rawText.includes("Content-Transfer-Encoding: base64");
        let contentPart = rawText.includes("\r\n\r\n") ? rawText.split("\r\n\r\n").slice(1).join("\r\n\r\n") : rawText;
        
        if (isBase64) {
          if (contentPart.includes("\r\n--")) contentPart = contentPart.split("\r\n--")[0];
          body_text = safeDecodeBase64(contentPart);
        } else {
          body_text = contentPart;
        }
      }

      // 💡 临门一脚：对最终抓到的文本进行全量 HTML 标签脱水清洗，确保前端看信完美
      body_text = stripHtmlTags(body_text);

    } catch (err) {
      body_text = `[邮件解析异常崩溃]: ${err.message}`;
    }

    // 将完全清洗、解码好、无任何前端标签隐患的干净内容打入 Cloudflare D1 数据库
    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
    ).bind(to_address, from_address, subject, body_text).run();
  },

  // 核心 2：处理网页前端的 HTTP 交互请求（API 路由端）
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

    // API: 获取邮件列表
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const { results } = await env.DB.prepare("SELECT * FROM emails WHERE to_address LIKE ? ORDER BY received_at DESC")
        .bind(`${username}@%`).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // API: 修改邮件状态（已读、星标、软删除）
    if (url.pathname === "/api/emails/status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // API: 发信接口（💡 精准绑定你当前在 Resend 免费版中唯一通过验证的二级资产域名）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const from_user = body.from_user || (body.from ? body.from.split('@')[0] : "admin");
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";

        const clean_user = from_user.split('@')[0].trim();
        
        // 💡 核心绝杀：由于你的 Resend 免费版额度被限制，我们把外发发件人后缀强制上锁
        // 完美匹配你已经在 Resend 列表中处于 'Partially Verified' 的 mail.shudao.ai 资产资产，直接白嫖其出网权！
        const from_email = `${clean_user}@mail.shudao.ai`;

        if (!to_email || !content) {
          return new Response(JSON.stringify({ success: false, message: "缺少必要参数（收件人或内容为空）" }), { status: 400, headers: corsHeaders });