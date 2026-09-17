/**
 * 真浏览器走一遍**大厅这一整条路**：
 *
 *   登录 → 大厅 → 建群 → 群聊（文字 + 图片）→ 建房 → 分享名片到群里
 *   → 别人在群里点名片进房 → 另外两人用房号进房 → 四人到齐 → 房主开局
 *
 * 为什么必须真浏览器（而不是 jsdom 或纯 curl）：
 *   * 这条路上的东西长在**渲染层**里 —— 四方位座位、房主徽标、名片能不能点，
 *     接口全绿也照样可能一个都画不出来；
 *   * 房间要**四个人同时在线**，人数每变一次界面就得跟着变
 *     （"还差 N 位牌友" → "四人已到齐，房主开局"），这是多人协作才有的问题，
 *     单连接测不出来；
 *   * 图片走的是 `<input type=file>`，只有真浏览器的 DOM.setFileInputFiles 能触发。
 *
 * 会话是**内存态**（客户端没用 localStorage），所以同一个 Chrome 开四个标签页
 * 就是四个互不干扰的玩家，不用起四份浏览器。
 *
 * 用法：
 *   KEYS=MYMJ-...,MYMJ-...,MYMJ-...,MYMJ-... node tools/domcheck/check-lobby-flow.mjs
 *   PAGE=http://127.0.0.1:3012/debug KEYS=... SHOT=大厅流程.png node tools/domcheck/check-lobby-flow.mjs
 *
 * 副作用：会真的建一个群、发两条消息（其中一张图片）、建一个房间并在里面开局。
 *
 * ⚠️ **每组 4 把密钥只能跑一次**（除非跑在内存模式的本地实例上）。
 * 原因：跑到结尾牌局是**开着**的，四个账号身上都挂着「进行中的牌局」。
 * 本地内存模式重启服务即清空，所以能反复跑；但换成**带数据库的部署**
 * （NODE_ENV=production + PostgreSQL）就清不掉了，第二次跑会在建房那一步撞
 * `/v1/rooms → 409`，界面上只留一句「这个账号还在一局没打完的牌局里，先回那一局打完再来」，
 * 后面从 ④ 开始整片失败 —— 看着像功能坏了，其实只是账号脏了。
 * 对策：每次换一组全新密钥：
 *   node --env-file=.env scripts/seed-testers.mjs 探甲 探乙 探丙 探丁
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9337);
const PAGE = process.env.PAGE ?? "http://127.0.0.1:3012/debug";
const SHOT = process.env.SHOT ?? "";
const KEYS = (process.env.KEYS ?? "").split(",").map((each) => each.trim()).filter(Boolean);
// 探针量的是**应用本身**，中间任何代理都是不受控变量。
// 这台开发机的系统里长期挂着一个连不通的代理，Chrome 默认会用它，于是
// 「公网地址打不开」—— 排查半天发现是代理，跟应用一点关系没有（实测踩过一次）。
// 默认直连；确实需要走代理时给 PROXY_SERVER=host:port。
const PROXY_SERVER = process.env.PROXY_SERVER ?? "";
const proxyArgs = PROXY_SERVER ? [`--proxy-server=${PROXY_SERVER}`] : ["--no-proxy-server"];
if (KEYS.length < 4) throw new Error(`需要 4 把已激活的密钥（KEYS 逗号分隔），当前 ${KEYS.length} 把`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一枚 1x1 的透明 PNG —— 探针拿它当「用户选的那张图」。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAADAAEAAQAt8AAAAABJRU5ErkJggg==",
  "base64",
);
const imagePath = join(mkdtempSync(join(tmpdir(), "mymj-lobby-")), "probe.png");
writeFileSync(imagePath, PNG);

const profile = mkdtempSync(join(tmpdir(), "mymj-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  ...proxyArgs,
  "--window-size=1280,900",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "about:blank",
], { stdio: "ignore" });

async function http(endpoint) {
  const response = await fetch(`http://127.0.0.1:${PORT}${endpoint}`);
  return response.json();
}

async function firstTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await http("/json/list");
      const found = list.find((each) => each.type === "page" && each.webSocketDebuggerUrl);
      if (found) return found;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error("CDP 连不上");
}

/** 一个标签页 = 一个独立玩家（会话在各自页面的内存里）。 */
async function openPage(url) {
  // 新版 Chrome（≥152）的 /json/new 只收 PUT，GET 会回一句不带 JSON 的提示。
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then((r) => r.json());
  await sleep(200);
  const list = await http("/json/list");
  const meta = list.find((each) => each.id === created.id) ?? list[list.length - 1];
  const socket = new WebSocket(meta.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  // 转让群主会弹 `window.confirm`。无头浏览器默认一路返回 false，
  // 于是不点「接受」的话转让永远做不成 —— 看着像「点了没反应」。
  if (message.method === "Page.javascriptDialogOpening") {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); waiter(message); }
});
  const send = (method, params = {}, targetId) => new Promise((resolve, reject) => {
    const id = nextId++;
    const payload = targetId ? { id, method, params, targetId } : { id, method, params };
    socket.send(JSON.stringify(payload));
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本抛错");
    return result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Page.navigate", { url });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(300);
    const state = await evaluate("document.readyState").catch(() => "loading");
    if (state === "complete") break;
  }
  // 页面里的鼠标：按文字找节点、真点一下。全部走 DOM，不用坐标。
  await evaluate(`(() => {
    window.__all = (selector) => [...document.querySelectorAll(selector)];
    window.__find = (selector, text) => window.__all(selector)
      .find((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim().includes(text));
    window.__click = (selector, text) => { const node = window.__find(selector, text); if (!node) return false; node.click(); return true; };
    window.__text = (selector) => (window.__all(selector)[0]?.textContent || '').replace(/\\s+/g, ' ').trim();
    // ⚠️ 弹窗上的按钮必须在**弹窗内部**找：弹窗是 append 到 body 末尾的，
    // 按 document 顺序匹配会先命中页面上那个同名的入口按钮（比如又点了「创建群聊」），
    // 结果是又开一个弹窗、什么都没提交 —— 而且两个弹窗叠着，看着像「点了没反应」。
    window.__dialog = () => { const list = window.__all('dialog'); return list[list.length - 1]; };
    window.__dClick = (text) => {
      const dialog = window.__dialog(); if (!dialog) return false;
      const node = [...dialog.querySelectorAll('button')]
        .find((each) => (each.textContent || '').replace(/\\s+/g, ' ').trim() === text);
      if (!node) return false; node.click(); return true;
    };
    window.__dFill = (placeholder, value) => {
      const dialog = window.__dialog(); if (!dialog) return false;
      const input = dialog.querySelector('input[placeholder="' + placeholder + '"]');
      if (!input) return false;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    // 把页面自己发出的每个请求记下来：出问题时能一眼看出是没发、发了没回、还是回了错，
    // 而不是只能看到「界面没变化」。
    window.__calls = [];
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const started = Date.now();
      try {
        const response = await originalFetch(...args);
        const target = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        window.__calls.push((target.replace(location.origin, '') || '(相对地址)') + ' → ' + response.status + ' (' + (Date.now() - started) + 'ms)');
        return response;
      } catch (error) {
        const target = typeof args[0] === 'string' ? args[0] : '(Request)';
        window.__calls.push(target + ' → 网络错误: ' + error.message);
        throw error;
      }
    };
    window.__dCount = (selector) => { const dialog = window.__dialog(); return dialog ? dialog.querySelectorAll(selector).length : 0; };
    return true;
  })()`);
  return {
    send,
    evaluate,
    click: (selector, text) => evaluate(`window.__click(${JSON.stringify(selector)}, ${JSON.stringify(text)})`),
    dialogClick: (text) => evaluate(`window.__dClick(${JSON.stringify(text)})`),
    dialogFill: (placeholder, value) => evaluate(`window.__dFill(${JSON.stringify(placeholder)}, ${JSON.stringify(value)})`),
    dialogCount: (selector) => evaluate(`window.__dCount(${JSON.stringify(selector)})`),
    /** 读最后一个弹窗的整段文字；没有弹窗就返回空串（弹窗会被重建，别假设它一直在）。 */
    dialogText: () => evaluate("(() => { const dialog = window.__dialog(); return dialog ? (dialog.textContent || '').replace(/\\s+/g, ' ').trim() : ''; })()"),
    memberRows: () => evaluate("(() => { const dialog = window.__dialog(); return dialog ? [...dialog.querySelectorAll('.member-row')].map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()) : []; })()"),
    has: (selector, text) => evaluate(`!!window.__find(${JSON.stringify(selector)}, ${JSON.stringify(text)})`),
    text: (selector) => evaluate(`window.__text(${JSON.stringify(selector)})`),
    count: (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
  };
}

// 开 Chrome 之后必须**先等到 CDP 真的在听**：从 spawn 返回到端口可用有几百毫秒，
// 直接发第一个请求会 ECONNREFUSED（看着像 Chrome 起不来，其实只是还没起完）。
await firstTarget();

const page = await openPage(PAGE);
const failures = [];
const notes = [];

async function expect(description, ok, detail = "") {
  if (ok) console.log(`  ✅ ${description}`);
  else { console.log(`  ❌ ${description}${detail ? `  ← ${detail}` : ""}`); failures.push(description); }
  return ok;
}

/** 轮询等一个条件成立；超时就把最后一次看到的实际状态带上，方便直接看出卡在哪。 */
async function waitFor(description, probe, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await probe().catch((error) => `抛错: ${error.message}`);
    if (last === true) return true;
    await sleep(300);
  }
  return false;
}

