/**
 * 牌桌菜单 / 退出二次确认 / 托管浮层：**这几个 DOM 真的被拼出来了吗**。
 *
 * 为什么单测与协议层验收答不了：
 *   * 服务端的 `quit` / `request_takeover` 有测试，但"菜单里到底有没有这三项、
 *     二次确认有没有真的拦住人"是纯渲染层的事 —— 少一个 append、类名写错，
 *     数据全对而屏幕上什么都没有；
 *   * "托管浮层不能全屏遮挡"这种要求，只能靠看它挂的是哪个类、长什么样。
 *
 * 直接调 `table-menu.js` 导出函数，不需要服务端、不需要密钥。
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const base = new URL("../../apps/client/dist/browser/", import.meta.url).href;
const { quitConfirmOverlay, tableMenuOverlay, trusteeOverlay } = await import(base + "table-menu.js");
const { playerProfile } = await import(base + "player-profile.js");

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const textOf = (node) => (node?.textContent ?? "").trim();

console.log("=== 牌桌菜单 ===");
const fired = [];
const menu = tableMenuOverlay({
  onResume: () => fired.push("继续游戏"),
  onBackToLobby: () => fired.push("返回大厅"),
  onQuit: () => fired.push("退出游戏"),
});
const menuLabels = [...menu.querySelectorAll("button")].map(textOf);
console.log(`  按钮：${menuLabels.join(" / ")}`);
check(menuLabels.join(",") === "继续游戏,返回大厅,退出游戏",
  `菜单就该是这三项（实际 ${menuLabels.join(",")}）`);
// 老菜单项不许再出现：它与"返回大厅"语义重叠，留着会让人选错。
check(!textOf(menu).includes("返回房间"), "菜单里不该再有「返回房间」");
// 三个动作的差别必须写在菜单上，否则"暂时离开"和"交出控制权"看起来一样。
check(textOf(menu).includes("暂时离开牌桌"), "菜单要说明「返回大厅」只是暂时离开");
check(textOf(menu).includes("服务器接管") && textOf(menu).includes("保留"),
  "菜单要说明「退出游戏」会托管且牌与积分都保留");

for (const [index, expected] of ["继续游戏", "返回大厅", "退出游戏"].entries()) {
  fired.length = 0;
  menu.querySelectorAll("button")[index].dispatchEvent(new dom.window.Event("click"));
  check(fired[0] === expected, `第 ${index + 1} 项该触发「${expected}」（实际 ${fired[0]}）`);
}

console.log("=== 退出二次确认 ===");
let confirmed = 0;
let cancelled = 0;
const confirm = quitConfirmOverlay({
  onCancel: () => { cancelled += 1; },
  onConfirm: () => { confirmed += 1; },
});
const confirmButtons = [...confirm.querySelectorAll("button")].map(textOf);
console.log(`  按钮：${confirmButtons.join(" / ")}`);
check(confirmButtons.join(",") === "取消,确认退出", "二次确认只有「取消」和「确认退出」两个出口");
for (const phrase of ["确定退出当前游戏吗", "自动托管你的座位", "本次大局结束前你可以回来重新接管"]) {
  check(textOf(confirm).includes(phrase), `二次确认要说清「${phrase}」`);
}
// 取消不许顺手把人退出去了。
confirm.querySelectorAll("button")[0].dispatchEvent(new dom.window.Event("click"));
check(cancelled === 1 && confirmed === 0, "点「取消」不能触发退出");
confirm.querySelectorAll("button")[1].dispatchEvent(new dom.window.Event("click"));
check(confirmed === 1, "点「确认退出」要触发退出（且只触发一次）");

console.log("=== 托管浮层 ===");
let takeovers = 0;
const banner = trusteeOverlay({ roundNumber: 3, totalRounds: 8, onTakeover: () => { takeovers += 1; } });
console.log(`  文字：${textOf(banner).replace(/\s+/g, " ")}`);
check(textOf(banner).includes("你的牌局正在托管中"), "浮层要直说「你的牌局正在托管中」");
check(textOf(banner).includes("当前第 3 / 8 局"), "浮层要报「当前第 N/8 局」");
// 共几小场由服务端下发，不硬编 8。
const sixRounds = trusteeOverlay({ roundNumber: 2, totalRounds: 6, onTakeover: () => {} });
check(textOf(sixRounds).includes("当前第 2 / 6 局"), "局数要用服务端下发的总小场数，不能硬编 8");
const takeoverButton = [...banner.querySelectorAll("button")].map(textOf);
check(takeoverButton.includes("重新接管"), "浮层要有「重新接管」出口");
banner.querySelector("button").dispatchEvent(new dom.window.Event("click"));
check(takeovers === 1, "点「重新接管」要发请求（且只发一次）");
// **不能全屏遮挡**：牌面看得见本身就是"托管中"要传达的信息。
check(!banner.className.includes("overlay-mask"),
  "托管浮层不该用整屏遮罩的类名（牌面要看得见）");
check(banner.className.includes("trustee-banner"), "托管浮层要用自己的类名（样式里是压在牌桌正中的一小块）");

console.log("=== 在场标识（另外三家看到的那一行小字）===");
const profileFor = (presence) => playerProfile({
  nickname: "乙",
  matchDelta: 0,
  dealer: false,
  missingSuit: null,
  presence,
});
const labelOf = (presence) => {
  const badge = profileFor(presence).querySelector(".presence-badge");
  return badge ? textOf(badge) : "";
};
console.log(`  online=${labelOf("online") || "(无)"} / away=${labelOf("away")} / trustee=${labelOf("trustee")} / disconnected=${labelOf("disconnected")}`);
// 「暂离」与「托管中」必须是两个不同的词。混用会让人以为"去大厅"等于"把座位交出去了"，
// 而那两件事的后果完全不同（一个回来直接接着打，一个要点「重新接管」）。
check(labelOf("away") === "暂离", `暂离要显示成「暂离」（实际「${labelOf("away")}」）`);
check(labelOf("trustee") === "托管中", `托管要显示成「托管中」（实际「${labelOf("trustee")}」）`);
check(labelOf("away") !== labelOf("trustee"), "「暂离」和「托管中」不能是同一个词");
check(labelOf("disconnected") === "掉线", `掉线要显示成「掉线」（实际「${labelOf("disconnected")}」）`);
// 正常在场不挂徽标：四个人都正常时挂四个"在线"只是噪声，牌桌上要一眼看出的是异常的那几个。
check(labelOf("online") === "", "online 不该挂徽标");
// 类名要按状态分：样式里三种状态各有各的底色，类名写错就会全变成一个样。
check(profileFor("away").querySelector(".presence-badge.away") !== null, "暂离徽标要带自己的类名");
check(profileFor("trustee").querySelector(".presence-badge.trustee") !== null, "托管徽标要带自己的类名");

console.log("");
if (failures.length === 0) {
  console.log("结论：菜单三项齐全且各触发各的动作；退出有二次确认且取消不会误退；托管浮层报局数、给「重新接管」、不遮挡牌桌；暂离与托管是两个不同的标识");
} else {
  console.log("结论：有问题");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
