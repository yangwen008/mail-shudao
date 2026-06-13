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
      if (itKeywords.some(k => title.includes(k))) industryCategory = "IT";
      else if (designKeywords.some(k => title.includes(k))) industryCategory = "DESIGN";

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
          return userKeywords.some(k => t.title.includes(k)) && !userExcludeKeywords.some(k => t.title.includes(k)); 
        });

        if (matchedTenders.length > 0 && apiKey) {
          let tenderRows = "";
          matchedTenders.forEach(t => {
            let catTag = t.industry_category === 'IT' ? '🖥️ IT新基建' : (t.industry_category === 'DESIGN' ? '🎨 工业设计' : '🏗️ 传统土建');
            tenderRows += `
              <div style="background:#ffffff; border:1px solid #e2e8f0; padding:15px; border-radius:8px; margin-bottom:12px;">
                <span style="font-size:11px; font-weight:bold; color:#2563eb; background:#dbeafe; padding:2px 6px; border-radius:4px;">${catTag}</span>
                <div style="margin-top:8px; font-weight:bold; color:#0f172a; font-size:15px;">💡 ${t.title}</div>
                <div style="color:#64748b; font-size:13px; margin-top:4px;">预算金额：<span style="color:#ef4444; font-weight:bold;">${t.budget}</span></div>
                <a href="${t.origin_url}" style="color:#2563eb; font-size:13px; text-decoration:none; display:inline-block; margin-top:8px;">➡️ 直达原始公告</a>
              </div>
            `;
          });

          const htmlContent = `
            <div style="font-family:sans-serif; padding:24px; color:#1e293b; background:#f8fafc; max-width:600px; margin:0 auto; border-radius:12px; border:1px solid #e2e8f0;">
              <h3 style="color:#2563eb; margin-bottom:4px;">📡 蜀道智能雷达拦截快报</h3>
              <div style="margin-top:16px;">${tenderRows}</div>
            </div>
          `;
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `蜀道雷达中枢 <tender-radar@${env.DOMAINS || 'shudao.ai'}>`,
              to: [`${user.username}@${env.DOMAINS || 'shudao.ai'}`], 
              subject: `【蜀道雷达】成功拦截 ${matchedTenders.length} 条高价值商业标讯`,
              html: htmlContent
            })
          });
        }
      }
      await env.DB.prepare("UPDATE aggregate_tenders SET is_pushed = 1 WHERE is_pushed = 0").run();
    }
  } catch (err) { console.error(err.message); }
}

