/**
 * 真浏览器走一遍**管理台**：登录 → 签发 1 把密钥 → 明文出来没有。
 *
 * 为什么必须真浏览器：这条路上出过的缺陷恰好长在 HTTP 层 ——
 * 管理台前端把令牌放进 `Authorization` 头，而托管平台的反代会占用那个头，
 * 于是**登录成功（那是唯一不带令牌的请求）、紧接着任何接口都 401**，
 * 页面立刻掉回「请登录」，管理员根本发不出密钥。
 * 用 curl 单打接口验不出来：那是我们自己拼的头，跟页面真正发出去的不是一回事。
 *
 * **会把失败与成功的请求都打印出来**（`fetch` 打个薄包装记状态码），
 * 所以红了能直接看出是哪一步 401，不用猜。
 *
 * 用法：
 *   node tools/domcheck/check-admin-console.mjs                    # 打本机 3012
 *   PAGE=https://mianyang-mahjong-table.app.workbuddy.host/admin \
 *     node tools/domcheck/check-admin-console.mjs                  # 打线上
 *
 * 需要 `apps/server/.env` 里的 ADMIN_ID / ADMIN_PASSWORD（密码不会打印出来）。
 * 副作用：每次跑会真签发 1 把密钥（备注写「探针自测」），本机内存模式重启即清空。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9336);
const WIDTH = Number(process.env.VIEW_W ?? 1200);
const HEIGHT = Number(process.env.VIEW_H ?? 900);
const PAGE = process.env.PAGE ?? "http://127.0.0.1:3012/admin";
const SHOT = process.env.SHOT ?? "";
/** 凭据从 .env 读；路径相对本文件，不写死绝对路径。 */
const ENV_PATH = fileURLToPath(new URL("../../apps/server/.env", import.meta.url));

const env = Object.fromEntries(readFileSync(ENV_PATH, "utf8")
  .split(/\r?\n/).filter((line) => line.includes("=") && !line.startsWith("#"))
  .map((line) => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
if (!env.ADMIN_ID || !env.ADMIN_PASSWORD) throw new Error(".env 里缺 ADMIN_ID / ADMIN_PASSWORD");

const profile = mkdtempSync(join(tmpdir(), "mymj-admin-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  PAGE,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((each) => each.type === "page" && each.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error("CDP 连不上");
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); waiter(message); }
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本抛错");
  return result.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await sleep(1200);

// 把页面自己发出的请求记下来：出问题时能一眼看出是哪一步 401，而不是只报「登录失败」。
await evaluate(`(() => {
  window.__calls = [];
  const original = window.fetch;
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    window.__calls.push(url.replace(location.origin, '') + ' → ' + response.status);
    return response;
  };
  return true;
})()`);

const failures = [];

await evaluate(`(() => {
  document.querySelector('#admin-id').value = ${JSON.stringify(env.ADMIN_ID)};
  document.querySelector('#admin-password').value = ${JSON.stringify(env.ADMIN_PASSWORD)};
  document.querySelector('#connect').click();
  return true;
})()`);
await sleep(1500);

const afterLogin = await evaluate(`({
  calls: window.__calls.slice(),
  status: document.querySelector('#status')?.textContent?.trim() ?? '',
  rows: document.querySelectorAll('#keys-body tr').length,
})`);
console.log("=== 登录后 ===");
console.log("  页面发出的请求：", afterLogin.calls.join(" ｜ ") || "（无）");
console.log("  状态行：", afterLogin.status || "（空）");
console.log("  密钥表行数：", afterLogin.rows);
if (!afterLogin.calls.some((line) => line.endsWith("200"))) {
  failures.push(`登录取不到数据：${afterLogin.calls.join(" ｜ ")}`);
}
if (/401/.test(afterLogin.calls.join(" "))) {
  failures.push(`有 401 —— 令牌没有送到（多半是又用了 Authorization 头，见 docs/DEPLOYMENT.md 五.1）：${afterLogin.calls.join(" ｜ ")}`);
}

await evaluate(`(() => {
  document.querySelector('#key-count').value = '1';
  document.querySelector('#key-note').value = '探针自测';
  document.querySelector('#issue-form button').click();
  return true;
})()`);
await sleep(1500);

const afterIssue = await evaluate(`({
  status: document.querySelector('#status')?.textContent?.trim() ?? '',
  issued: document.querySelector('#issued')?.textContent?.trim() ?? '',
  issuedWrapHidden: document.querySelector('#issued-wrap')?.hidden ?? null,
  rows: [...document.querySelectorAll('#keys-body tr')].map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim()),
})`);
console.log("=== 签发后 ===");
console.log("  状态行：", afterIssue.status || "（空）");
console.log("  明文区：", afterIssue.issued || "（空）");
console.log("  密钥表：", afterIssue.rows.join(" ｜ ") || "（空）");

// 明文只在签发响应里出现这一次（服务端只存哈希），所以界面必须当场把它显示出来。
if (!/^MYMJ-[A-Z0-9-]+/.test(afterIssue.issued)) failures.push(`没看到明文密钥：${afterIssue.issued || "（空）"}`);
if (afterIssue.issuedWrapHidden !== false) failures.push("明文的容器还是隐藏的");
if (!/已签发/.test(afterIssue.status)) failures.push(`状态行没报签发成功：${afterIssue.status}`);
if (!afterIssue.rows.some((row) => row.includes("探针自测"))) failures.push("密钥列表里没有刚签发的那把");

if (SHOT) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log(`  截图已存：${SHOT}`);
}

console.log("");
if (failures.length === 0) console.log("结论：管理台能登录、能签发，明文当场显示（令牌走的是自定义头）");
else { console.log("结论：有问题"); for (const line of failures) console.log(`  · ${line}`); }

socket.close();
chrome.kill();
process.exit(failures.length === 0 ? 0 : 1);
