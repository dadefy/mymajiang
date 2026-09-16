/**
 * 内测可用性冒烟验证。
 *
 * 单元测试用 `app.inject` 绕过网络，验不到「真的起一个进程、真的从浏览器访问」这条链路。
 * 这个脚本干的就是那件事：对**运行中的服务端**发真实 HTTP 请求，逐项确认
 * 调试客户端能打开、静态资源能取到、接口流程能走通。
 *
 * 用法（服务端要已经跑起来）：
 *   node scripts/smoke.mjs
 * 需要 ADMINT_ID / ADMIN_PASSWORD（从 .env 读，或直接给环境变量）来验证管理流程。
 */
const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";

let failures = 0;
function check(label, ok, extra = "") {
  console.log(`${ok ? "通过" : "失败"}  ${label}${extra ? "  —— " + extra : ""}`);
  if (!ok) failures += 1;
}

async function json(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

// ---------- 1. 调试客户端 ----------
const page = await fetch(`${BASE}/debug`);
const pageText = await page.text();
check("GET /debug 能打开", page.status === 200 && pageText.includes("内测调试客户端"), `HTTP ${page.status}`);
check("/debug 注入了实时通道地址", /"socketUrl":"ws:\/\/[^"]+"/.test(pageText),
  (/"socketUrl":"[^"]+"/.exec(pageText) ?? ["(缺失)"])[0]);

const entryUrl = `${BASE}/debug/browser/debug-client.js`;
const entry = await fetch(entryUrl);
check("入口脚本可获取", entry.status === 200 && (entry.headers.get("content-type") ?? "").includes("javascript"),
  `HTTP ${entry.status}`);

// 浏览器是按相对 URL 逐层加载的。这里用 URL 解析而不是字符串拼接 ——
// 拼接会把 "./x" 和 "../x" 当成一回事，漏掉真正的路径错误。
const entryText = await entry.text();
const specifiers = [...entryText.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
check("入口有相对导入", specifiers.length > 0, specifiers.join(", "));
for (const specifier of specifiers) {
  const resolved = new URL(specifier, entryUrl);
  const response = await fetch(resolved);
  check(`  模块 ${specifier}`, response.status === 200, `HTTP ${response.status} ${resolved.pathname}`);
}

check("GET /health", (await json("/health")).status === 200);

// ---------- 2. 真实接口流程 ----------
const adminId = process.env.ADMIN_ID;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminId || !adminPassword) {
  console.log("\n（未提供 ADMIN_ID / ADMIN_PASSWORD，跳过管理员与建房流程）");
} else {
  const session = await json("/v1/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminId, password: adminPassword }),
  });
  check("管理员登录", session.status === 201, `HTTP ${session.status}`);

  const adminToken = session.body?.token;
  if (!adminToken) {
    console.log("没拿到管理员令牌，后续步骤无法继续");
  } else {
    const issued = await json("/v1/admin/invitation-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ count: 1, note: "冒烟验证" }),
    });
    const key = issued.body?.keys?.[0]?.key;
    check("签发邀请密钥", issued.status === 201 && Boolean(key), `HTTP ${issued.status}`);

    if (key) {
      const activated = await json("/v1/auth/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, nickname: "冒烟账号", avatarUrl: "https://example.invalid/a.png" }),
      });
      check("用密钥激活建号", activated.status === 201, `HTTP ${activated.status}`);
      const token = activated.body?.token;
      const userId = activated.body?.userId;
      const authorization = { Authorization: `Bearer ${token}` };

      const login = await json("/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      check("凭同一把密钥再登录", login.status === 200, `HTTP ${login.status}`);

      // 规则要求至少 500 积分才能进房，新账号是 0 分。这一步是内测前的必要操作。
      const granted = await json(`/v1/admin/users/${userId}/points`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ delta: 2000, reason: "内测发放" }),
      });
      check("管理员发放积分（进房门槛 500）", granted.status === 201,
        `HTTP ${granted.status} 余额 ${granted.body?.balanceAfter}`);

      const created = await json("/v1/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorization },
        body: "{}",
      });
      check("建房", created.status === 201, `HTTP ${created.status} ${created.text.slice(0, 100)}`);

      if (created.body?.roomId) {
        const room = await json(`/v1/rooms/${created.body.roomId}`, { headers: authorization });
        check("读房间快照", room.status === 200, `HTTP ${room.status}`);
      }

      check("拉群列表", (await json("/v1/groups", { headers: authorization })).status === 200);
      // 战绩是纯读取的持久化能力：内存模式下返回 501 是设计如此。
      const matches = await json("/v1/matches", { headers: authorization });
      check("拉战绩（200 或内存模式下的 501）", matches.status === 200 || matches.status === 501,
        `HTTP ${matches.status}`);
    }
  }
}

console.log(`\n结果：${failures === 0 ? "全部通过，内测可用" : failures + " 项失败"}`);
process.exit(failures === 0 ? 0 : 1);