// ========================================================
// 🚀 第四部分：Worker 中央总控制矩阵（多维入口接驳）
// ========================================================
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runShudaoRadarPipeline(env)); },
  async email(message, env, ctx) { /* 保持无损 */ },

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
    // 🛡️ 终极维度死锁：非 API 请求时，按【物理主域名】进行绝对重写劫持
    // ========================================================
    if (!url.pathname.startsWith("/api/")) {
      if (hostname.startsWith("zb.")) {
        // 🚨 无论缓存或请求路径怎么作怪，只要是从 zb. 域名进来的静态请求，一律人肉死锁翻牌子！
        if (url.pathname === "/" || url.pathname === "/login.html" || url.pathname === "/index.html" || url.pathname === "/zb_login.html") {
          return env.assets.fetch(new Request(new URL("/zb_login.html", request.url)));
        }
        if (url.pathname === "/dashboard.html" || url.pathname === "/zb_index.html") {
          return env.assets.fetch(new Request(new URL("/zb_index.html", request.url)));
        }
      } else {
        // 私人邮局主域，如果访问根目录，强行指派给改名后的物理邮箱文件
        if (url.pathname === "/" || url.pathname === "/login.html" || url.pathname === "/mail_login.html") {
          return env.assets.fetch(new Request(new URL("/mail_login.html", request.url)));
        }
        if (url.pathname === "/index.html" || url.pathname === "/mail_index.html") {
          return env.assets.fetch(new Request(new URL("/mail_index.html", request.url)));
        }
      }
    }

    // ================= API 控制网关 =================
    if (url.pathname === "/api/register" && request.method === "POST") {
      const { username, password } = await getJson();
      try {
        const secureHash = await hashPassword(password);
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").bind(username, secureHash).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch { return new Response(JSON.stringify({ success: false, message: "凭证前缀占用" }), { status: 400, headers: corsHeaders }); }
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
      await env.DB.prepare(`
        INSERT OR REPLACE INTO user_subscriptions (username, keywords, exclude_keywords, push_strategy, is_active, updated_at)
        VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).bind(username.trim(), keywords || "", exclude_keywords || "", push_strategy ?? 1).run();
      return new Response(JSON.stringify({ success: true, message: "📡 边缘雷达双向规则已无损锁死！" }), { headers: corsHeaders });
    }
    if (url.pathname === "/api/subscribe/get" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const sub = await env.DB.prepare("SELECT * FROM user_subscriptions WHERE username = ?").bind(username).first();
      return new Response(JSON.stringify(sub || { keywords: "", exclude_keywords: "", push_strategy: 1 }), { headers: corsHeaders });
    }
    if (url.pathname === "/api/radar/force-trigger" && request.method === "POST") {
      ctx.waitUntil(runShudaoRadarPipeline(env));
      return new Response(JSON.stringify({ success: true, message: "云端特种集采点火成功！" }), { headers: corsHeaders });
    }
    if (url.pathname === "/api/tenders/list" && request.method === "GET") {
      const category = url.searchParams.get("category") || "IT";
      const isAdminFlag = url.searchParams.get("admin") === "true";
      let sql = isAdminFlag ? "SELECT * FROM aggregate_tenders WHERE industry_category = ? ORDER BY is_top DESC, scraped_at DESC" : "SELECT * FROM aggregate_tenders WHERE industry_category = ? AND is_approved = 1 ORDER BY is_top DESC, scraped_at DESC";
      const { results } = await env.DB.prepare(sql).bind(category).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }
    if (url.pathname === "/api/tenders/create" && request.method === "POST") {
      const { title, industry_category, budget, contact_info } = await getJson();
      await env.DB.prepare(`INSERT INTO aggregate_tenders (source_platform, industry_category, origin_id, title, budget, region, origin_url, contact_info, is_approved, is_top) VALUES ('self', ?, ?, ?, ?, '四川', '#自发详情', ?, 1, 1)`).bind(industry_category, "self_" + Math.random().toString(36).substring(2, 10), title, budget, contact_info).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    if (url.pathname === "/api/tenders/update-status" && request.method === "PATCH") {
      const { id, field, value } = await getJson();
      if (field === 'permanent_delete') await env.DB.prepare("DELETE FROM aggregate_tenders WHERE id = ?").bind(id).run();
      else if (['is_approved', 'is_top', 'industry_category'].includes(field)) await env.DB.prepare(`UPDATE aggregate_tenders SET ${field} = ? WHERE id = ?`).bind(value, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ================= 原有邮件系统 API 顺位接口 =================
    if (url.pathname === "/api/emails" && request.method === "GET") {
      const username = url.searchParams.get("username");
      const filter = url.searchParams.get("filter") || "inbox";
      const userAddress = `${username}@shudao.ai`; const deletedAddress = `${username}_deleted@shudao.ai`;
      let sql = ""; let params = [];
      if (filter === "trash") { sql = "SELECT * FROM emails WHERE to_address = ? OR from_address = ? ORDER BY received_at DESC"; params.push(deletedAddress, deletedAddress); }
      else if (filter === "sent") { sql = "SELECT * FROM emails WHERE from_address = ? AND to_address NOT LIKE '%_deleted%' ORDER BY received_at DESC"; params.push(userAddress); }
      else if (filter === "starred") { sql = "SELECT * FROM emails WHERE to_address = ? AND is_starred = 1 ORDER BY received_at DESC"; params.push(userAddress); }
      else { sql = "SELECT * FROM emails WHERE to_address = ? AND from_address NOT LIKE ? ORDER BY received_at DESC"; params.push(userAddress, `%${username}%`); }
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    return env.assets.fetch(request);
  }
};