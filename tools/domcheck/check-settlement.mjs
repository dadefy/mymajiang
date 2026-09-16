/**
 * 打一局到结算，看**结算界面上到底显示了什么**。
 *
 * 验两件事：
 *   ① 胡牌类型（番型明细）—— 玩家要能看出是清一色还是对对胡；
 *   ② 是谁给的牌 —— 点炮时指明放炮者与那张牌，自摸时写「自摸」。
 *
 * 单测只能证明文案拼接对；证明不了「结算面板真的把它画出来了」——
 * 少一个 append、旧的结算实现把面板整个换掉，单测照样全绿。
 */
import { JSDOM } from "jsdom";

const PAGE = process.env.PAGE ?? "http://127.0.0.1:3000/multi";
// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const MODULE = new URL("../../apps/client/dist/browser/multi-client.js", import.meta.url).href;
const KEYS = (process.env.KEYS ?? "").split(",").map((each) => each.trim()).filter(Boolean);
const SECONDS = Number(process.env.SECONDS ?? 120);

if (KEYS.length !== 4) {
  console.error("需要 4 把密钥：KEYS=密钥1,密钥2,密钥3,密钥4");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const crashes = [];
process.on("uncaughtException", (error) => crashes.push(String(error?.message ?? error)));

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

const inputs = [...document.querySelectorAll("#keys input")];
inputs.forEach((input, index) => { input.value = KEYS[index]; });
document.querySelector("#auto").click();
await sleep(4000);

const metaText = () => document.querySelector("#center .meta")?.textContent ?? "";
const clickAll = (labels) => {
  let count = 0;
  for (const node of document.querySelectorAll(".ops button")) {
    if (labels.includes(node.textContent ?? "")) { node.click(); count += 1; }
  }
  return count;
};

/** 结算面板上「胡了什么」的那些行。 */
const winSummaries = () => [...document.querySelectorAll(".win-summary")].map((node) => node.textContent ?? "");
/** 结算面板里每位玩家的行（含自家「怎么胡的」）。 */
const playerRows = () => [...document.querySelectorAll(".result-player p")].map((node) => node.textContent ?? "");

let captured = null;
const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  const meta = metaText();
  // 本局一结束就抓一次（面板只在结算那一刻存在）。
  const summaries = winSummaries();
  if (summaries.length > 0 || meta.includes("本局结束")) {
    captured = { summaries, rows: playerRows(), meta };
    if (summaries.length > 0) break;
  }

  if (meta.includes("换三张")) clickAll(["自动"]);
  else if (meta.includes("定缺")) clickAll(["自动"]);
  else if (meta.includes("行牌")) {
    const card = [...document.querySelectorAll(".seat-card")].find((each) => each.querySelector(".tag.acting"));
    const tiles = card ? [...card.querySelectorAll(".hand button")] : [];
    const pick = tiles.find((tile) => tile.classList.contains("missing-suit")) ?? tiles[0];
    pick?.click();
    pick?.click(); // 同一张牌第二次点击才出牌
  } else if (meta.includes("等待别人确认")) {
    // 优先碰/杠（能更快推进并能验到副露），否则过。
    if (clickAll(["碰", "杠", "胡"]) === 0) clickAll(["过"]);
  }
  await sleep(50);
}

console.log("=== 结算界面上的胡牌说明 ===");
if (!captured) {
  console.log("  （采样期间没走到结算）");
} else {
  for (const line of captured.summaries) console.log(`  ${line}`);
  if (captured.summaries.length === 0) console.log(`  （没有 .win-summary 行；阶段文本：${captured.meta}）`);
  console.log("\n=== 结算面板里每位玩家那一行 ===");
  for (const line of captured.rows) console.log(`  ${line}`);
}

const failures = [];
if (crashes.length > 0) failures.push(...crashes);
if (!captured) failures.push("采样期间没走到结算，无法验证");
else if (captured.summaries.length === 0) failures.push("结算界面上没有「胡牌类型 / 谁给的牌」那一块");
else {
  for (const line of captured.summaries) {
    if (!/番/.test(line)) failures.push(`缺番型：${line}`);
    if (!/(自摸|打出的|抢杠)/.test(line)) failures.push(`没写清怎么胡的、谁给的牌：${line}`);
  }
}

console.log("");
if (failures.length === 0) {
  console.log("结论：结算界面显示了胡牌类型与「谁给的牌」");
} else {
  console.log("结论：有问题");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
