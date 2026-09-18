/**
 * Laya 牌桌的表现层浏览器验收（真页面 + 三个协议机器人）。
 *
 * 要回答的是任务书第十三节那一串：摸牌 / 选牌 / 出牌 / 碰 / 杠 / 胡 / 当前玩家 /
 * 倒计时 / 托管 / 接管 / 结算 —— 这些**只有画出来才算数**。单测能证明事件发得对，
 * 证明不了引擎把它画在了正确的位置、也没挡住下一次操作。
 *
 * 组成：
 * - 一个无头 Chrome（横屏视口）跑 `apps/apk/release/web`，也就是 `laya:build:web` 的产物；
 * - 另外三家由 `@mianyang-mahjong/client` 的 `ClientFlow` 在 Node 里驱动（同一份客户端代码），
 *   它们**优先碰/杠/胡**，因为「等一局里真的有人碰」是等不到的；
 * - 页面上只装两个探针：`Laya.Tween.to` 与 `Laya.SoundManager.play*`。
 *   时长认动画、文件名认音效，两张表都出自本仓库的规范。
 *
 * 前置：`API` 上有一个 `tools/laya-preview.mjs`（同一个端口发静态页与 API）。
 *
 * ```
 * LAYA_PREVIEW_PORT=3123 node tools/laya-preview.mjs &   # 静态页 + API 同端口
 * PAGE=http://127.0.0.1:3123/laya/index.html API=http://127.0.0.1:3123 \
 * ACCOUNT=1800000001 PASSWORD=Preview123! BOTS=1800000002,1800000003,1800000004 \
 * RUN_SECONDS=1500 node tools/laya-presentation/check-laya-presentation.mjs
 * ```
 *
 * `RUN_SECONDS` 是**收尾段**（整场打到大结算）的预算，`MANUAL_SECONDS` 才是手动段的。
 * 大局结算只能等 8 小局真的打完，所以整跑约 20~30 分钟 —— 少给一分钟就只剩「未采到」。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, ClientFlow, jsonBodyFor } from "../../apps/client/dist/index.js";

const PAGE = process.env.PAGE ?? "http://127.0.0.1:3123/laya/index.html";
const API = process.env.API ?? "http://127.0.0.1:3123";
const ACCOUNT = process.env.ACCOUNT ?? "1800000001";
const PASSWORD = process.env.PASSWORD ?? "Preview123!";
const BOTS = (process.env.BOTS ?? "1800000002,1800000003,1800000004").split(",").filter(Boolean);
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 900);
/** 手动段（选牌 / 过 / 打出）的预算，秒。这一段故意做短：靠点鼠标是打不完一场的。 */
const MANUAL_SECONDS = Number(process.env.MANUAL_SECONDS ?? 150);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9411);
const VIEWPORT = [1280, 800];

const CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
].filter(Boolean);
const browser = CANDIDATES.find((each) => existsSync(each));
if (!browser) {
  console.log("跳过：本机没有 Chrome / Edge，画不出牌桌。");
  process.exit(0);
}

const started = Date.now();
const OUTDIR = join(process.cwd(), process.env.OUTDIR ?? join("laya-presentation", new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 13)));
mkdirSync(OUTDIR, { recursive: true });
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const shots = [];

/* ------------------------------------------------------------------ *
 * 浏览器
 * ------------------------------------------------------------------ */

const profile = mkdtempSync(join(tmpdir(), "mymj-presentation-"));
const chrome = spawn(browser, [
  "--headless=new",
  "--no-proxy-server",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORT[0]},${VIEWPORT[1]}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--autoplay-policy=no-user-gesture-required",
  "--force-device-scale-factor=1",
  PAGE,
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch { /* 已经退了 */ } });

async function firstPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((each) => each.type === "page" && each.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error("CDP 连不上浏览器");
}

const target = await firstPage();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, fail) => {
  socket.addEventListener("open", done, { once: true });
  socket.addEventListener("error", fail, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (message) => {
  const parsed = JSON.parse(message.data);
  const waiter = pending.get(parsed.id);
  if (waiter) { pending.delete(parsed.id); waiter(parsed); }
});
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((done, fail) => pending.set(id, (reply) =>
    reply.error ? fail(new Error(`${method}: ${JSON.stringify(reply.error)}`)) : done(reply.result)));
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本抛错");
  return result.result.value;
}
async function json(expression) {
  return JSON.parse(await evaluate(`JSON.stringify(${expression})`));
}
/** 真实鼠标事件：坐标是布局视口的 CSS 像素，由页面里的设计坐标换算过来。 */
async function tap(x, y) {
  const point = await json(`window.__mj.client(${x}, ${y})`);
  for (const [type, buttons] of [["mouseMoved", 0], ["mousePressed", 1], ["mouseReleased", 0]]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, buttons, clickCount: 1, button: "left" });
  }
}
async function tapText(text, prefix = false) {
  const point = await json(`window.__mj.find(${JSON.stringify(text)}, ${prefix ? "true" : "false"})`);
  if (!point) return false;
  await tap(point.x, point.y);
  return true;
}
async function focusAndType(prompt, value) {
  if (!(await tapText(prompt))) return false;
  await sleep(250);
  await send("Input.insertText", { text: value });
  await sleep(150);
  return await json(`window.__mj.inputValue(${JSON.stringify(prompt)})`) === value;
}
async function shot(name) {
  const file = join(OUTDIR, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(data, "base64"));
  shots.push({ name, file });
  log("截图", name);
  return file;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT[0], height: VIEWPORT[1], deviceScaleFactor: 1, mobile: false });
