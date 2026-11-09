// mail-shudao 冒烟测试（against http://localhost:8787）
const BASE = "http://localhost:8787";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const api = async (path, { method = "GET", token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { }
  return { status: res.status, data };
};

console.log("\n== 1. 注册审核 / 登录 / 会话 ==");
// 系统引导：空库首个注册用户（admin）自动通过
let r = await api("/api/register", { method: "POST", body: { username: "admin", password: "admin123456" } });
const adminToken = r.data && r.data.token;
ok("引导：首个注册 admin 自动通过并发令牌", !!adminToken, JSON.stringify(r.data));

r = await api("/api/register", { method: "POST", body: { username: "alice", password: "secret123" } });
ok("注册 alice → 待审核（无令牌）", r.data.success && r.data.pending && !r.data.token, JSON.stringify(r.data));

r = await api("/api/register", { method: "POST", body: { username: "bob", password: "secret456" } });
ok("注册 bob → 待审核", r.data.success && r.data.pending);

r = await api("/api/register", { method: "POST", body: { username: "carol", password: "carol123" } });
ok("注册 carol → 待审核（将被拒绝）", r.data.success && r.data.pending);

r = await api("/api/register", { method: "POST", body: { username: "alice", password: "whatever1" } });
ok("重复注册被拒", r.status === 400);

r = await api("/api/register", { method: "POST", body: { username: "dave", password: "123" } });
ok("弱口令被拒", r.status === 400);

r = await api("/api/login", { method: "POST", body: { username: "alice", password: "secret123" } });
ok("🔴 待审核用户不能登录 403", r.status === 403 && /审核/.test(r.data.message || ""), JSON.stringify(r.data));

r = await api("/api/login", { method: "POST", body: { username: "alice@shudao.ai", password: "wrongpass" } });
ok("错误口令被拒 401", r.status === 401);

// 后门口令必须已失效
r = await api("/api/login", { method: "POST", body: { username: "admin", password: "ShuDaoAdmin666!@#" } });
ok("🔴 旧后门口令已失效", r.status === 401, `status=${r.status}`);

console.log("\n== 1b. 管理员邮箱审核流 ==");
r = await api("/api/admin/pending", { token: adminToken });
ok("admin 待审列表 3 人", Array.isArray(r.data) && r.data.length === 3, JSON.stringify(r.data));
r = await api("/api/admin/pending");
ok("非 admin 查看待审 → 403", r.status === 403);

// 审核通知已投递进 admin 管理员邮箱
r = await api("/api/emails?filter=inbox", { token: adminToken });
const reviewMails = (r.data || []).filter(m => /【注册审核】/.test(m.subject || ""));
ok("管理员邮箱收到 3 封审核通知", reviewMails.length === 3, `got=${reviewMails.length}`);
const tokenOf = name => {
  const m = reviewMails.find(x => (x.subject || "").includes(`【注册审核】${name} `));
  const t = m && (m.body_html || "").match(/token=([0-9a-f]+)/);
  return t && t[1];
};
ok("审核链接含一次性令牌", !!tokenOf("alice") && !!tokenOf("bob") && !!tokenOf("carol"));

// 通过 alice
r = await api("/api/admin/review", { method: "POST", body: { token: tokenOf("alice"), decision: "approve" } });
ok("通过 alice 审核", r.status === 200);
r = await api("/api/login", { method: "POST", body: { username: "alice", password: "secret123" } });
ok("通过后 alice 可登录", r.status === 200 && r.data.token, JSON.stringify(r.data));
const aliceToken = r.data.token;

// 拒绝 carol
r = await api("/api/admin/review", { method: "POST", body: { token: tokenOf("carol"), decision: "reject" } });
ok("拒绝 carol 审核", r.status === 200);
r = await api("/api/login", { method: "POST", body: { username: "carol", password: "carol123" } });
ok("被拒用户不能登录", r.status === 403 && /未通过/.test(r.data.message || ""), JSON.stringify(r.data));

// 令牌单次有效（重放同令牌 → 无效）
const replayRes = await fetch(BASE + "/api/admin/review", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: tokenOf("alice"), decision: "approve" })
});
const replayText = await replayRes.text();
ok("审核令牌不可重放", /无效|过期/.test(replayText), replayText.slice(0, 60));

