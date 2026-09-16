/**
 * 实测：碰 / 杠 / 过的按钮到底出现过没有、每个窗口持续多久。
 *
 * 做法是同时盯两头：
 *   * **原始协议帧**（拦下 WebSocket 收到的每一帧）—— 服务端有没有真的下发 `peng`
 *   * **页面 DOM**（每 50ms 扫一次 `.ops button`）—— 客户端有没有把它画成按钮
 *
 * 只盯一头会得出相反的错误结论：只看 DOM 会以为「服务端没发」，
 * 只看帧会以为「页面显示了」。
 */
import { JSDOM } from "jsdom";

const PAGE = process.env.PAGE ?? "http://127.0.0.1:3000/multi";
// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const MODULE = new URL("../../apps/client/dist/browser/multi-client.js", import.meta.url).href;
const KEYS = (process.env.KEYS ?? "").split(",").map((each) => each.trim()).filter(Boolean);
const SECONDS = Number(process.env.SECONDS ?? 90);

if (KEYS.length !== 4) {
  console.error("需要 4 把密钥：KEYS=密钥1,密钥2,密钥3,密钥4");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 渲染层一旦抛异常（rAF 回调里抛的），Node 会直接杀进程、报告全丢。
// 这里兜住并计数：既能继续采完样，也顺带把「页面崩了几次」变成一个数字。
const crashes = [];
process.on("uncaughtException", (error) => crashes.push(String(error?.message ?? error)));

// ---------- 先装帧监听，再让模块加载（否则错过第一帧）----------
const socketFrames = [];
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    const index = sockets.length;
    sockets.push(this);
    this.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(event.data);
        socketFrames.push({ at: Date.now(), socket: index, frame });
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });
  }
};
const sockets = [];