await sleep(3000);

/**
 * 页内工具与探针。
 *
 * 探针包在**引擎边界**（`Tween.to` / `SoundManager`）而不是表现层上：产物是压缩过的，
 * 类名不可读，而时长与文件名各自唯一标识一个事件 —— 两张对照表就在下面。
 */
await evaluate(`(() => {
  const stageOf = () => Laya.stage;
  const walk = (visit) => { (function step(node) { for (const child of (node._children || [])) { if (child.visible === false) continue; visit(child); step(child); } })(stageOf()); };
  window.__mj = {
    client(x, y) {
      const c = document.querySelector('canvas'), r = c.getBoundingClientRect(), s = stageOf();
      const k = Math.min(r.width / s.width, r.height / s.height);
      return { x: r.x + (r.width - s.width * k) / 2 + x * k, y: r.y + (r.height - s.height * k) / 2 + y * k };
    },
    find(text, prefix) {
      const wanted = String(text).replace(/\\s/g, '');
      const hitOne = (raw) => {
        const value = String(raw).replace(/\\s/g, '');
        return prefix ? value.startsWith(wanted) : value === wanted;
      };
      let hit = null;
      walk((child) => {
        if (hit || !child.visible) return;
        // 输入框没内容时那行字是 prompt（占位提示），不是 text。
        const labels = [String(child.text ?? ''), String(child.prompt ?? '')];
        if (labels.some(hitOne)) {
          const p = child.localToGlobal(new Laya.Point((child.width || 0) / 2, (child.height || 0) / 2));
          hit = { x: p.x, y: p.y };
        }
      });
      return hit;
    },
    inputValue(prompt) {
      const wanted = String(prompt).replace(/\\s/g, '');
      let value = null;
      walk((child) => {
        if (child instanceof Laya.TextInput && String(child.prompt ?? '').replace(/\\s/g, '') === wanted) value = String(child.text ?? '');
      });
      return value;
    },
    /** 手牌那一排的牌块：底部、尺寸落在牌面区间内，按 x 排序。用来点选与出牌。 */
    tiles() {
      const s = stageOf();
      const boxes = [];
      const seenAt = new Map();
      walk((child) => {
        if (!child.visible || !child.width || !child.height) return;
        if (child.text || child instanceof Laya.TextInput) return;
        const p = child.localToGlobal(new Laya.Point(child.width / 2, child.height / 2));
        if (p.y > s.height * 0.66 && p.y < s.height * 0.95 && child.width > 30 && child.width < 110 && child.height > child.width) {
          // 一张牌两层（外框 + 牌面图），同一个格心只算一次；牌面图的 skin 并到留下的那一层上。
          const at = Math.round(p.x) + ',' + Math.round(p.y);
          const skin = String(child.skin ?? '').replace(/^.*\\//, '').replace(/\\.png$/, '');
          const kept = seenAt.get(at);
          if (kept) { if (!kept.s && skin) kept.s = skin; return; }
          const box = { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(child.width), h: Math.round(child.height), s: skin };
          seenAt.set(at, box);
          boxes.push(box);
        }
      });
      const widths = {};
      for (const each of boxes) widths[each.w] = (widths[each.w] || 0) + 1;
      const best = Object.keys(widths).sort((a, b) => widths[b] - widths[a])[0];
      return boxes.filter((each) => String(each.w) === best).sort((a, b) => a.x - b.x);
    },
    texts() { const out = []; walk((c) => { if (c.text) out.push(String(c.text)); }); return out; },
    stageSize() { const s = stageOf(); return s.width + 'x' + s.height; },
  };
  const recs = [];
  window.__probe = { recs, taken: 0 };
  const origTo = Laya.Tween.to;
  Laya.Tween.to = function (tweenTarget, props, duration, ease, complete, data, ...rest) {
    recs.push({ k: 'tween', d: Math.round(duration || 0), keys: Object.keys(props || {}).join(',') });
    return origTo.call(this, tweenTarget, props, duration, ease, complete, data, ...rest);
  };
  for (const fn of ['playSound', 'playMusic', 'playRing']) {
    const orig = Laya.SoundManager[fn];
    if (typeof orig !== 'function') continue;
    Laya.SoundManager[fn] = function (url, ...args) { recs.push({ k: 'sound', fn, url: String(url) }); return orig.call(this, url, ...args); };
  }
  return 'installed';
})()`);
log("探针已装");