/**
 * 点一个按钮直到页面真的变过去为止。
 *
 * 刚换完屏的那一小会儿，目标按钮可能还没画上（页面在等异步数据回来再渲染头部），
 * 盲点一次会点空 —— 页面纹丝不动，一个请求都不发（线上延迟大时尤其明显）。
 * 人不会在那个瞬间去点，但探针会，所以要带重试，不然线上跑必飘。
 */
async function clickUntil(tab, selector, text, condition, label) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await tab.click(selector, text);
    if (await waitFor(label, condition, 5_000)) return true;
  }
  return false;
}

const keyInput = 'input[placeholder="MYMJ-XXXX-XXXX-XXXX-XXXX"]';

async function login(tab, key) {
  await waitFor("登录页出现", () => tab.count(keyInput).then((n) => n === 1), 20_000);
  await tab.evaluate(`(() => {
    const input = document.querySelector('${keyInput}');
    input.value = ${JSON.stringify(key)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.__click('button', '进入');
    return true;
  })()`);
}

console.log("\n=== ① 玩家甲：密钥登录 → 大厅 ===");
await login(page, KEYS[0]);
await expect("登录进了大厅", await waitFor("大厅出现", () => page.has("h1", "大厅")));
await expect("大厅里有「创建房间」入口", await page.has("button", "＋ 创建房间"));
await expect("大厅里有 6 位房间号输入框", (await page.count('input[placeholder="6 位房间号"]')) === 1);
await expect("大厅里有「创建群聊」入口", await page.has("button", "创建群聊"));
await expect("大厅底部显示我的账号 ID", await page.has("span", "我的账号"));

