// 直接调渲染层：倒计时节点到底会不会被画出来？
// 这样能把「渲染层没写对」与「数据没传到」两种原因当场分开。
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const base = new URL("../../apps/client/dist/browser/", import.meta.url).href;
const { roundResultPanel } = await import(base + "round-result.js");
const { countdownText } = await import(base + "result-text.js");

const result = { reason: "wall-exhausted", deltas: [], winnerSeats: [], nextDealerSeat: 0, wins: [] };

console.log("=== countdownText 本身 ===");
console.log("  nextRoundAt=null  →", JSON.stringify(countdownText(null, Date.now())));
console.log("  nextRoundAt=+5000 →", JSON.stringify(countdownText(Date.now() + 5000, Date.now())));

console.log("=== roundResultPanel 产出的节点 ===");
for (const pair of [["+5000ms", Date.now() + 5000], ["null", null]]) {
  const panel = roundResultPanel(result, null, pair[1]);
  const node = panel.querySelector(".countdown");
  console.log(`  nextRoundAt=${pair[0]} → .countdown ${node ? JSON.stringify(node.textContent) : "（没有）"}`);
}

// 再验「秒数会往下走」：等 1.2 秒看同一个节点有没有变。
const ticking = roundResultPanel(result, null, Date.now() + 5000);
document.body.append(ticking);
const first = ticking.querySelector(".countdown")?.textContent;
await new Promise((resolve) => setTimeout(resolve, 1200));
const second = ticking.querySelector(".countdown")?.textContent;
console.log(`  1.2 秒后：${JSON.stringify(first)} → ${JSON.stringify(second)}  ${first === second ? "（没在走 ✗）" : "（在走 ✓）"}`);
process.exit(0);