/* ------------------------------------------------------------------ *
 * 三个机器人：同一份 ClientFlow，只把传输换成 Node 的 fetch / WebSocket
 * ------------------------------------------------------------------ */

const httpTransport = {
  async request({ method, path, body, token, idempotencyKey }) {
    const headers = {};
    // 写请求要发一个真 body（哪怕是 `{}`），否则 Fastify 见 content-type 就 400。
    const payload = jsonBodyFor(method, body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(`${API}${path}`, { method, headers, body: payload });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  },
};
const socketFactory = {
  async connect(url) {
    const ws = new WebSocket(url);
    const messages = new Set();
    const closes = new Set();
    await new Promise((done, fail) => {
      ws.addEventListener("open", done, { once: true });
      ws.addEventListener("error", () => fail(new Error("ws 连接失败")), { once: true });
    });
    ws.addEventListener("message", (event) => {
      const value = typeof event.data === "string" ? event.data : event.data.toString();
      for (const listener of [...messages]) listener(JSON.parse(value));
    });
    ws.addEventListener("close", () => { for (const listener of [...closes]) listener(); });
    return {
      send: (payload) => ws.send(JSON.stringify(payload)),
      close: () => ws.close(),
      onMessage: (listener) => { messages.add(listener); return () => messages.delete(listener); },
      onClose: (listener) => { closes.add(listener); return () => closes.delete(listener); },
    };
  },
};
const uploadTransport = { async put() { return { status: 200 }; } };
const socketUrl = API.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

function makeBot(userId) {
  const flow = new ClientFlow(new ApiClient(httpTransport), socketFactory, socketUrl, uploadTransport);
  const bot = { userId, flow, acted: 0 };
  flow.onChange((screen) => { void botPlay(bot, screen); });
  return bot;
}

/**
 * 机器人策略：能胡就胡、能杠就杠、能碰就碰、**过也必须立刻过**，其余尽快出牌。
 *
 * 「只有过」也必须应答：服务端对**人类控制**的座位会等到操作时限走完（`ws-server` 里
 * 托管才是 0 延迟），一个不点「过」的机器人就是把整桌按住十几秒 —— 验收跑不动多半是这么来的。
 */
const BOT_CLAIM_ORDER = ["hu", "kong", "peng", "pass"];

/**
 * 每一次发送都按「这份要约」记一笔。
 *
 * 机器人是**每个状态帧回调一次**的：不加闸时一个座位 104 秒发了 34 万次，把整条 socket 灌满。
 * 但窗口也不能宽：`actions` 与 `match` 是分两帧到的，第一帧那次发送常被服务端当成「还没轮到你」挡回，
 * 窗口给到 1.5 秒的话这一座就白等到下一次重发 —— 整桌因此变成每步七八秒。250 毫秒够下一帧落地了。
 */
const RESEND_WINDOW_MS = 250;
const lastSend = new Map();

function sendOnce(bot, screen, fn) {
  const match = screen.match;
  const signature = [match.roundNumber, match.phase, match.currentPlayerSeat, screen.actions.join("+"), match.hand.length].join("|");
  const previous = lastSend.get(bot);
  if (previous && previous.signature === signature && Date.now() - previous.at < RESEND_WINDOW_MS) return;
  // 只数「第一次出手」，重发不算：心跳里的次数要能对上真实的步数。
  if (!previous || previous.signature !== signature) bot.acted += 1;
  lastSend.set(bot, { signature, at: Date.now() });
  fn();
}

const SUIT_ORDER = ["wan", "tong", "tiao"];

/**
 * 挑一张**服务端肯收**的牌打出去。
 *
 * 缺门没清完之前只收那一门的牌（`table-model.discardableIndexes` 就是这条），
 * 直接拿 `hand[0]` 十有八九被拒，这一座只能等满 15 秒让服务端代打。
 */
function pickDiscard(match) {
  const missing = match.missingSuit === null ? -1 : SUIT_ORDER.indexOf(match.missingSuit);
  if (missing >= 0) {
    for (const tile of match.hand) if (Math.floor(tile / 9) === missing) return tile;
  }
  return match.hand[0];
}

function botPlay(bot, screen) {
  if (screen.name !== "room" || screen.match === null) return;
  const match = screen.match;
  const actions = screen.actions;
  // 认 `actions` 而不是 `match.phase`：两者是页面上各自更新的两个字段，
  // 常错开一帧 —— 曾经按 phase 判断，于是 `choose-missing` 明明下发了却被当成「playing」丢掉，
  // 整桌按住 15 秒等时限。phase 只作为换三张/定缺的兜底。
  if (actions.includes("swap") || match.phase === "swapping") { sendOnce(bot, screen, () => bot.flow.autoSwap()); return; }
  if (actions.includes("choose-missing") || match.phase === "missing") { sendOnce(bot, screen, () => bot.flow.autoMissing()); return; }
  for (const kind of BOT_CLAIM_ORDER) {
    if (actions.includes(kind)) {
      sendOnce(bot, screen, () => bot.flow.claim(kind));
      return;
    }
  }
  if (actions.includes("selfDraw")) { sendOnce(bot, screen, () => bot.flow.selfDraw()); return; }
  if (actions.includes("kong-concealed")) { sendOnce(bot, screen, () => bot.flow.concealedKong()); return; }
  if (actions.includes("kong-added")) { sendOnce(bot, screen, () => bot.flow.addedKong()); return; }
  if (actions.includes("discard") && match.hand.length > 0) {
    sendOnce(bot, screen, () => bot.flow.discard(pickDiscard(match)));
  }
  if (actions.length > 0 && !handled.has(actions.join("+"))) {
    handled.add(actions.join("+"));
    log("机器人没处理到的 actions（会按住整桌到时限）", actions.join("+"), match.phase);
  }
}
const handled = new Set();

const bots = BOTS.map(makeBot);

/**
 * 每 20 秒把三家的处境打一行。
 *
 * 没有这行日志，「机器人在打牌」和「机器人一动不动、由服务端 15 秒时限代打」看起来一模一样 ——
 * 而这两种节奏差着几十倍，直接决定一场能不能在验收里打完。
 */
setInterval(() => {
  const summary = bots.map((bot) => {
    const screen = bot.flow.current;
    return `${bot.userId.slice(-2)}:${screen.name}${screen.match ? `/${screen.match.phase}` : ""}`
      + `[${(screen.actions ?? []).join("|") || "-"}]×${bot.acted}`;
  }).join("  ");
  log("机器人", summary);
}, 20_000).unref();

/** 等某一家的页面变成 `predicate` 认得的样子；超时返回 null。 */
async function waitFor(bot, ms, predicate) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const screen = bot.flow.current;
    if (predicate(screen)) return screen;
    await sleep(300);
  }
  return null;
}