console.log("\n=== ② 创建群聊 ===");
const groupName = `牌友群${Date.now() % 100000}`;
await page.click("button", "创建群聊");
await waitFor("建群弹窗出现", () => page.count('input[placeholder="填写群名称"]').then((n) => n === 1));
await page.dialogFill("填写群名称", groupName);
await page.dialogClick("创建");
// 建完群会**直接进群聊**（微信也是这么做的），所以要等聊天区真的出现。
// 不能用「会话列表有内容」当判据 —— 这个账号本来就有别的群，那个条件一开始就是真的，
// 于是后面去点「‹ 大厅」时人还在大厅，点了个寂寞（第一次就是这么绿的变红的）。
await waitFor("建群后进入群聊", () => page.count(".chat-shell").then((n) => n === 1), 20_000);
notes.push("建群后直接进群聊");
await clickUntil(page, "button", "‹ 大厅", () => page.has("h1", "大厅"), "回到大厅");
const groupVisible = await waitFor("会话列表出现新群", () => page.has(".conversation", groupName));
await expect("群里出现在大厅会话列表", groupVisible);
if (!groupVisible) {
  // 红的时候把现场摊开：在哪个屏、弹窗上说什么、请求走到哪一步了。
  // 「界面为什么不变」这类问题，光看断言失败是猜不出原因的。
  const scene = await page.evaluate(`(() => ({
    shell: document.querySelectorAll('.chat-shell').length,
    lobby: document.querySelectorAll('.lobby').length,
    dialogs: window.__all('dialog').map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 2),
    hints: window.__all('.hint').map((node) => (node.textContent || '').trim()).slice(0, 6),
    conversations: window.__all('.conversation').map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()),
    calls: (window.__calls || []).slice(-8),
  }))()`);
  console.log("  现场：", JSON.stringify(scene, null, 2));
}
notes.push(`群名 ${groupName}`);
const groupNo = await page.evaluate(`(() => {
  const row = window.__find('.conversation', ${JSON.stringify(groupName)});
  const match = /群号 (\\d+)/.exec(row?.textContent || '');
  return match ? match[1] : '';
})()`);
console.log(`  群号：${groupNo || "（没读到）"}`);
if (!groupNo) {
  console.log("\n停在这里：群没建出来，后面几步都要靠它，继续跑只会是连锁崩。");
  chrome.kill();
  process.exit(1);
}

