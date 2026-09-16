/**
 * 内测可用性冒烟验证。
 *
 * 单元测试用 `app.inject` 绕过网络，验不到「真的起一个进程、真的从浏览器访问」这条链路。
 * 这个脚本干的就是那件事：对**运行中的服务端**发真实 HTTP 请求，逐项确认
 * 调试客户端能打开、静态资源能取到、接口流程能走通。
 *
 * 用法（服务端要已经跑起来）：
 *   node scripts/smoke.mjs
 * 需要 ADMIN_ID / ADMIN_PASSWORD（从 .env 读，或直接给环境变量）来验证管理流程。
 *
 * 默认打本机 `http://127.0.0.1:3000`；验远程部署时给 `SERVER_BASE_URL`
 * （与 `seed-testers.mjs` / `acceptance.mjs` 用同一个变量名，省得记两套）：
 *   SERVER_BASE_URL=https://牌桌.example.com node --env-file=.env scripts/smoke.mjs
 */
const BASE = process.env.SERVER_BASE_URL ?? "http://127.0.0.1:3000";

/**
 * 认证头必须用**自定义头** `X-Auth-Token`，不能用 `Authorization: Bearer`。
 *
 * 托管平台的反向代理会占用 `Authorization` —— 实测服务端收到的是平台自己的令牌（不是我们的），
 * 于是「登录成功、后续全部 401」。服务端 `authToken()` 首选 `X-Auth-Token`，
 * 所以脚本照着发就行（本地直连时也一样工作）。
 */
const authHeaders = (token) => ({ "X-Auth-Token": token });

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
// 单端口部署时 socketUrl **故意留空**：前端按 `location.origin` 推导 ws/wss，
// 这样隧道、反向代理、HTTPS 全都自动正确。所以这里接受「留空」，
// 只有注入了别的、又不是 ws:// 地址才算错。
const socketUrl = /"socketUrl":"([^"]*)"/.exec(pageText)?.[1];
check(
  "/debug 注入了实时通道配置",
  socketUrl !== undefined && (socketUrl === "" || socketUrl.startsWith("ws://") || socketUrl.startsWith("wss://")),
  socketUrl === undefined ? "(缺失)"
    : socketUrl === "" ? "留空，由前端按 location.origin 推导（单端口部署）"
      : socketUrl,
);

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
      headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
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
      const authorization = authHeaders(token);

      const login = await json("/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      check("凭同一把密钥再登录", login.status === 200, `HTTP ${login.status}`);

      // 规则要求至少 500 积分才能进房，新账号是 0 分。这一步是内测前的必要操作。
      const granted = await json(`/v1/admin/users/${userId}/points`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
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

      // 群聊：建群 → 发消息 → 读回来。D2 的群聊页面就是靠这几个接口，
      // 顺手也验了消息带不带发送者昵称（没有昵称页面就显示不出「谁在说话」）。
      const group = await json("/v1/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorization },
        body: JSON.stringify({ name: "冒烟群" }),
      });
      check("建群", group.status === 201, `HTTP ${group.status}`);
      if (group.body?.groupId) {
        const sent = await json(`/v1/groups/${group.body.groupId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authorization },
          body: JSON.stringify({ type: "text", content: "冒烟消息" }),
        });
        check("发群消息（看发送者昵称有没有补上）",
          sent.status === 201 && Boolean(sent.body?.senderNickname),
          `HTTP ${sent.status} 昵称 ${sent.body?.senderNickname ?? "(缺失)"}`);

        const listed = await json(`/v1/groups/${group.body.groupId}/messages`, { headers: authorization });
        check("读群消息历史", listed.status === 200 && Array.isArray(listed.body?.messages),
          `HTTP ${listed.status} 条数 ${listed.body?.messages?.length ?? "?"}`);
      }

      // 图片与语音都靠这一个接口：服务端只签发直传地址，真实字节由客户端直接打给存储。
      // 没配存储时返回 501 —— 那意味着内测期间「发不了图、发不了语音」。
      const uploadCases = [
        ["image", "image/png", 2048, "图片"],
        ["voice", "audio/webm", 4096, "语音"],
      ];
      for (const [kind, contentType, byteSize, label] of uploadCases) {
        const ticket = await json("/v1/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authorization },
          body: JSON.stringify({ kind, contentType, byteSize }),
        });
        check(`签发${label}直传地址（没配存储会是 501）`,
          ticket.status === 201 && Boolean(ticket.body?.objectKey),
          `HTTP ${ticket.status}`);
      }

      // 战绩是纯读取的持久化能力：内存模式下返回 501 是设计如此。
      const matches = await json("/v1/matches", { headers: authorization });
      check("拉战绩（200 或内存模式下的 501）", matches.status === 200 || matches.status === 501,
        `HTTP ${matches.status}`);
    }
  }
}

console.log(`\n结果：${failures === 0 ? "全部通过，内测可用" : failures + " 项失败"}`);
process.exit(failures === 0 ? 0 : 1);