for (const bot of bots) {
  await bot.flow.enterAccount(bot.userId, PASSWORD);
  await sleep(400);
}
/**
 * 上一轮被中断时，服务端那间房还挂着这几家。
 *
 * 登录**不会**自动回房间：`ClientFlow` 只在主页记下 `activeRoom`，等玩家点「回到房间」。
 * 于是三个机器人全停在 home，而服务端认为这三座还在局中 —— 这时去建房会被拒
 * （「这个账号还在一局没打完的牌局里」）。所以先自己走一遍那个按钮。
 */
for (const bot of bots) {
  const screen = bot.flow.current;
  if (screen.name === "home" && screen.activeRoom) await bot.flow.rejoinActiveRoom();
}
const settleUntil = Date.now() + 20_000;
while (Date.now() < settleUntil && !bots.some((each) => each.flow.current.name === "room")) await sleep(300);
const landed = bots.map((each) => each.flow.current).find((each) => each.name === "room");
let roomNo = landed ? landed.roomNo : null;
if (!roomNo) {
  log("三家落在", bots.map((each) => {
    const screen = each.flow.current;
    return `${each.userId.slice(-2)}:${screen.name}${screen.error ? `(${screen.error})` : ""}`;
  }).join("  "));
  await bots[0].flow.createRoom();
  const created = await waitFor(bots[0], 6_000, (screen) => screen.name === "room");
  if (!created) {
    const screen = bots[0].flow.current;
    // 建房的失败记在 `error` 上，`notice` 是实时通道那侧的 —— 只打后者就永远是一个 null。
    throw new Error(`机器人建房失败：${JSON.stringify({ at: screen.name, error: screen.error ?? null, notice: screen.notice ?? null })}`);
  }
  roomNo = created.roomNo;
} else {
  log("复用上一轮那间房", roomNo);
}
for (const bot of bots.slice(1)) {
  if (bot.flow.current.name === "room" && bot.flow.current.roomNo === roomNo) continue;
  await bot.flow.joinRoom(roomNo);
  await waitFor(bot, 6_000, (screen) => screen.name === "room" && screen.roomNo === roomNo);
}
log("房号", roomNo, "三家已进房");

/* ------------------------------------------------------------------ *
 * 浏览器这一座：登录 → 用房号进房 → 开局
 * ------------------------------------------------------------------ */

if (!(await focusAndType("账号 ID", ACCOUNT))) throw new Error("账号 ID 输不进去");
if (!(await focusAndType("登录密码", PASSWORD))) throw new Error("登录密码输不进去");
if (!(await tapText("账号登录"))) throw new Error("找不到账号登录按钮");
await sleep(3000);
await shot("key-entry");

if (await tapText("回到房间")) {
  log("这一座上一轮没打完，先回到房间");
  await sleep(2500);
} else if (await json(`window.__mj.find("6 位房间号") !== null`)) {
  if (!(await focusAndType("6 位房间号", roomNo))) throw new Error("找不到房间号输入框");
  if (!(await tapText("加入"))) throw new Error("找不到加入按钮");
} else {
  log("页面登录后直接回到了牌桌，不需要再输房号");
}
await sleep(3000);
await shot("room-waiting");

