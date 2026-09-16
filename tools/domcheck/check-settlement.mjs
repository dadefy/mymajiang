/**
 * 真打完一小场，看**牌桌上到底弹了什么出来**。
 *
 * 按玩法，一小场结束时只做一件事：在牌桌上弹一下四家的得失分，停留一会儿就开下一小场。
 * 所以这条探针要守住的是**它不做什么**：
 *   * 不弹面板、不压遮罩（不是 `position:fixed` 的大浮层）；
 *   * 不展示牌型、不亮四家手牌与副露、不列玩家明细；
 *   * 不用玩家按任何按钮（数字到点自己收）。
 * 这些取舍全在渲染层，而且帧里**照样带着** `wins` 与四家手牌 ——
 * 单测与构造帧的离线探针都只能证明「该画的画了」，证明不了「不该画的没画」。
 * 这里跑的是真对局、真帧。
 *
 * `FULL_MATCH=1` 再往前推一步：**一直打到整局结算**（8 小场打完），
 * 验结算记录顶部的「开始时间 / 耗时」与下面那四行玩家明细
 * （头像 + 昵称 + 10 位 id 号 + 本局积分变化 + 入账后的账号余额）。
 * 默认不打开（打满 8 小场要几分钟），但**改整局结算那条路径时必须跑一次**。
 */
import { JSDOM } from "jsdom";

const PAGE = process.env.PAGE ?? "http://127.0.0.1:3000/multi";
// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const MODULE = new URL("../../apps/client/dist/browser/multi-client.js", import.meta.url).href;
const KEYS = (process.env.KEYS ?? "").split(",").map((each) => each.trim()).filter(Boolean);
const SECONDS = Number(process.env.SECONDS ?? 120);
/**
 * `FULL_MATCH=1` 时一直打到整局结算并验那一屏。默认只打一小场 ——
 * 日常改小场那屏的文案时不用等几分钟。
 */
const FULL = process.env.FULL_MATCH === "1";

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

/** 牌桌上弹出来的那一块在不在。 */
const popVisible = () => document.querySelector("#center .round-pop") !== null;
/** 那一块的标题：「第 3/8 小场」。 */
const popTitle = () => document.querySelector("#center .round-pop-title")?.textContent?.trim() ?? "";
/** 那一块里的四家得失分（本小场），按座位排。 */
const popValues = () => [...document.querySelectorAll("#center .round-pop .score-value")].map((node) => node.textContent.trim());
/**
 * 这一屏**不该**出现的东西。命中就报出来 —— 「不该画的没画」才是这条探针的重点。
 *
 * ⚠️ 判据要**限定在那一块里面**（`#center .round-pop <selector>`）：
 * 牌桌本身的副露也是 `.meld-group`，拿全局选择器会把牌桌上的正常副露误判成「结算屏亮了牌」
 * （实机踩到过）。
 *
 * `.score-total` / `.score-account` 是整局结算记录那套（本场累计 / 账号入账）；
 * `.win-summary` / `.result-player` / `.meld-group` 是牌型与牌面；
 * 最后两条守的是「不是面板、也不用按按钮」—— 旧版是 `.panel` 的大浮层加一颗「继续」。
 * 按钮**不能**写成 `#center button`：牌桌上的操作按钮也在 `#center` 里，会误伤。
 */
