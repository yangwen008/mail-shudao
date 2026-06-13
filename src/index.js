// ========================================================
// 🔐 第一部分：安全加固防线（边缘端纯原生 SHA-256 加盐哈希算法）
// ========================================================
async function hashPassword(password) {
  const msgBuffer = new TextEncoder().encode(password + "ShuDaoSalt2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ========================================================
// 🛠️ 第二部分：辅助工具函数（邮件 MIME 解码与 HTML 脱水安全防御）
// ========================================================
function decodeMimeHeader(headerText) {
  if (!headerText) return "(无主题)";
  const regex = /=\?UTF-8\?B\?([^\?]+)\?=/gi;
  return headerText.replace(regex, (match, p1) => {
    try {
      const binString = atob(p1);
      return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
    } catch { return match; }
  });
}

function safeDecodeBase64(base64Str) {
  try {
    const cleanStr = base64Str.replace(/\s/g, "");
    const binString = atob(cleanStr);
    return new TextDecoder().decode(Uint8Array.from(binString, (m) => m.codePointAt(0)));
  } catch { return ""; }
}

function stripHtmlTags(htmlStr) {
  if (!htmlStr) return "";
  let text = htmlStr;
  text = text.replace(/<(p|div|br|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return text.split("\n").map(line => line.trim()).filter(line => line !== "").join("\n");
}

// ========================================================
// ⚙️ 第三部分：自动化工厂（蜀道集采定时爬虫 + 包含/排除双向雷达对账中枢）
// ========================================================
async function runShudaoRadarPipeline(env) {
  console.log("📡 [边缘雷达长跑] 定时发条已震动，开启强攻蜀道数据链...");
  
  const targetUrl = "https://ztb.shudaolink.com/api/v1/notice/page";
  const payload = { pageNo: 1, pageSize: 40, noticeType: "1", title: "", projectType: "" };

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://ztb.shudaolink.com/notice",
        "Origin": "https://ztb.shudaolink.com"
      },
      body: JSON.stringify(payload)
    });

    const parsed = await response.json();
    if (!parsed || !parsed.data || !parsed.data.list) return;
    const rawList = parsed.data.list;

    const itKeywords = ["算力", "软件", "信息化", "系统集成", "服务器", "网络", "数字", "智能", "数据库"];
    const designKeywords = ["设计", "三维", "BIM", "规划", "勘察", "效果图", "咨询"];

    for (const item of rawList) {
      const title = item.noticeTitle || "";
      const sourceId = item.id || "";
      const budget = item.budgetAmount ? `${item.budgetAmount}元` : "详见标书内容";
      const originUrl = `https://ztb.shudaolink.com/notice/detail/${sourceId}`;

      let industryCategory = "CONSTRUCT"; 
      if (itKeywords.some(k => title.includes(k))) {
        industryCategory = "IT";
      } else if (designKeywords.some(k => title.includes(k))) {
        industryCategory = "DESIGN";
      }

      await env.DB.prepare(`
        INSERT OR IGNORE INTO aggregate_tenders 
        (source_platform, industry_category, origin_id, title, budget, region, origin_url, is_approved) 
        VALUES ('shudao', ?, ?, ?, ?, '四川', ?, 1)
      `).bind(industryCategory, sourceId, title, budget, originUrl).run();
    }

    const unpushed = await env.DB.prepare("SELECT * FROM aggregate_tenders WHERE is_pushed = 0 AND is_approved = 1").all();
    const subscribers = await env.DB.prepare("SELECT * FROM user_subscriptions WHERE is_active = 1").all();

    if (unpushed.results.length > 0 && subscribers.results.length > 0) {
      const apiKey = env.RESEND_API_KEY;
      
      for (const user of subscribers.results) {
        const userKeywords = user.keywords.split(",").map(k => k.trim()).filter(k => k !== "");
        const userExcludeKeywords = user.exclude_keywords ? user.exclude_keywords.split(",").map(k => k.trim()).filter(k => k !== "") : [];

        const matchedTenders = unpushed.results.filter(t => {
          const hasInclude = userKeywords.some(k => t.title.includes(k));
          const hasExclude = userExcludeKeywords.some(k => t.title.includes(k));
          return hasInclude && !hasExclude; 
        });

        if (matchedTenders.length > 0 && apiKey) {
          let tenderRows = "";
          matchedTenders.forEach(t => {
            let catTag = t.industry_category === 'IT' ? '🖥️ IT新基建' : (t.industry_category === 'DESIGN' ? '🎨 工业设计' : '🏗️ 传统土建');
            tenderRows += `
              <div style="background:#ffffff; border:1px solid #e2e8f0; padding:15px; border-radius:8px; margin-bottom:12px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
                <span style="font-size:11px; font-weight:bold; color:#2563eb; background:#dbeafe; padding:2px 6px; border-radius:4px;">${catTag}</span>
                <div style="margin-top:8px; font-weight:bold; color:#0f172a; font-size:15px;">💡 ${t.title}</div>
                <div style="color:#64748b; font-size:13px; margin-top:4px;">预算金额：<span style="color:#ef4444; font-weight:bold;">${t.budget}</span> | 地域：${t.region}</div>
                <a href="${t.origin_url}" style="color:#2563eb; font-size:13px; text-decoration:none; display:inline-block; margin-top:8px; font-weight:600;">➡️ 远程开火 直达原始公告页面</a>
              </div>
            `;
          });

          const htmlContent = `
            <div style="font-family:sans-serif; padding:24px; color:#1e293b; background:#f8fafc; max-width:600px; margin:0 auto; border-radius:12px; border:1px solid #e2e8f0;">
              <h3 style="color:#2563eb; margin-bottom:4px; font-size:18px;">📡 蜀道智能雷达拦截快报</h3>
              <p style="font-size:14px; color:#475569;">尊贵的雷达会员 <strong>${user.username}</strong>：系统已为你精准拦截到以下高价值情报：</p>
              <div style="margin-top:16px;">${tenderRows}</div>
              <p style="font-size:11px; color:#94a3b8; margin-top:24px; border-top:1px dashed #e2e8f0; padding-top:12px;">* 本情报由 Cloudflare 边缘网络自动对账喷发。你可以随时登录独立的招标面板 zb.shudao.ai 管理配置。</p>
            </div>
          `;

          const from_email = `tender-radar@${env.DOMAINS || 'shudao.ai'}`;
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `蜀道雷达中枢 <${from_email}>`,
              to: [`${user.username}@${env.DOMAINS || 'shudao.ai'}`], 
              subject: `【蜀道雷达】成功拦截 ${matchedTenders.length} 条高价值商业标讯`,
              html: htmlContent
            })
          });

          await env.DB.prepare(
            "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
          ).bind(`${user.username}@${env.DOMAINS || 'shudao.ai'}`, from_email, `【蜀道雷达】成功拦截通知`, htmlContent).run();
        }
      }
      
      await env.DB.prepare("UPDATE aggregate_tenders SET is_pushed = 1 WHERE is_pushed = 0").run();
      console.log("✅ [大闭环收工] 雷达对账状态已全局锁死！");
    }
  } catch (err) {
    console.error("💥 边缘雷达管道遭受外部异常冲击:", err.message);
  }
}