for (let attempt = 0; attempt < 10; attempt += 1) {
  await bots[0].flow.startMatch().catch(() => undefined);
  await sleep(1500);
  const screen = bots[0].flow.current;
  if (screen.name === "room" && screen.match && screen.match.phase !== "waiting") break;
}
await sleep(2500);
await shot("match-started");
log("舞台尺寸", await json("window.__mj.stageSize()"));

/* ------------------------------------------------------------------ *
 * 判据表
 *
 * 两条独立的证据链，各自能唯一对上事件，不互相冒充：
 * - **音效**认文件名（`placeholder_peng.wav` 只属于碰）；
 * - **动画**认「时长 + 被改属性」。产物是压缩过的，类名不可读，但每一段 Tween 的
 *   时长与属性都由 `LayaAnimationDriver` 写死：一个 cue 拆成进场 + 收尾 2~4 段，
 *   段长按比例算。于是 `250ms 改 x,y,alpha` 只可能是碰/杠的聚拢，
 *   `150ms 改 alpha,y` 只可能是小局结算卡片入场。
 * ------------------------------------------------------------------ */

/** 音效事件（任务书那套语义名 ← 仓库词表），文件名即判据。 */
const BY_SOUND = {
  placeholder_click: "ui_click", placeholder_back: "ui_back", placeholder_tile_select: "tile_select",
  placeholder_tile_draw: "tile_draw", placeholder_tile_discard: "tile_discard", placeholder_peng: "peng",
  placeholder_gang: "gang", placeholder_hu: "hu", placeholder_self_draw: "self_draw", placeholder_pass: "pass",
  placeholder_turn_notify: "turn_notify", placeholder_countdown_fast: "countdown_1", placeholder_countdown: "countdown_5",
  placeholder_trustee_on: "trustee_on", placeholder_trustee_off: "trustee_off",
  placeholder_round_finished: "round_finish", placeholder_match_finished: "match_finish",
  placeholder_message: "message_receive", placeholder_swap: "swap", placeholder_choose_missing: "choose_missing",
};

/** `时长|被改属性` → 动画事件。时长由 DURATION_MS 乘各段系数得到。 */
const BY_TWEEN = {
  // 呼吸环：一个来回 2000ms，驱动拆成去/回两段各 1000ms。它是常态循环，不计入「事件次数」。
  "1000|alpha,scaleX,scaleY": "active_player_ring",
  // 选牌 140：进场改 alpha,y，收尾只淡出（126 = 140×0.9）。
  "140|alpha,y": "tile_select", "126|alpha": "tile_select",
  "210|x,y,alpha": "tile_draw",
  "220|x,y,scaleX,scaleY": "tile_discard", "60|alpha": "tile_discard",
  // 碰 250 / 杠 290：金光两段（×0.35、×0.65）+ 牌聚拢（全时长）。
  "88|alpha": "peng", "163|alpha": "peng", "250|x,y,alpha": "peng",
  "102|alpha": "gang", "189|alpha": "gang", "290|x,y,alpha": "gang",
  // 胡 480：印章落下（×0.34，带缩放）、光圈胀开（×0.5）、光圈收（×0.3）、印章收（×0.28）。
  "163|alpha,scaleX,scaleY": "hu", "240|alpha,scaleX,scaleY": "hu", "144|alpha": "hu", "134|alpha": "hu",
  "64|alpha,y": "pass", "96|alpha": "pass",
  "72|alpha,y": "action_buttons", "108|alpha": "action_buttons",
  "320|alpha,scaleX,scaleY": "turn_notify",
  // 桌芯最后三秒 320：×0.45 胀开、×0.55 收 —— 与胡的 144 差在有没有缩放。
  "144|alpha,scaleX,scaleY": "countdown_final", "176|alpha": "countdown_final",
  // 托管 / 接管提示共用 260ms（×0.4 / ×0.6），两者只能靠音效分家。
  "104|alpha,y": "trustee_toast", "156|alpha": "trustee_toast",
  // 小局结算卡片 250：×0.6 上浮淡入、×0.4 收尾。
  "150|alpha,y": "round_finish", "100|alpha,y": "round_finish",
  // 大局结算卡片 420：×0.6 段独属它；×0.4 段（168）与换三张/定缺的横扫同形，只作旁证。
  "252|alpha,y": "match_finish",
  "168|alpha,y": "sweep_or_match", "252|alpha": "swap_or_choose_missing",
  // 页面切换帷幕 320：×0.35 / ×0.65，两段都只改 alpha。
  "112|alpha": "screen_transition", "208|alpha": "screen_transition",
  "248|alpha,y": "score_float", "372|alpha": "score_float",
  "100|alpha": "last_discard", "150|alpha": "last_discard",
  // 换三张 / 定缺横扫与上面 168/252 同形，音效已经能分家，这里不再重复登记。
};