const FORBIDDEN = [
  ["牌型/胡牌说明", ".win-summary"],
  ["玩家明细行", ".result-player"],
  ["四家牌面与副露", ".meld-group"],
  ["本场累计那一行", ".score-total"],
  ["账号入账那一行", ".score-account"],
];
const forbiddenOnPop = () => [
  ...FORBIDDEN
    .map(([label, selector]) => [label, document.querySelectorAll(`#center .round-pop ${selector}`).length])
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}(${count})`),
  // 整屏浮层与它里面那颗按钮：旧版是 `.panel` + 「继续 / 看本局结算」。
  ...(document.querySelectorAll("#center .panel").length > 0 ? ["结算面板"] : []),
  ...(document.querySelectorAll("#center .round-pop button").length > 0 ? ["那一块里的按钮"] : []),
];

/** 整局结算记录顶部的「开始 … 耗时 …」。 */
const matchTime = () => document.querySelector("#center .match-time")?.textContent?.trim() ?? "";
/** 整局结算记录下面那四行玩家明细（头像 + 昵称 + 10 位 id 号 + 本局积分变化 + 入账余额）。 */
const matchRows = () => [...document.querySelectorAll("#center .match-player-row")].map((row) => ({
  title: document.querySelector("#center h2")?.textContent?.trim() ?? "",
  name: row.querySelector(".match-player-name")?.textContent?.trim() ?? "",
  id: row.querySelector(".match-player-id")?.textContent?.trim() ?? "",
  delta: row.querySelector(".match-player-delta")?.textContent?.trim() ?? "",
  account: row.querySelector(".match-player-account")?.textContent?.trim() ?? "",
  avatars: row.querySelectorAll(".match-player-avatar img").length,
}));

let captured = null;
let matchCaptured = null;
const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  // 一小场那屏只存在几秒（服务端给的停留时长），抓到的第一份就是它。
  if (captured === null && popVisible()) {
    captured = { title: popTitle(), scores: popValues(), forbidden: forbiddenOnPop() };
  }

  // 整局结算记录：数字放完之后**自动**出现，不用按任何东西（只有 FULL_MATCH=1 才走得到）。
  if (matchCaptured === null && document.querySelector("#center .match-player-row")) {
    matchCaptured = { time: matchTime(), rows: matchRows(), popLeftOver: popVisible() };
    break;
  }
  if (!FULL && captured !== null) break;

  const meta = metaText();
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

console.log("=== 一小场结束时牌桌上弹出的那一块 ===");
if (!captured) {
  console.log("  （采样期间没走到小场结算）");
} else {
  console.log(`  标题：${captured.title || "（空）"}`);
  console.log(`  四个数字：${captured.scores.join("　") || "（一个都没有）"}`);
  console.log(`  不该出现的：${captured.forbidden.join("、") || "（都没有 ✓）"}`);
}

if (FULL) {
  console.log("\n=== 整局结算记录（打满 8 小场）===");
  if (!matchCaptured) {
    console.log("  （采样期间没打到整局结算）");
  } else {
    console.log(`  时间：${matchCaptured.time}`);
    for (const row of matchCaptured.rows) {
      console.log(`  ${row.name} ｜ ${row.id} ｜ ${row.delta} ｜ ${row.account} ｜ 头像 ${row.avatars}`);
    }
  }
}

const failures = [];
if (crashes.length > 0) failures.push(...crashes);
if (!captured) failures.push("采样期间没走到小场结算，无法验证");
else {
  if (!/^第 \d+\/8 小场$/.test(captured.title)) failures.push(`弹出的那一块没写清是第几小场：${captured.title || "（空）"}`);
  // 真实对局里也要画出来，而且是**零和**的四个数。
  if (captured.scores.length !== 4) {
    failures.push(`牌桌上应弹四家分数，实际 ${captured.scores.length} 个`);
  } else {
    const total = captured.scores.reduce((sum, text) => sum + Number(text), 0);
    if (!Number.isFinite(total)) failures.push(`分数不是数字：${captured.scores.join("　")}`);
    else if (total !== 0) failures.push(`四家分数不是零和：${captured.scores.join("　")}（合计 ${total}）`);
  }
  if (captured.forbidden.length > 0) {
    failures.push(`小场这一屏不该出现这些：${captured.forbidden.join("、")}`);
  }
}

// 整局结算记录：只有 FULL_MATCH=1 才验。这一屏的数据**只有打满 8 小场那一刻**才有
// （头像与 id 在房间成员上、入账分与余额要等 `finalize()` 写完账号），
// 构造帧的离线探针覆盖不了这一跳。
if (FULL) {
  if (!matchCaptured) {
    failures.push("采样期间没打到整局结算，无法验证四行明细");
  } else {
    const title = matchCaptured.rows[0]?.title ?? "";
    if (!/^本局结算记录/.test(title)) failures.push(`结算记录标题不对：${title}`);
    if (matchCaptured.popLeftOver) failures.push("结算记录出来时，小场那一屏还没退场");
    if (!/^开始 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(matchCaptured.time)) {
      failures.push(`结算记录顶部没写开始时间：${matchCaptured.time || "（空）"}`);
    }
    if (!/耗时 \d/.test(matchCaptured.time)) failures.push(`结算记录没写耗时：${matchCaptured.time}`);
    if (matchCaptured.rows.length !== 4) failures.push(`应有四行玩家明细，实际 ${matchCaptured.rows.length} 行`);
    for (const row of matchCaptured.rows) {
      if (row.name === "") failures.push("有一行没有昵称");
      if (!/^\d 号位 · ID \d{10}$/.test(row.id)) failures.push(`id 号那一行不对：${row.id}`);
      if (!/^[+-]?\d+$/.test(row.delta)) failures.push(`本局积分变化不是数字：${row.delta}`);
      if (!/账号 \d+ 分$/.test(row.account)) failures.push(`没写入账后的余额：${row.account}`);
      if (row.avatars !== 1) failures.push(`${row.name} 那一行没有头像`);
    }
    const rowsTotal = matchCaptured.rows.reduce((sum, row) => sum + Number(row.delta), 0);
    if (Number.isFinite(rowsTotal) && rowsTotal !== 0) failures.push(`四行明细不是零和：合计 ${rowsTotal}`);
  }
}

console.log("");
if (failures.length === 0) {
  console.log(FULL
    ? "结论：一小场只在牌桌上弹四个数字（无面板、无牌型牌面、无按钮），放完自动出整局结算记录（时间 + 四行明细）"
    : "结论：一小场只在牌桌上弹四个数字（无面板、无牌型牌面、无按钮）");
} else {
  console.log("结论：有问题");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