// ========================================================
// 🚀 第四部分：Worker 中央总控制矩阵（多维入口接驳）
// ========================================================
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runShudaoRadarPipeline(env));
  },

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
        let extractedHtml = ""; let extractedPlain = "";
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
    } catch (err) { body_text = `[邮件解析异常]: ${err.message}`; }

    await env.DB.prepare(
      "INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)"
    ).bind(to_address, from_address, subject, body_text).run();
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname; 
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const getJson = async () => { try { return await request.json(); } catch { return {}; } };

    // ========================================================
    // 🛡️ 终极绝杀：强行切断 Assets 自动顺位，按【物理域名】前置死锁
    // ========================================================
    if (hostname.startsWith("zb.")) {
      if (url.pathname === "/" || url.pathname === "/login.html" || url.pathname === "/index.html") {
        return env.assets.fetch(new Request(new URL("/zb_login.html", request.url)));
      }
      if (url.pathname === "/dashboard.html" || url.pathname === "/zb_index") {
        return env.assets.fetch(new Request(new URL("/zb_index.html", request.url)));
      }
    } else {
      if (url.pathname === "/" || url.pathname === "/login.html") {
        return env.assets.fetch(new Request(new URL("/login.html", request.url)));
      }
    }

    // ================= API 控制中枢 =================
    if (url.pathname === "/api/register" && request.method === "POST") {
      const { username, password } = await getJson();
      try {
        const secureHash = await hashPassword(password);
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").bind(username, secureHash).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch {
        return new Response(JSON.stringify({ success: false, message: "凭证名前缀已被占用" }), { status: 400, headers: corsHeaders });
      }
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await getJson();
      const secureHash = await hashPassword(password);
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").bind(username, secureHash).first();
      if (user) return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      return new Response(JSON.stringify({ success: false }), { status: 401, headers: corsHeaders });
    }

    if (url.pathname === "/api/subscribe/save" && request.method === "POST") {
      const { username, keywords, exclude_keywords, push_strategy } = await getJson();
      if (!username) return new Response(JSON.stringify({ success: false, message: "通行证账号不全" }), { status: 400, headers: corsHeaders });
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO user_subscriptions (username, keywords, exclude_keywords, push_strategy, is_active, updated_at)
          VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        `).bind(username.trim(), keywords || "", exclude_keywords || "", push_strategy ?? 1).run();
        return new Response(JSON.stringify({ success: true, message: "📡 边缘雷达双向规则已无损锁死锁密！" }), { headers: corsHeaders });
      } catch (err) { return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: corsHeaders }); }
    }

    if (url.pathname === "/api/subscribe/get" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const sub = await env.DB.prepare("SELECT * FROM user_subscriptions WHERE username = ?").bind(username).first();
      return new Response(JSON.stringify(sub || { keywords: "", exclude_keywords: "", push_strategy: 1 }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/radar/force-trigger" && request.method === "POST") {
      ctx.waitUntil(runShudaoRadarPipeline(env));
      return new Response(JSON.stringify({ success: true, message: "云端特种突击集采对账命令已成功拉起点火！" }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/tenders/list" && request.method === "GET") {
      const category = url.searchParams.get("category") || "IT";
      const isAdminFlag = url.searchParams.get("admin") === "true";
      let sql = ""; let params = [category];
      if (isAdminFlag) {
        sql = "SELECT * FROM aggregate_tenders WHERE industry_category = ? ORDER BY is_top DESC, scraped_at DESC";
      } else {
        sql = "SELECT * FROM aggregate_tenders WHERE industry_category = ? AND is_approved = 1 ORDER BY is_top DESC, scraped_at DESC";
      }
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    if (url.pathname === "/api/tenders/create" && request.method === "POST") {
      try {
        const { title, industry_category, budget, contact_info } = await getJson();
        const fakeOriginId = "self_" + Math.random().toString(36).substring(2, 10);
        await env.DB.prepare(`
          INSERT INTO aggregate_tenders 
          (source_platform, industry_category, origin_id, title, budget, region, origin_url, contact_info, is_approved, is_top) 
          VALUES ('self', ?, ?, ?, ?, '四川', '#自发详情', ?, 1, 1)
        `).bind(industry_category, fakeOriginId, title, budget, contact_info).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (err) { return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: corsHeaders }); }
    }

    if (url.pathname === "/api/tenders/update-status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      if (field === 'permanent_delete') {
        await env.DB.prepare("DELETE FROM aggregate_tenders WHERE id = ?").bind(id).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      if (['is_approved', 'is_top', 'industry_category', 'project_status'].includes(field)) {
        await env.DB.prepare(`UPDATE aggregate_tenders SET ${field} = ? WHERE id = ?`).bind(value, id).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ success: false, message: "非合规控制指令" }), { status: 400, headers: corsHeaders });
    }

    // ================= 原有邮箱接口 =================
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const filter = url.searchParams.get("filter") || "inbox";
      const userAddress = `${username}@shudao.ai`;
      const deletedAddress = `${username}_deleted@shudao.ai`;
      let sql = ""; let params = [];

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
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

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
          let updateField = "to_address"; let newAddress = `${targetUser}_deleted@shudao.ai`;
          if (currentMail.from_address.includes(targetUser)) updateField = "from_address";
          await env.DB.prepare(`UPDATE emails SET ${updateField} = ? WHERE id = ?`).bind(newAddress, id).run();
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
      }
      await env.DB.prepare(`UPDATE emails SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await getJson();
        const to_email = body.to_email || body.to;
        const subject = body.subject || "(无主题)";
        const content = body.content || "";
        const attachments = body.attachments || [];
        let rawUser = "admin";
        if (body.from_user) rawUser = body.from_user.split('@')[0];
        else if (body.from) rawUser = body.from.split('@')[0];
        const clean_user = rawUser.trim();
        const from_email = `${clean_user}@shudao.ai`;

        if (!to_email || !content) return new Response(JSON.stringify({ success: false, message: "参数不全" }), { status: 400, headers: corsHeaders });
        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) return new Response(JSON.stringify({ success: false, message: "缺失KEY" }), { status: 500, headers: corsHeaders });

        const resendPayload = { from: `${clean_user} <${from_email}>`, to: [to_email.trim()], subject: subject, html: content };
        if (attachments && attachments.length > 0) {
          resendPayload.attachments = attachments.map(f => ({ filename: f.filename, content: f.content }));
        }
        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify(resendPayload)
        });
        if (resendResponse.ok) {
          await env.DB.prepare("INSERT INTO emails (to_address, from_address, subject, body_text) VALUES (?, ?, ?, ?)").bind(to_email.trim(), from_email, subject, content).run();
          return new Response(JSON.stringify({ success: true, message: "富文本邮件已成功投递外发！" }), { headers: corsHeaders });
        }
        return new Response(await resendResponse.text(), { status: 400, headers: corsHeaders });
      } catch (err) { return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: corsHeaders }); }
    }

    return env.assets.fetch(request);
  }
};