/** 一个 cue 会放好几段 Tween，只有这一段负责计数，否则一次事件被记成三四次。 */
const PRIMARY_TWEEN = new Set([
  "140|alpha,y", "210|x,y,alpha", "220|x,y,scaleX,scaleY", "250|x,y,alpha", "290|x,y,alpha",
  "163|alpha,scaleX,scaleY", "64|alpha,y", "72|alpha,y", "320|alpha,scaleX,scaleY",
  "144|alpha,scaleX,scaleY", "104|alpha,y", "150|alpha,y", "252|alpha,y", "112|alpha", "248|alpha,y",
]);

/** 淡金粒子固定 8 颗、900~1320ms 且只改 y,alpha —— 只有大局结算会放。 */
function tweenLabel(signature, duration, keys) {
  if (keys === "y,alpha" && duration >= 900 && duration <= 1320) return "match_finish";
  return BY_TWEEN[signature] ?? `未登记动画`;
}

/* ------------------------------------------------------------------ *
 * 记录与截图
 * ------------------------------------------------------------------ */

/** 每次只记一条：音效优先（文件名唯一），动画作为另一条独立证据。 */
const hits = new Map();
const unknown = new Map();

function bump(label, field, detail) {
  const value = hits.get(label) ?? { sound: 0, anim: 0, ring: 0, detail: "", shot: null };
  value[field] += 1;
  if (!value.detail && field !== "ring") value.detail = detail;
  hits.set(label, value);
  return value;
}

const pendingShots = [];
/** 第一次出现就要留下画面，事后补拍看不出动画长什么样。 */
const SHOT_ON_FIRST = new Set([
  "tile_draw", "tile_select", "tile_discard", "peng", "gang", "hu", "pass", "turn_notify",
  "trustee_on", "trustee_off", "round_finish", "match_finish", "action_buttons", "screen_transition",
]);

function record(kind, label, detail, primary) {
  const first = !hits.has(label);
  const value = bump(label, kind === "sound" ? "sound" : (label === "active_player_ring" ? "ring" : "anim"), detail);
  if (first) {
    log("事件", kind, label, detail);
    if (SHOT_ON_FIRST.has(label) && primary) pendingShots.push(label);
  }
}

async function drain() {
  const records = await json(`(() => { const p = window.__probe; const out = p.recs.slice(p.taken); p.taken += out.length; return out; })()`);
  for (const item of records) {
    if (item.k === "sound") {
      const key = Object.keys(BY_SOUND).find((each) => item.url.includes(each));
      if (key) record("sound", BY_SOUND[key], item.url, true);
      else log("未登记音效", item.url);
      continue;
    }
    const signature = `${item.d}|${item.keys}`;
    const label = tweenLabel(signature, item.d, item.keys);
    if (label === "未登记动画") {
      unknown.set(signature, (unknown.get(signature) ?? 0) + 1);
      continue;
    }
    record("tween", label, signature, PRIMARY_TWEEN.has(signature));
  }
  while (pendingShots.length) {
    const label = pendingShots.shift();
    hits.get(label).shot = await shot(`事件-${label}`);
  }
  return records.length;
}

/** 缺哪个事件就等哪个；全齐了或者超时就走。120ms 一跳，尽量在动画还在放的时候截到。 */
async function collect(ms, until) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    await drain();
    if (until && until()) break;
    await sleep(120);
  }
  await drain();
}

/** 呼吸环是循环动画、单独记一笔（`ring`），算「有没有见过」时三笔都要认。 */
const got = (label) => {
  const value = hits.get(label);
  return !!value && value.sound + value.anim + value.ring > 0;
};

/* ------------------------------------------------------------------ *
 * 交互：托管入口在牌桌菜单里，取消托管在托管浮层上
 * ------------------------------------------------------------------ */

async function dumpTexts(tag) {
  const texts = await json("window.__mj.texts()");
  log(`可见文案（${tag}）`, [...new Set(texts)].slice(0, 30).join(" | "));
}

/** 菜单 → 退出游戏 → 确认退出：这三步之后服务端才把这一座切成托管。 */
async function enterTrustee() {
  if (!(await tapText("菜单"))) { log("找不到「菜单」入口"); return false; }
  await sleep(700);
  await shot("牌桌菜单");
  if (!(await tapText("退出游戏"))) { log("牌桌菜单里没有「退出游戏」"); await dumpTexts("牌桌菜单"); await tapText("继续游戏"); return false; }
  await sleep(700);
  if (!(await tapText("确认退出"))) { log("没有「确认退出」二次确认"); await dumpTexts("二次确认"); return false; }
  return true;
}

/** 「重新接管」在托管浮层上，而浮层要等服务端把 control=trustee 发下来才出现（轮询 2.5 秒）。 */
async function exitTrustee() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await tapText("重新接管")) { log("已点「重新接管」"); return true; }
    await collect(1_000);
  }
  log("托管浮层上始终没等到「重新接管」");
  await dumpTexts("托管浮层");
  return false;
}

