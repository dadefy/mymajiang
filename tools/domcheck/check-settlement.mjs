/**
 * 打一局到结算，看**结算界面上到底显示了什么**。
 *
 * 验两件事：
 *   ① 胡牌类型（番型明细）—— 玩家要能看出是清一色还是对对胡；
 *   ② 是谁给的牌 —— 点炮时指明放炮者与那张牌，自摸时写「自摸」。
 *
 * `FULL_MATCH=1` 再往前推一步：**一直打到整局结算**（8 小场打完、按掉最后一屏），
 * 验结算记录顶部的「开始时间 / 耗时」与下面那四行玩家明细
 * （头像 + 昵称 + 10 位 id 号 + 本局积分变化 + 入账后的账号余额）。
 * 默认不打开（打满 8 小场要几分钟），但**改整局结算那条路径时必须跑一次**：
 * 那一屏的数据只有真打完一整局才存在，离线探针用的是构造帧，覆盖不了这一跳。
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
/**
 * `FULL_MATCH=1` 时**一直打到整局结算**（8 小场打完、按掉最后一屏），
 * 并断言结算记录顶部的「开始 / 耗时」与下面四行玩家明细。
 *
 * 默认不打开：打满 8 小场要几分钟，日常改结算文案时跑一小场就够。
 * 但「四行明细」只在整局结算这一个时刻有数据（头像与 id 在房间成员上、
 * 入账分与余额要等 `finalize()` 写完账号），所以**改那条路径必须跑一次 FULL_MATCH**。
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

/** 结算面板上「胡了什么」的那些行。 */
const winSummaries = () => [...document.querySelectorAll(".win-summary")].map((node) => node.textContent ?? "");
/** 结算面板里每位玩家的行（含自家「怎么胡的」）。 */
const playerRows = () => [...document.querySelectorAll(".result-player p")].map((node) => node.textContent ?? "");
/** 弹窗顶上那一排四家分数：本小场的变化，按座位排。 */
const scoreValues = () => [...document.querySelectorAll("#center .score-value")].map((node) => node.textContent.trim());
/** 弹窗标题：「第 N/8 小场结束 · 三家胡」。 */
const panelTitle = () => document.querySelector("#center h2")?.textContent?.trim() ?? "";
/** 弹窗上那个按钮：最后一小场的是「看本局结算」，其余是「继续」。 */
const panelButton = () => document.querySelector("#center .panel > button")?.textContent?.trim() ?? "";
/** 整局结算记录顶部的「开始 … 耗时 …」。 */
const matchTime = () => document.querySelector("#center .match-time")?.textContent?.trim() ?? "";
/** 整局结算记录下面那四行玩家明细（头像 + 昵称 + 10 位 id 号 + 本局积分变化 + 入账余额）。 */
const matchRows = () => [...document.querySelectorAll("#center .match-player-row")].map((row) => ({
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
  // 打满 8 小场后，最后一小场那一屏的按钮变成「看本局结算」——**必须按掉它**，
  // 否则整局结算记录按设计就不会出现（两屏不能同时压上来，见 match-result.ts）。
  if (panelButton() === "看本局结算") {
    document.querySelector("#center .panel > button").click();
    await sleep(50);
  }

  // 整局结算记录（只有 FULL_MATCH=1 才走得到）。
  if (matchCaptured === null && document.querySelector("#center .match-player-row")) {
    matchCaptured = { title: panelTitle(), time: matchTime(), rows: matchRows() };
    if (FULL) break;
  }

  const meta = metaText();
  // 本小场一结束就抓一次（面板只在结算那一刻存在）。**抓到有胡牌行的那一次就冻结**：
  // 往后整局结算记录里也含「本局结束」这几个字，不冻结就会被覆盖成一份空的。
  const summaries = winSummaries();
  if (summaries.length > 0 || (captured === null && meta.includes("本局结束"))) {
    captured = { summaries, rows: playerRows(), meta, scores: scoreValues(), title: panelTitle() };
  }
  if (!FULL && summaries.length > 0) break;

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
  console.log("\n=== 顶上那排四家分数（本小场）===");
  console.log(`  标题：${captured.title || "（没有 h2）"}`);
  console.log(`  四个数字：${captured.scores.join("　") || "（一个都没有）"}`);
}

if (FULL) {
  console.log("\n=== 整局结算记录（打满 8 小场）===");
  if (!matchCaptured) {
    console.log("  （采样期间没打到整局结算）");
  } else {
    console.log(`  标题：${matchCaptured.title}`);
    console.log(`  时间：${matchCaptured.time}`);
    for (const row of matchCaptured.rows) {
      console.log(`  ${row.name} ｜ ${row.id} ｜ ${row.delta} ｜ ${row.account} ｜ 头像 ${row.avatars}`);
    }
  }
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
  // 顶上那排分数：真实对局里也要画出来，而且是**零和**的四个数。
  // 单测与离线探针都覆盖不到这里 —— 它们用的是构造出来的帧，这条走的是真结算。
  if (captured.scores.length !== 4) {
    failures.push(`结算弹窗里应有四家分数，实际 ${captured.scores.length} 个`);
  } else {
    const total = captured.scores.reduce((sum, text) => sum + Number(text), 0);
    if (!Number.isFinite(total)) failures.push(`分数不是数字：${captured.scores.join("　")}`);
    else if (total !== 0) failures.push(`四家分数不是零和：${captured.scores.join("　")}（合计 ${total}）`);
  }
  if (!/^第 \d+\/8 小场结束/.test(captured.title)) failures.push(`弹窗标题没写清是第几小场：${captured.title}`);
}

// 整局结算记录：只有 FULL_MATCH=1 才验。这一屏的四行明细**只在整局结算那一刻**有数据
// （头像与 id 在房间成员上、入账分与余额要等 `finalize()` 写完账号），
// 而且是「真打完 8 小场」才走得到 —— 离线探针用的是构造帧，覆盖不了这一跳。
if (FULL) {
  if (!matchCaptured) {
    failures.push("采样期间没打到整局结算，无法验证四行明细");
  } else {
    if (!/^本局结算记录/.test(matchCaptured.title)) failures.push(`结算记录标题不对：${matchCaptured.title}`);
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
  console.log("结论：结算界面显示了胡牌类型与「谁给的牌」");
} else {
  console.log("结论：有问题");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
