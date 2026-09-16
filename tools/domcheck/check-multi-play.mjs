/**
 * 用 jsdom 把 /multi 页面真的**打一局**，再检查新界面画出来了没有。
 *
 * 为什么非要做这一步：单测能证明「副露该摆几张牌」这类纯逻辑是对的，但证明不了
 * 「页面真的会在牌桌上画出这些牌块」—— 少一个 `append`、类名写错、样式没下发，
 * 单测全绿而屏幕上什么都没有。这个脚本走完整链路：
 *   真实 HTTP 登录 → 真实 WebSocket 进房开局 → 换三张/定缺 → 真实出牌/碰杠
 *   → 然后检查 DOM。
 */
import { JSDOM } from "jsdom";

const PAGE = process.env.PAGE ?? "http://127.0.0.1:3000/multi";
// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const MODULE = new URL("../../apps/client/dist/browser/multi-client.js", import.meta.url).href;
const KEYS = (process.env.KEYS ?? "").split(",").map((each) => each.trim()).filter(Boolean);

if (KEYS.length !== 4) {
  console.error("需要 4 把密钥：KEYS=密钥1,密钥2,密钥3,密钥4");
  process.exit(1);
}
if (typeof WebSocket !== "function") {
  console.error("当前 Node 没有全局 WebSocket，无法驱动真实连接");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const html = await (await fetch(PAGE)).text();
const dom = new JSDOM(html, { url: PAGE, pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

globalThis.window = window;
globalThis.document = document;
globalThis.location = window.location;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const problems = [];
window.addEventListener("error", (event) => problems.push(`window error: ${event.message}`));
process.on("unhandledRejection", (reason) => problems.push(`unhandled rejection: ${reason}`));

await import(MODULE);

// ---------- 驱动 ----------
const inputs = [...document.querySelectorAll("#keys input")];
if (inputs.length !== 4) throw new Error(`输入框不是 4 个，而是 ${inputs.length} 个`);
inputs.forEach((input, index) => {
  input.value = KEYS[index];
});

const metaText = () => document.querySelector("#center .meta")?.textContent ?? "";
const cards = () => [...document.querySelectorAll(".seat-card")];
const chipCount = () => document.querySelectorAll(".discard-tiles .chip").length;
const meldCount = () => document.querySelectorAll(".melds .meld-group").length;

function clickByLabel(label) {
  return clickAll([label]) > 0;
}

/** 一次把页面上所有匹配的按钮都点掉（等待别人确认时可能有好几家各要一次）。 */
function clickAll(labels) {
  let count = 0;
  for (const node of document.querySelectorAll(".ops button")) {
    if (labels.includes(node.textContent ?? "")) {
      node.click();
      count += 1;
    }
  }
  return count;
}

/** 当前正在行动的那张卡（head 上有「当前行动」标签）。 */
function actingCard() {
  return cards().find((card) => card.querySelector(".tag.acting")) ?? null;
}

document.querySelector("#auto").click();

const startedAt = Date.now();
while (Date.now() - startedAt < 30_000) {
  if (!document.querySelector("#board").hidden && metaText().length > 0) break;
  await sleep(200);
}
console.log(`开局：${metaText() || "（还没出现牌桌）"}`);

/**
 * 一直打到「有弃牌 + 至少出现过一副副露」为止。
 *
 * 碰要凑出对子才出现，不是每局都有，所以这里跨局连续打（一局 8 轮），
 * 并且换三张/定缺一出现就自动过掉 —— 否则新的一局会卡在第一阶段。
 */
const playStartedAt = Date.now();
while (Date.now() - playStartedAt < 150_000) {
  if (meldCount() > 0 && chipCount() > 0) break;

  const phase = metaText();
  if (phase.includes("换三张")) {
    clickAll(["自动"]);
  } else if (phase.includes("定缺")) {
    clickAll(["自动"]);
  } else if (phase.includes("行牌")) {
    const card = actingCard();
    const tiles = card ? [...card.querySelectorAll(".hand button")] : [];
    // 有缺门牌时必须先打缺门牌，否则引擎会拒。
    const pick = tiles.find((tile) => tile.classList.contains("missing-suit")) ?? tiles[0];
    pick?.click();
    pick?.click(); // 同一张牌第二次点击才出牌
  } else if (phase.includes("等待别人确认")) {
    // 优先碰/杠 —— 这正是副露牌块要验证的来源。不点胡，免得本局提前结束。
    if (clickAll(["碰", "杠"]) === 0) clickAll(["过"]);
  }
  await sleep(60);
}

// ---------- 断言 ----------
console.log(`\n最终阶段：${metaText()}`);
console.log(`座位卡：${cards().length} 个`);
console.log(`弃牌格：${document.querySelectorAll(".discard-cell").length} 个`);
document.querySelectorAll(".discard-cell").forEach((cell, index) => {
  const head = cell.querySelector(".discard-head")?.textContent?.replace(/\s+/g, " ") ?? "";
  const chips = [...cell.querySelectorAll(".chip")].map((chip) => chip.textContent);
  console.log(`  第 ${index + 1} 格：${head}  →  ${chips.join(" ") || "（空）"}`);
});
console.log(`副露牌块：${meldCount()} 副`);
document.querySelectorAll(".meld-group").forEach((group) => {
  const kind = group.querySelector(".kind")?.textContent ?? "?";
  const chips = [...group.querySelectorAll(".chip")].map((chip) => chip.textContent);
  console.log(`  ${kind}：${chips.join(" ")}（${chips.length} 张）`);
});
const fresh = document.querySelectorAll(".chip.fresh").length;
console.log(`被框出的「刚打出」牌：${fresh} 张`);

// 手牌与副露是不是真的摆在一起（副露紧挨着手牌）。
const firstCard = cards()[0];
console.log(`首张卡片里 .tiles-area 含 .hand：${Boolean(firstCard?.querySelector(".tiles-area .hand"))}`);
console.log(`首张卡片里 .tiles-area 含 .melds：${Boolean(firstCard?.querySelector(".tiles-area .melds"))}`);

const failures = [];
if (problems.length > 0) failures.push(...problems);
if (cards().length !== 4) failures.push(`座位卡应为 4 个，实际 ${cards().length}`);
if (document.querySelectorAll(".discard-cell").length !== 4) failures.push("弃牌格应为 4 个");
if (chipCount() === 0) failures.push("中央弃牌区一张牌都没有 —— 出牌没被画出来");
if (meldCount() === 0) failures.push("没出现任何副露牌块（本轮没碰上，可重跑）");
if (!firstCard?.querySelector(".tiles-area")) failures.push("手牌与副露没有包在同一个 .tiles-area 里");

console.log("");
if (failures.length === 0) {
  console.log("结论：副露挨着手牌摆、弃牌在中央 —— 都真的画出来了");
} else {
  console.log("结论：有问题");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