console.log("\n=== ③ 群聊：发文字 + 发图片 ===");
await page.click(".conversation", groupName);
await expect("点开会话后进了群聊", await waitFor("群聊界面出现", () => page.count(".chat-shell").then((n) => n === 1)));
const hello = `大家好，来一桌 ${Date.now() % 1000}`;
const sent = await page.evaluate(`(() => {
  const input = document.querySelector('input[placeholder="发送消息"]');
  // 没有输入框时直接报出来 —— 抛 TypeError 的话，「哪个屏 / 有什么」都问不出来。
  if (!input) return '没有输入框';
  input.value = ${JSON.stringify(hello)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return window.__click('.chat-composer button', '发送') ? '已点发送' : '没找到发送键';
})()`);
if (sent !== "已点发送") console.log(`  发文字没走成：${sent}`);
const helloShown = await waitFor("消息气泡出现", () => page.has(".chat-message", hello));
if (!helloShown) {
  // 「发出去了但气泡没出来」有好几种原因：请求根本没发、发了报错、发了也回来了但被
  // 后到的历史页盖掉。这三种现场完全不同，所以把气泡文字、状态条、请求流水一起摊开。
  const scene = await page.evaluate(`(() => ({
    bubbles: window.__all('.chat-message').map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)),
    status: (document.querySelector('.chat-status')?.textContent || '').trim(),
    inputValue: (document.querySelector('input[placeholder="发送消息"]')?.value ?? '(没有输入框)'),
    imgs: window.__all('img.chat-image').length,
    calls: (window.__calls || []).slice(-6),
  }))()`);
  console.log("  现场：", JSON.stringify(scene, null, 2));
}
await expect("文字消息出现在聊天区", helloShown);

const fileInputReady = await page.evaluate(`(() => {
  // 同理：这个 input 不见了（没进群聊 / 聊天区被换掉）时要说人话，不要抛 TypeError。
  const input = document.querySelector('.chat-composer input[type=file]');
  if (!input) return false;
  input.hidden = false;
  input.setAttribute('data-probe', 'yes');
  return true;
})()`);
if (!fileInputReady) {
  const scene = await page.evaluate(`(() => ({
    shell: window.__all('.chat-shell').length,
    lobby: window.__all('.lobby').length,
    composer: window.__all('.chat-composer').length,
    status: (document.querySelector('.chat-status')?.textContent || '').trim(),
    hints: window.__all('.hint, .error').map((node) => (node.textContent || '').trim()).slice(0, 6),
  }))()`);
  console.log("  现场：", JSON.stringify(scene, null, 2));
  console.log("\n停在这里：图片上传的入口 input 找不到，继续跑只会是连锁崩。");
  chrome.kill();
  process.exit(1);
}
const { root } = await page.send("DOM.getDocument");
const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".chat-composer input[type=file]" });
await page.send("DOM.setFileInputFiles", { files: [imagePath], nodeId });
const uploaded = await waitFor("图片气泡出现", () => page.count("img.chat-image").then((n) => n >= 1));
await expect("图片消息出现在聊天区", uploaded);
if (!uploaded) {
  // 图片这条链路断在哪一层要分清：input 没触发、上传失败、还是上传成功但画不出来。
  const scene = await page.evaluate(`(() => ({
    status: (document.querySelector('.chat-status')?.textContent || '').trim(),
    notices: window.__all('.hint, .error').map((node) => (node.textContent || '').trim()).slice(0, 6),
    messages: window.__all('.chat-message').length,
    imgs: window.__all('img.chat-image').length,
    retryButtons: window.__all('.chat-message button').map((node) => (node.textContent || '').trim()).slice(0, 6),
  }))()`);
  console.log("  现场：", JSON.stringify(scene, null, 2));
} else {
  notes.push(`聊天区有 ${await page.count("img.chat-image")} 张图片`);
}