/**
 * 每小场开头的两道手动关卡：换三张（选满 3 张再确认）与定缺（三选一）。
 *
 * 手动段这一座是**人类控制**的，卡在这两关上就是白等 15 秒时限；
 * 而且此时手牌区照样可点，让选牌扫描去猜会把 3 张选成别的组合。
 */
async function tapOpeningPhases() {
  // 先认提示语再点花色：座位标签上本来就写着「缺万 / 缺条」，直接按花色找会点到标签上没完。
  if (await json(`window.__mj.find("请选择定缺花色") !== null`)) {
    for (const suit of ["缺万", "缺筒", "缺条"]) {
      if (await tapText(suit)) { log("已选定缺花色", suit); await sleep(300); return true; }
    }
    return false;
  }
  if (!(await json(`window.__mj.find("请选择 3 张牌", true) !== null`))) return false;
  const tiles = await json("window.__mj.tiles()");
  if (!Array.isArray(tiles) || tiles.length < 3) return false;
  // 换三张要**同一门**的三张（`swapSelectionIsValid`），凑不满「确认换牌」是静默不响的 ——
  // 之前从最右连点三张就卡在 已选 1/3。牌面图的 skin 形如 `wan_3`，按前缀分门即可。
  const bySuit = new Map();
  for (const each of tiles) {
    const suit = String(each.s ?? "").split("_")[0];
    if (!suit) return false; // 认不出牌面就别说点错了门。
    const group = bySuit.get(suit) ?? [];
    group.push(each);
    bySuit.set(suit, group);
  }
  const three = [...bySuit.values()].find((group) => group.length >= 3)?.slice(0, 3);
  if (!three) return false;
  for (const each of three) {
    await tap(each.x, each.y);
    await sleep(180);
  }
  if (!(await tapText("确认换牌"))) return false;
  log("已换三张");
  await sleep(300);
  return true;
}

/**
 * 倒计时段：**故意不响应**轮到自己的那一拍，让 15 秒时限走完。
 *
 * 两声提醒只在 ≤5 秒与 ≤1 秒响（`PresentationDirector` 的 WARN/FINAL），
 * 手快的验收跑永远碰不到 —— 上一轮就是这么漏掉这一项的。
 * 期间每 3 秒截一张，正常 / 金色（≤10 秒）/ 朱红（≤5 秒）三档都留在图上。
 */
async function letClockDown() {
  const waitForTurn = Date.now() + 30_000;
  const myTurn = `["请先选牌","过"].some((t) => window.__mj.find(t) !== null)`
    + ` || window.__mj.find("打出", true) !== null`;
  while (Date.now() < waitForTurn && !(await json(myTurn))) await collect(1_000);
  if (Date.now() >= waitForTurn) { log("30 秒内没轮到自己，跳过倒计时段"); return; }
  log("—— 倒计时段：这一拍什么都不点，让 15 秒时限走完 ——");
  const idleUntil = Date.now() + 17_000;
  let shotAt = 0;
  while (Date.now() < idleUntil) {
    await collect(2_000);
    if (Date.now() >= shotAt) {
      shotAt = Date.now() + 3_000;
      await shot("读秒");
    }
  }
}

/**
 * 出牌一次：先直接找「打出」，找不到就说明这座还没选牌
 * （`RoomPage` 在未选牌时把同一个按钮写成「请先选牌」），于是从最右边那张
 * （刚摸到的）往左扫，谁让 tile_select 响了就停 —— 哪张可点只能扫出来（缺门未清时服务端只收缺门牌）。
 */
async function tapDiscard() {
  if (await tapText("打出", true)) { log("已点「打出」"); await sleep(300); return true; }
  const tiles = await json("window.__mj.tiles()");
  if (!Array.isArray(tiles) || tiles.length < 3) return false;
  for (const each of [...tiles].reverse()) {
    const before = hits.get("tile_select")?.anim ?? 0;
    await tap(each.x, each.y);
    await sleep(200);
    await drain();
    if ((hits.get("tile_select")?.anim ?? 0) > before) {
      log("选中了一张牌", JSON.stringify(each));
      // 一次点牌一张图，几十次下来全是同一张 —— 只留第一张。
      if (!selectedShot) { selectedShot = true; await shot("选牌抬起"); }
      if (await tapText("打出", true)) { log("已点「打出」"); await sleep(300); return true; }
      return false;
    }
  }
  return false;
}
let selectedShot = false;

/* ------------------------------------------------------------------ *
 * 采集顺序：托管 → 接管手动一遍 → 再托管打完整场
 * ------------------------------------------------------------------ */

log("—— 托管段：服务端替这一座出牌，摸/打/碰/杠/胡/结算连着来 ——");
if (await enterTrustee()) log("已进入托管");
await collect(25_000, () => got("trustee_on"));
await shot("托管中");
await collect(90_000, () => got("gang") && got("hu") && got("round_finish"));

