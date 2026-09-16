/**
 * 一小场那屏数字：倒计时节点画没画出来、秒数在不在走、**到点会不会自己收**，
 * 以及它**只报数字**（不展示牌型、不亮四家牌面）。
 *
 * 直接调渲染函数，能把「渲染层没写对」与「数据没传到」两种原因当场分开。
 * 这几条都只长在渲染层里，单测全绿也照样漏：
 *   * 「不展示牌型/牌面」—— 帧里照样带着 `wins` 与四家手牌，画不画是渲染层的事；
 *   * 「到点自动交接」—— 打满 8 小场时服务端在那之后**不再发任何帧**，
 *     少一个到点回调，整局结算记录就永远不出现。
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const base = new URL("../../apps/client/dist/browser/", import.meta.url).href;
const { roundScorePop } = await import(base + "round-result.js");
const { countdownText } = await import(base + "result-text.js");

const ids = ["1000000001", "1000000002", "1000000003", "1000000004"];
const names = ["张三", "李四", "王五", "赵六"];
const snapshot = {
  roomId: "r", roomNo: "482913", ruleVersion: "MIANYANG_XZ_1_0", status: "playing",
  ownerId: ids[0], completedRounds: 3, result: null,
  players: ids.map((userId, index) => ({
    userId, nickname: names[index], points: 1000, ready: true, connected: true,
    disconnectedAt: null, reconnectDeadline: null,
  })),
};
const result = {
  roundNumber: 4,
  totalRounds: 8,
  reason: "three-winners",
  winnerSeats: [0],
  deltas: ids.map((playerId, seat) => ({ playerId, delta: [24, -8, -8, -8][seat] })),
  players: ids.map((playerId, seat) => ({
    playerId, seat, won: seat === 0, hand: [1, 2, 3], melds: [], matchDelta: [64, -24, -20, -20][seat],
  })),
  // 牌型明细照给：渲染层**不该**把它画出来。给了才验得出「没用上」。
  wins: [{
    seat: 0, method: "self-draw", fromSeat: null, fromTile: null,
    items: [{ code: "PONG", name: "对对胡", fan: 2 }], rawFan: 2, finalFan: 2,
    paymentPerOpponent: 8, payerCount: 3, points: 24,
  }],
};

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

console.log("=== countdownText 本身 ===");
console.log("  hideAt=null  →", JSON.stringify(countdownText(null, Date.now())));
console.log("  hideAt=+3000 →", JSON.stringify(countdownText(Date.now() + 3000, Date.now())));

console.log("=== 那一屏画出来的东西 ===");
const pop = roundScorePop(result, snapshot, Date.now() + 3000);
console.log(`  标题：${pop.querySelector(".round-pop-title")?.textContent}`);
console.log(`  四家：${[...pop.querySelectorAll(".score-value")].map((node) => node.textContent.trim()).join("　")}`);
console.log(`  倒计时：${pop.querySelector(".countdown")?.textContent ?? "（没有）"}`);
console.log(`  容器定位：position:${pop.style.position}`);

check(pop.style.position === "absolute", "这一屏该绝对定位压在牌桌上，不是整屏 fixed 浮层");
check(!pop.style.boxShadow.includes("10vmax"), "不该有挡住整屏的遮罩（旧版是 box-shadow 0 0 0 10vmax）");
check(pop.querySelector(".round-pop-title")?.textContent?.trim() === "第 4/8 小场", "标题要写清这是第几小场");
check([...pop.querySelectorAll(".score-value")].map((node) => node.textContent.trim()).join(",") === "+24,-8,-8,-8",
  "要按座位给出本小场四家的得失分");
check(pop.querySelectorAll(".score-cell").length === 4, "四家各一格");
// 「小局结算时都不用展示牌型等」：帧里带着牌型与牌面，渲染层一个都不该画。
for (const selector of [".win-summary", ".result-player", ".meld-group", ".score-total", ".score-account", "button"]) {
  check(pop.querySelector(selector) === null, `小场这一屏不该出现 ${selector}`);
}

// 不停留（或老服务端不下发停留时长）时没有倒计时那一行 —— 别硬编一个数字。
const noPause = roundScorePop(result, snapshot, null);
check(noPause.querySelector(".countdown") === null, "没有停留时长时不该硬编一个倒计时");
check(noPause.querySelectorAll(".score-value").length === 4, "没有停留时长时四家分数照样要出来");

// 秒数要往下走。
const ticking = roundScorePop(result, snapshot, Date.now() + 3000);
document.body.append(ticking);
const first = ticking.querySelector(".countdown")?.textContent;
await new Promise((resolve) => setTimeout(resolve, 1200));
const second = ticking.querySelector(".countdown")?.textContent;
console.log(`  1.2 秒后：${JSON.stringify(first)} → ${JSON.stringify(second)}  ${first === second ? "（没在走 ✗）" : "（在走 ✓）"}`);
check(first !== second, "倒计时的秒数没在往下走");

// 到点要通知渲染层重画一次：打满 8 小场时靠它交接给整局结算记录。
let expired = 0;
const shortLived = roundScorePop(result, snapshot, Date.now() + 150, () => { expired += 1; });
document.body.append(shortLived);
await new Promise((resolve) => setTimeout(resolve, 450));
console.log(`  到点回调触发次数：${expired}`);
check(expired === 1, `到点该通知渲染层重画一次（实际 ${expired} 次）`);

// 已经离场的旧节点不该再回调：渲染层每次都会整体重建 DOM，不判 `isConnected` 就会反复重画。
const stale = roundScorePop(result, snapshot, Date.now() + 150, () => { expired += 1; });
stale.remove();
await new Promise((resolve) => setTimeout(resolve, 450));
check(expired === 1, `离场的旧节点还在回调（实际 ${expired} 次）—— 渲染层会反复重画`);

console.log("");
if (failures.length === 0) {
  console.log("结论：小场那屏只在牌桌上弹四个数字（无面板、无遮罩、无牌型牌面），倒计时在走，到点自己收并通知重画");
} else {
  console.log("结论：有问题");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