console.log("\n=== ④ 建房：四方位座位 + 房主标识 ===");
await clickUntil(page, "button", "‹ 大厅", () => page.has("h1", "大厅"), "回到大厅");
await page.click("button", "＋ 创建房间");
await waitFor("房间出现", () => page.count(".waiting-table").then((n) => n === 1));
await expect("房间按四个方向排座位", (await page.count(".waiting-seat")) === 4);
const directions = await page.evaluate(`window.__all('.waiting-seat').map((node) => [...node.classList].filter((name) => name !== 'waiting-seat')[0]).join(',')`);
await expect("四个方向是 东南西北", directions === "south,east,north,west", directions);
const seatText = await page.evaluate("(() => window.__all('.waiting-seat').map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()))()");
await expect("座位上显示 ID", seatText.some((text) => /ID \d/.test(text)), JSON.stringify(seatText));
await expect("房主有「房主」标识", (await page.count(".owner-badge")) === 1, `实际 ${await page.count(".owner-badge")} 个`);
await expect("没有「准备」按键", !(await page.has("button", "准备")));
await expect("房间里有「邀请牌友」", await page.has("button", "邀请牌友"));
await expect("人没齐时提示还差几位", await page.has(".hint", "还差 3 位牌友"));

const roomNo = await page.evaluate(`(() => {
  const match = /房间号 (\\d{6})/.exec(document.body.textContent || '');
  return match ? match[1] : '';
})()`);
notes.push(`房间号 ${roomNo}`);
await expect("生成了 6 位房间号", /^\d{6}$/.test(roomNo), roomNo);
const ownerCanStart = await page.evaluate(`(() => {
  const button = window.__find('button', '开始游戏');
  return button ? !button.disabled : null;
})()`);
await expect("人没齐时房主也开不了局", ownerCanStart === false, `实际 ${ownerCanStart}`);

console.log("\n=== ⑤ 把名片分享到群里 ===");
await page.click("button", "邀请牌友");
// ⚠️ 不能拿「弹窗里有按钮」当就绪条件 —— 弹窗自带的「关闭」就是一个按钮，
// 条件一开始就是真的；那时群列表还是一句「正在加载群聊…」，点群名点了个空，
// 于是什么都没发生、状态行一直是空的，看着像「分享失败」。
await waitFor("分享弹窗列出群聊", () => page.evaluate(`(() => {
  const dialog = window.__dialog(); if (!dialog) return false;
  return [...dialog.querySelectorAll('button')]
    .some((node) => (node.textContent || '').trim() === ${JSON.stringify(groupName)});
})()`), 20_000);
await page.dialogClick(groupName);
const shared = await waitFor("发送成功", () => page.has(".hint", "邀请名片已发送"));
await expect("名片发进群了", shared);
if (!shared) {
  console.log("  现场：", JSON.stringify(await page.evaluate(`(() => ({
    dialogs: window.__all('dialog').map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 2),
    hints: window.__all('.hint, .error').map((node) => (node.textContent || '').trim()).slice(0, 8),
    calls: (window.__calls || []).slice(-8),
  }))()`), null, 2));
}
await page.evaluate("(() => { window.__all('dialog').forEach((node) => node.remove()); return true; })()");