log("—— 接管段：读秒、点牌、过、打出全部手动 ——");
await exitTrustee();
await collect(25_000, () => got("trustee_off"));
await shot("已接管");
// 先让一次时限走完：手动点牌会把读秒压到 5 秒以内都碰不上，这一项就永远空着。
await letClockDown();

const manualStop = Date.now() + MANUAL_SECONDS * 1000;
let probeAt = 0;
while (Date.now() < manualStop && !got("match_finish")) {
  await drain();
  // 「过」只在认领阶段出现，出现了就点掉：这条既不响第二声也只有画面能证明它没挡后续操作。
  if (await tapOpeningPhases()) { /* 日志在 helper 里 */ }
  else if (await tapText("过")) log("已点「过」");
  else if (await tapDiscard()) { /* 日志在 tapDiscard 里 */ }
  else if (Date.now() > probeAt) {
    // 什么都不肯点 = 这座这一拍没有可点的按钮。把屏幕文案与牌数打出来，否则一段 150 秒的静默无从判断。
    probeAt = Date.now() + 15_000;
    const tiles = await json("window.__mj.tiles()");
    log("手动段探针", `牌${Array.isArray(tiles) ? tiles.length : "?"}`,
      (await json("window.__mj.texts()")).slice(-12).join("|"));
  }
  await collect(1_000);
}

log("—— 收尾段：重新托管，让服务端把整场打完（大局结算要真结束才有画面）——");
// 这一座留在手动的话，服务端每个轮次要等满 15 秒时限，8 小场根本打不完 —— 这段成败必须看得见。
log(await enterTrustee() ? "已进入托管" : "没能进入托管（大局结算大概率跑不出来）");
const endStop = Date.now() + Math.max(120_000, RUN_SECONDS * 1000);
while (Date.now() < endStop && !got("match_finish")) {
  await collect(20_000, () => got("match_finish"));
  const screen = bots[0].flow.current;
  if (screen.name === "room" && screen.match === null && got("round_finish")) {
    log("服务端已无进行中小场，等待整场结论", JSON.stringify({ match: screen.match === null ? "null" : "still-running" }));
  }
}
await collect(6_000);
await shot("结束态");

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

const SCENARIOS = [
  { id: "01 摸牌", labels: ["tile_draw"] },
  { id: "02 选牌", labels: ["tile_select"] },
  { id: "03 出牌", labels: ["tile_discard"] },
  { id: "04 碰", labels: ["peng"] },
  { id: "05 杠", labels: ["gang"] },
  { id: "06 胡", labels: ["hu"] },
  { id: "07 过", labels: ["pass"] },
  { id: "08 当前玩家", labels: ["turn_notify"] },
  { id: "09 倒计时", labels: ["countdown_5", "countdown_1", "countdown_final"] },
  { id: "10 托管/接管", labels: ["trustee_on", "trustee_off", "trustee_toast"] },
  { id: "11 小局结算", labels: ["round_finish"] },
  { id: "11 大局结算", labels: ["match_finish"] },
  { id: "+ 按钮音", labels: ["ui_click"] },
  { id: "+ 页面切换", labels: ["screen_transition"] },
  { id: "+ 操作按钮出现", labels: ["action_buttons"] },
  { id: "+ 换三张", labels: ["swap", "sweep_or_match"] },
  { id: "+ 定缺", labels: ["choose_missing", "sweep_or_match"] },
  { id: "+ 呼吸环", labels: ["active_player_ring"] },
];

const lines = [];
for (const scenario of SCENARIOS) {
  const found = scenario.labels.filter(got);
  const detail = found.map((each) => {
    const value = hits.get(each);
    return `${each}(音${value.sound}/画${value.anim}${value.ring ? `/环${value.ring}` : ""})`;
  }).join(" ");
  lines.push(`${found.length > 0 ? "✓" : "✗"} ${scenario.id.padEnd(16)} ${detail}`);
}

writeFileSync(join(OUTDIR, "events.json"), JSON.stringify({
  events: [...hits].map(([label, value]) => ({ label, ...value })),
  unknownTweens: [...unknown].map(([signature, count]) => ({ signature, count })),
  scenarios: lines,
  shots,
}, null, 2));

console.log("\n=== 任务书第十三节场景覆盖（音=音效文件名，画=Tween 签名）===");
for (const line of lines) console.log("  " + line);
console.log("\n=== 全部命中明细 ===");
for (const [label, value] of [...hits].sort((a, b) => b[1].sound + b[1].anim - a[1].sound - a[1].anim)) {
  console.log(`  音${String(value.sound).padStart(3)} 画${String(value.anim).padStart(3)} 环${String(value.ring).padStart(3)}  ${label}  ← ${value.detail}${value.shot ? "  " + value.shot : ""}`);
}
if (unknown.size > 0) {
  console.log("\n未登记动画（牌桌自身的 Tween，不属于表现层事件）：");
  for (const [signature, count] of unknown) console.log(`  ${count} × ${signature.replace("|", "ms 改 ")}`);
}
console.log("\n截图目录：", OUTDIR);
process.exit(0);