// 通过 bob
r = await api("/api/admin/review", { method: "POST", body: { token: tokenOf("bob"), decision: "approve" } });
r = await api("/api/login", { method: "POST", body: { username: "bob", password: "secret456" } });
const bobToken = r.data.token;
ok("通过后 bob 可登录", !!bobToken);

// 结果通知回申请人邮箱
r = await api("/api/emails?filter=inbox", { token: aliceToken });
ok("alice 收到审核结果通知", (r.data || []).some(m => /注册审核】申请已通过/.test(m.subject || "")));

r = await api("/api/me", { token: aliceToken });
ok("/api/me 返回 alice", r.data && r.data.username === "alice");

r = await api("/api/logout", { method: "POST", token: bobToken });
r = await api("/api/me", { token: bobToken });
ok("登出后令牌失效", r.status === 401);

console.log("\n== 2. 邮件列表与越权（IDOR 修复） ==");
r = await api("/api/emails?filter=inbox");
ok("无令牌取信被拒 401", r.status === 401);

r = await api("/api/emails?filter=inbox", { token: aliceToken });
const inboxMails = (r.data || []).filter(m => !(m.from_address || "").startsWith("system@"));
ok("alice 收件箱 2 封（不含系统通知）", inboxMails.length === 2, `got=${inboxMails.length}`);
const mail1 = inboxMails.find(m => m.subject === "测试来信1");
const mail2 = inboxMails.find(m => m.subject === "测试来信2");
ok("富文本已脱敏（script 剥离）", mail2 && mail2.body_html && !/script/i.test(mail2.body_html), JSON.stringify(mail2 && mail2.body_html));

r = await api("/api/emails?filter=sent", { token: aliceToken });
ok("alice 已发送 1 封", r.data.length === 1, `got=${r.data.length}`);

r = await api("/api/emails?filter=group", { token: aliceToken });
ok("群邮件返回空集（不再误显）", Array.isArray(r.data) && r.data.length === 0);

r = await api("/api/emails?filter=draft", { token: aliceToken });
ok("草稿箱为空", r.data.length === 0);

console.log("\n== 3. 状态修改：归属校验 + SQL 注入白名单 ==");
r = await api("/api/login", { method: "POST", body: { username: "bob", password: "secret456" } }); // 重新登录 bob（第一段已登出）
const bobToken2 = r.data.token;
r = await api("/api/emails/status", { method: "PATCH", token: bobToken2, body: { id: mail2.id, field: "is_starred", value: 1 } });
ok("bob 改无关邮件 → 403", r.status === 403, `status=${r.status}`);

r = await api("/api/emails/status", { method: "PATCH", token: aliceToken, body: { id: mail1.id, field: "is_starred", value: 1 } });
ok("alice 星标自己邮件", r.status === 200 && r.data.success);

r = await api("/api/emails/status", { method: "PATCH", token: aliceToken, body: { id: mail1.id, field: "is_starred=1; DROP TABLE users;--", value: 1 } });
ok("🔴 字段注入被白名单拦截", r.status === 400, `status=${r.status}`);

r = await api("/api/emails/status", { method: "PATCH", token: aliceToken, body: { id: mail1.id, field: "body_text", value: "hack" } });
ok("非白名单字段 body_text 被拒", r.status === 400);

r = await api("/api/emails?filter=starred", { token: aliceToken });
ok("星标列表含 1 封", r.data.length === 1);

console.log("\n== 4. 软删除精确匹配 ==");
// bob 的用户名是 bob，不能误伤含 bob 子串的场景——直接验证 execute_delete 改写的是收件方
r = await api("/api/emails/status", { method: "PATCH", token: aliceToken, body: { id: mail1.id, field: "execute_delete", value: "alice" } });
ok("软删除成功", r.status === 200);
r = await api("/api/emails?filter=trash", { token: aliceToken });
ok("回收站可见", r.data.length === 1);
r = await api("/api/emails?filter=inbox", { token: aliceToken });
ok("收件箱减为 1 封", (r.data || []).filter(m => !(m.from_address || "").startsWith("system@")).length === 1);
r = await api("/api/emails/status", { method: "PATCH", token: aliceToken, body: { id: mail1.id, field: "permanent_delete", value: "true" } });
r = await api("/api/emails?filter=trash", { token: aliceToken });
ok("彻底删除后回收站清空", r.data.length === 0);