console.log("\n=== ⑥ 玩家乙：搜群号加入 → 在群里点名片直接进房 ===");
const second = await openPage(PAGE);
await login(second, KEYS[1]);
await waitFor("乙进了大厅", () => second.has("h1", "大厅"));
await second.click("button", "搜索群聊");
await waitFor("搜索弹窗出现", () => second.count('input[placeholder="输入群名称或 8 位群号"]').then((n) => n === 1));
await second.dialogFill("输入群名称或 8 位群号", groupNo);
await second.dialogClick("搜索");
await expect("按群号搜到了那个群", await waitFor("搜索结果出现", () => second.has(".group-result", groupName)));
await expect("搜索结果里带群号与人数", await second.has(".group-result", `${groupNo} ·`));
await second.dialogClick("加入群聊");
// 加完群同样**直接进群聊**（和建群一致），所以等聊天区出现，不要去大厅列表里找。
await expect("加群后直接打开群聊", await waitFor("乙的聊天区打开", () => second.count(".chat-shell").then((n) => n === 1), 20_000));
// 群信息要**异步**拉回来：打开聊天区的瞬间头部还是占位符，尤其线上延迟大的时候。
// 不看它是不是「刚加的那个群」，看的是它有没有停在占位状态 —— 所以要等，不是当场读。
await expect("打开的就是刚加的那个群", await waitFor("头部出现群名", () => second.has(".chat-header", groupName), 20_000));
await expect("群里有可点的邀请名片", await waitFor("名片出现", () => second.count(".room-invite-card").then((n) => n >= 1)));
await second.evaluate("(() => { window.__all('.room-invite-card')[0]?.click(); return true; })()");
await expect("点名片直接进了房间", await waitFor("乙的房间出现", () => second.count(".waiting-table").then((n) => n === 1)));
// 房主标识是给**所有人**看的（要能认出谁开的房），所以乙也该看到一个 ——
// 但全房间只能有一个，而且不在乙自己的座位上。
// 房间快照也是异步拉回来的：四个座位框先进来、人还没坐上时一个标识都没有，
// 所以同样要等它出现，不是当场数。
await waitFor("房主标识出现", () => second.count(".owner-badge").then((n) => n === 1), 20_000);
const badges = await second.count(".owner-badge");
await expect("乙那边也看得到且只有一个房主标识", badges === 1, `实际 ${badges} 个`);
// 座位是**从自己开始**排的（第一个座位就是自己），所以自己的座位上不该有房主标识。
await expect("乙自己的座位上没有房主标识", await second.evaluate("(() => { const first = window.__all('.waiting-seat')[0]; return first ? !first.querySelector('.owner-badge') : false; })()"));
await expect("乙看不到房主的开局按钮", !(await second.has("button", "开始游戏")));

console.log("\n=== ⑥b 群主转让与指定管理员 ===");
// 甲先回大厅去操作（房间里没有群聊入口），操作完再从大厅回到房间。
await page.click("button", "返回大厅");
await waitFor("甲回到大厅", () => page.has("h1", "大厅"), 20_000);
// 大厅刚重画时群列表还是空的（要等 groups 拉回来），没等到就点会点空 ——
// 表现是「点了会话没反应」，其实是还没画出来。
await waitFor("大厅里出现那个群", () => page.has(".conversation", groupName), 20_000);
await page.click(".conversation", groupName);
await waitFor("甲打开群聊", () => page.count(".chat-shell").then((n) => n === 1));
// 群成员表是**异步**拉回来的：在那之前 `screen.group` 还是 null，
// `settings()` 会直接 return —— 点了「群设置」什么都不会发生，也没有任何提示。
// 头部里的成员数在加载完成前是个省略号，等它变成数字就说明可以操作了。
await waitFor("群信息加载完", () => page.text(".chat-header").then((text) => !text.includes("…")), 20_000);
const clickedSettings = await page.click("button", "群设置");
await sleep(1200);
const opened = await waitFor("群设置打开", () => page.dialogText().then((text) => text.includes("群号")), 20_000);
if (!opened) {
  console.log("  现场：", JSON.stringify(await page.evaluate(`(() => ({
    clickedSettings: ${clickedSettings},
    shell: document.querySelectorAll('.chat-shell').length,
    lobby: document.querySelectorAll('.lobby').length,
    topLevel: [...(document.querySelector('#app')?.children ?? [])].map((node) => node.tagName.toLowerCase() + '.' + (node.className || '')),
    buttons: window.__all('button').map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 12),
    dialogs: window.__all('dialog').length,
  }))()`), null, 2));
}
const settingsText = await page.dialogText();
await expect("群设置里能看到成员与角色", settingsText.includes("群主") && settingsText.includes("成员"), settingsText.slice(0, 120));
// 只有乙这一行有这两个按钮（自己那行没有），所以按文字点不会点错人。
await page.dialogClick("设为管理员");
const asAdmin = await waitFor("乙变成管理员", () => page.memberRows()
  .then((rows) => rows.some((row) => row.includes("管理员"))));
await expect("群主能把成员设为管理员", asAdmin, JSON.stringify(await page.memberRows()));
await page.dialogClick("转让群主");
const transferred = await waitFor("乙变成群主", () => page.memberRows()
  .then((rows) => rows.filter((row) => row.includes("群主")).length === 1 && rows.some((row) => row.includes("群主"))));
