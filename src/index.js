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
        
        // 💡 核心修改点：这里优先采用纯文本，若只有 HTML，则通过正则过滤掉 HTML 标签再输出
        if (extractedPlain) {
          body_text = extractedPlain;
        } else if (extractedHtml) {
          body_text = extractedHtml.replace(/<\/?[^>]+(>|$)/g, ""); // 强行剥离 HTML 标签
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
        // 同步剥离标签
        body_text = body_text.replace(/<\/?[^>]+(>|$)/g, "");
      }
    } catch (err) {
      body_text = `[邮件解析异常]: ${err.message}`;
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
      const { username, password } = await