console.log("\n== 5. 草稿全流程 ==");
r = await api("/api/drafts/save", { method: "POST", token: aliceToken, body: { to: "bob@shudao.ai", subject: "半成品", content: "<p>草稿内容</p>" } });
const draftId = r.data && r.data.id;
ok("存草稿", !!draftId, JSON.stringify(r.data));
r = await api("/api/drafts/save", { method: "POST", token: aliceToken, body: { id: draftId, to: "bob@shudao.ai", subject: "半成品v2", content: "<p>改过的草稿</p>" } });
ok("更新草稿", r.status === 200);
r = await api("/api/emails?filter=draft", { token: aliceToken });
ok("草稿箱 1 封且主题已更新", r.data.length === 1 && r.data[0].subject === "半成品v2");
r = await api("/api/emails?filter=sent", { token: aliceToken });
ok("草稿不出现在已发送", r.data.length === 1);
r = await api("/api/drafts/save", { method: "POST", token: bobToken2, body: { id: draftId, content: "劫持" } });
ok("他人改草稿 → 404", r.status === 404);
r = await api("/api/emails/status", { method: "PATCH", token: aliceToken, body: { id: draftId, field: "execute_delete", value: "x" } });
r = await api("/api/emails?filter=draft", { token: aliceToken });
ok("删除草稿", r.data.length === 0);

console.log("\n== 6. 发信（本地无 RESEND_API_KEY） ==");
r = await api("/api/send", { method: "POST", token: aliceToken, body: { to_email: "x@qq.com", subject: "t", content: "<p>hi</p>" } });
ok("缺 API Key 返回明确 500", r.status === 500 && /RESEND_API_KEY/.test(r.data.message || ""), JSON.stringify(r.data));
r = await api("/api/send", { method: "POST", body: { to_email: "x@qq.com", subject: "t", content: "<p>hi</p>" } });
ok("未登录发信被拒", r.status === 401);
r = await api("/api/send", { method: "POST", token: aliceToken, body: { to_email: "x@qq.com", subject: "t", content: "" } });
ok("空内容被拒 400", r.status === 400);

console.log("\n== 7. 附件下载鉴权 ==");
r = await api("/api/attachments?key=attachments/xxx/file.pdf", { token: aliceToken });
ok("无主附件 403/404", r.status === 403 || r.status === 404, `status=${r.status}`);
r = await api("/api/attachments?key=../../etc/passwd", { token: aliceToken });
ok("非法 key 被拒", r.status === 400);

console.log("\n== 8. 招标雷达 API ==");
r = await api("/api/tenders/list?category=IT");
ok("游客可看招标列表", r.status === 200 && Array.isArray(r.data));
r = await api("/api/tenders/create", { method: "POST", token: aliceToken, body: { title: "越权测试项目", industry_category: "IT" } });
ok("非 admin 发布被拒 403", r.status === 403);
r = await api("/api/tenders/create", { method: "POST", token: adminToken, body: { title: "蜀道智算集群扩容", industry_category: "IT", budget: "500万", region: "成都" } });
ok("admin 发布成功", r.status === 200 && r.data.success);
r = await api("/api/tenders/list?category=IT");
ok("列表含新项目", r.data.some(t => t.title === "蜀道智算集群扩容"), JSON.stringify(r.data.map(t => t.title)));

r = await api("/api/subscribe/save", { method: "POST", token: aliceToken, body: { keywords: "智算,BIM", exclude_keywords: "维修", push_strategy: 2 } });
ok("订阅策略保存", r.data.success);
r = await api("/api/subscribe/get", { token: aliceToken });
ok("订阅策略回读", r.data.keywords === "智算,BIM" && r.data.push_strategy === 2, JSON.stringify(r.data));
r = await api("/api/subscribe/get", { token: bobToken2 });
ok("订阅按令牌隔离", r.data.keywords === "");

r = await api("/api/radar/force-trigger", { method: "POST", token: aliceToken });
ok("雷达触发（未配源→就绪提示）", r.data.success && /RADAR_SOURCES/.test(r.data.message || ""), JSON.stringify(r.data));
r = await api("/api/radar/force-trigger", { method: "POST" });
ok("未登录触发被拒", r.status === 401);

console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