await expect("群主能把群转让给别人（且全群只有一个群主）", transferred, JSON.stringify(await page.memberRows()));
await page.evaluate("(() => { window.__all('dialog').forEach((node) => node.remove()); return true; })()");
// 回到房间接着开那一局。
await clickUntil(page, "button", "‹ 大厅", () => page.has("h1", "大厅"), "甲回到大厅");
await waitFor("大厅里出现「返回房间」", () => page.has("button", `返回房间 ${roomNo}`), 20_000);
await page.click("button", `返回房间 ${roomNo}`);
const backInRoom = await waitFor("甲回到房间", () => page.count(".waiting-table").then((n) => n === 1), 20_000);
await expect("甲从大厅回到了原来的房间", backInRoom);
if (!backInRoom) {
  console.log("  现场：", JSON.stringify(await page.evaluate(`(() => ({
    topLevel: [...(document.querySelector('#app')?.children ?? [])].map((node) => node.tagName.toLowerCase() + '.' + (node.className || '')),
    heading: (document.querySelector('h1')?.textContent || '(无)').trim(),
    errors: window.__all('.error, .hint').map((node) => (node.textContent || '').trim()).slice(0, 8),
    bar: (document.querySelector('#bar')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    calls: (window.__calls || []).slice(-6),
  }))()`), null, 2));
}

console.log("\n=== ⑦ 丙、丁：用 6 位房间号入座 ===");
for (const [index, key] of [[2, KEYS[2]], [3, KEYS[3]]]) {
  const tab = await openPage(PAGE);
  await login(tab, key);
  await waitFor(`${index + 1} 号进了大厅`, () => tab.has("h1", "大厅"));
  await tab.evaluate(`(() => {
    const input = document.querySelector('input[placeholder="6 位房间号"]');
    input.value = ${JSON.stringify(roomNo)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.__click('button', '加入房间');
    return true;
  })()`);
  await waitFor(`${index + 1} 号进了房间`, () => tab.count(".waiting-table").then((n) => n === 1), 20_000);
  await expect(`${index + 1} 号按房间号入座成功`, true);
  if (index === 2) await sleep(200);
}

console.log("\n=== ⑧ 四人到齐 → 房主开局 ===");
const full = await waitFor("人数更新到 4", () => page.has(".waiting-center", "4/4 人"));
if (!full) {
  // 房主这边靠 2.5s 一次的轮询拿房间快照（等待期不走实时通道），
  // 所以「人数没变」要么是没在房间屏、要么是轮询停了、要么是快照拉回来还是旧的 —— 三种现场分开看。
  const scene = await page.evaluate(`(() => ({
    screen: (document.querySelector('#app')?.firstElementChild?.className || '(空)'),
    center: (document.querySelector('.waiting-center')?.textContent || '(没有等待区)').replace(/\\s+/g, ' ').trim(),
    seats: window.__all('.waiting-seat').length,
    hints: window.__all('.hint').map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 4),
    dialog: (window.__dialog()?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    calls: (window.__calls || []).slice(-6),
  }))()`);
  console.log("  现场：", JSON.stringify(scene, null, 2));
}
await expect("房主这边看到 4/4 人", full);
await expect("提示变成「等待房主开始」", await page.has(".hint", "四人已到齐，等待房主开始"));
const startEnabled = await page.evaluate(`(() => {
  const button = window.__find('button', '开始游戏');
  return button ? !button.disabled : false;
})()`);
await expect("四人到齐后开局按钮可用", startEnabled === true, `实际 ${startEnabled}`);
await page.click("button", "开始游戏");
await expect("开局后进入牌桌", await waitFor("牌桌出现", () => page.count(".tile").then((n) => n > 0), 25_000));
await expect("房间顶栏有分享名片 / 返回大厅 / 退出房间",
  (await page.has("button", "分享名片")) && (await page.has("button", "返回大厅")) && (await page.has("button", "退出房间")));
await expect("乙那边也同步开始打牌", await waitFor("乙的牌桌出现", () => second.count(".tile").then((n) => n > 0), 25_000));

if (SHOT) {
  await page.send("Page.captureScreenshot", { format: "png" });
}

console.log("\n=== 结论 ===");
for (const note of notes) console.log(`  · ${note}`);
console.log("");
if (failures.length === 0) {
  console.log("PASS: 登录 → 大厅 → 建群 → 群聊（文字 + 图片）→ 建房 → 分享名片 → 群里点名片进房 → 房号进房 → 四人到齐开局，全程没有准备键");
} else {
  for (const failure of failures) console.log(`FAIL: ${failure}`);
}

chrome.kill();
process.exit(failures.length === 0 ? 0 : 1);