const html = await (await fetch(PAGE)).text();
const dom = new JSDOM(html, { url: PAGE, pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

globalThis.window = window;
globalThis.document = document;
globalThis.location = window.location;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

await import(MODULE);

// ---------- 开局 ----------
const inputs = [...document.querySelectorAll("#keys input")];
inputs.forEach((input, index) => { input.value = KEYS[index]; });
document.querySelector("#auto").click();
await sleep(4000);

const metaText = () => document.querySelector("#center .meta")?.textContent ?? "";
const buttons = () => [...document.querySelectorAll(".ops button")].map((node) => node.textContent);
const clickAll = (labels) => {
  let count = 0;
  for (const node of document.querySelectorAll(".ops button")) {
    if (labels.includes(node.textContent ?? "")) { node.click(); count += 1; }
  }
  return count;
};

// ---------- 采样循环 ----------
/** 正在「等别人确认」的窗口：起止时间 + 期间页面上出现过的按钮。 */
let window0 = null;
const windows = [];
/** 采样期间点掉的碰 / 杠次数（用来验证「点下去真的能成」）。 */
const claimClicks = { peng: 0 };
/**
 * 采样期间**出现过**的东西。
 *
 * 不能只看最后一帧：整场打完时 `match` 会被清空、牌桌整个消失，
 * 那时去数「手牌计数 / 副露 / 刚摸牌标记」必然全是 0，看起来像功能没做。
 */
const seen = {
  handCountSamples: 0,
  maxHandCounts: 0,
  maxMelds: 0,
  drawnTagSamples: 0,
  drawnTileSamples: 0,
  countTexts: new Set(),
};

const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  const meta = metaText();
  const inClaiming = meta.includes("等待别人确认");
  const shown = buttons();

  // 每一帧都记「有没有画出来」，而不是等最后再数（见 seen 的说明）。
  const handCounts = document.querySelectorAll(".seat-head .count");
  if (handCounts.length > 0) {
    seen.handCountSamples += 1;
    seen.maxHandCounts = Math.max(seen.maxHandCounts, handCounts.length);
    for (const node of handCounts) seen.countTexts.add(node.textContent);
  }
  seen.maxMelds = Math.max(seen.maxMelds, document.querySelectorAll(".melds .meld-group").length);
  if (document.querySelectorAll(".tag.drawn").length > 0) seen.drawnTagSamples += 1;
  if (document.querySelectorAll("button.tile.drawn").length > 0) seen.drawnTileSamples += 1;

  if (inClaiming) {
    if (!window0) window0 = { startedAt: Date.now(), buttons: new Set(), frames: 0 };
    for (const label of shown) window0.buttons.add(label);
  } else if (window0) {
    window0.endedAt = Date.now();
    windows.push(window0);
    window0 = null;
  }

  // 只做最小驱动：让牌局往前走。碰到「碰/杠」就点（顺便验证点下去真的能成），
  // 否则点「过」。
  if (meta.includes("换三张")) clickAll(["四家全部自动换三张"]);
  else if (meta.includes("定缺")) clickAll(["四家全部自动定缺"]);
  else if (meta.includes("行牌")) {
    const card = [...document.querySelectorAll(".seat-card")].find((each) => each.querySelector(".tag.acting"));
    const tiles = card ? [...card.querySelectorAll(".hand button")] : [];
    const pick = tiles.find((tile) => tile.classList.contains("missing-suit")) ?? tiles[0];
    pick?.click();
  } else if (inClaiming) {
    const clicked = clickAll(["碰", "杠"]);
    if (clicked > 0) claimClicks.peng += clicked;
    else clickAll(["过"]);
  }
  await sleep(50);
}

if (window0) { window0.endedAt = Date.now(); windows.push(window0); }

// ---------- 报告 ----------
const claimFrames = socketFrames.filter((entry) => entry.frame?.type === "actions" && entry.frame.actions?.length > 0);
const pengFrames = socketFrames.filter((entry) => entry.frame?.actions?.includes("peng"));
const kongFrames = socketFrames.filter((entry) => entry.frame?.actions?.includes("kong"));

console.log(`采样 ${SECONDS} 秒，期间「等待别人确认」的窗口 ${windows.length} 个\n`);
console.log("=== 每个窗口：持续多久、页面上出现过哪些按钮 ===");
for (const [index, entry] of windows.entries()) {
  const ms = entry.endedAt - entry.startedAt;
  console.log(`  #${index + 1}  持续 ${String(ms).padStart(5)} ms   按钮：[${[...entry.buttons].join("、") || "（无）"}]`);
}

console.log("\n=== 服务端原始 actions 帧 ===");
console.log(`  非空 actions 帧共 ${claimFrames.length} 条`);
console.log(`  其中带 peng 的：${pengFrames.length} 条`);
console.log(`  其中带 kong 的：${kongFrames.length} 条`);
const actionSets = new Map();
for (const entry of claimFrames) {
  const key = [...entry.frame.actions].sort().join("+");
  actionSets.set(key, (actionSets.get(key) ?? 0) + 1);
}
for (const [set, count] of [...actionSets].sort((left, right) => right[1] - left[1])) {
  console.log(`    ${String(count).padStart(3)} 次   [${set}]`);
}

const shownPeng = windows.filter((entry) => [...entry.buttons].some((b) => b === "碰" || b === "杠"));
console.log("\n=== 结论 ===");
console.log(`  服务端下发过 peng：${pengFrames.length > 0 ? "是" : "否"}`);
console.log(`  页面画出过「碰」或「杠」按钮的窗口：${shownPeng.length} / ${windows.length} 个`);
console.log(`  实际点掉的碰/杠次数：${claimClicks.peng}`);
console.log(`  手牌计数：出现过 ${seen.handCountSamples} 个采样帧，最多 ${seen.maxHandCounts} 家同时显示`);
console.log(`    ${[...seen.countTexts].slice(0, 8).join(" / ") || "（没出现过）"}`);
console.log(`  副露牌块：最多同时 ${seen.maxMelds} 副`);
console.log(`  「刚摸牌」标记：${seen.drawnTagSamples} 个采样帧出现过；高亮那张牌：${seen.drawnTileSamples} 帧`);
console.log(`  采样期间的渲染异常：${crashes.length} 次`);
for (const message of new Set(crashes)) console.log(`    · ${message}`);

process.exit(0);
