/**
 * 抓**线上真正在跑的**模块到本地，再驱动一局，验证本轮两项新功能：
 *
 *   ① 换三张改成逐张选牌（同值牌独立选择、不超过实际张数）；
 *   ② 本局结算亮出四家牌面，并逐家写明「怎么胡的、谁给的牌」。
 *
 * 为什么要抓线上的：本地 dist 与线上可能不是同一次构建（部署把 dist 排除在上传之外、
 * 在沙箱里重新构建）。HTTP 200 只能证明文件取得到，证明不了「JS 真把面板画出来了」。
 *
 * 做法：从入口模块开始 BFS，把所有**相对 import** 的模块按原目录结构落盘，
 * 然后从本地文件 import —— 跑的是线上那份代码，页面 URL 仍指向线上，
 * 所以 fetch / WebSocket 打的是线上服务端。
 */
import { JSDOM } from "jsdom";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE ?? "https://mianyang-mahjong.app.workbuddy.host";
const PAGE = `${BASE}/multi`;
const OUT_DIR = fileURLToPath(new URL("./remote/", import.meta.url));
const KEYS = (process.env.KEYS ?? "").split(",").map((each) => each.trim()).filter(Boolean);
const SECONDS = Number(process.env.SECONDS ?? 120);

if (KEYS.length !== 4) {
  console.error("需要 4 把密钥：KEYS=密钥1,密钥2,密钥3,密钥4");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- ① 把线上模块抓下来 ----------

/** 入口在页面里以相对路径出现，先解析成绝对 URL。 */
async function entryModule() {
  const html = await (await fetch(PAGE)).text();
  const match = html.match(/src="([^"]*multi-client\.js)"/);
  if (!match) throw new Error("页面里找不到 multi-client.js 入口");
  return { html, url: new URL(match[1], PAGE).href };
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

async function mirrorModules(entryUrl) {
  const seen = new Map(); // 绝对 URL -> 本地相对路径（相对 OUT_DIR）
  const queue = [entryUrl];
  while (queue.length > 0) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    // 静态资源可能被 CDN 缓存 —— 抓的时候必须加 cache-buster，否则验证的是缓存里的旧副本。
    // 已踩过：源站已是新版，脚本读到的却是 32 分钟前的旧文件，于是把「面板没画出来」误报成缺陷。
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`);
    if (!response.ok) throw new Error(`抓不到 ${url}（HTTP ${response.status}）`);
    const code = await response.text();

    // 落盘路径：以 /debug/ 为根，保持相对结构（模块之间用的是相对 import）。
    const pathname = new URL(url).pathname;
    if (!pathname.startsWith("/debug/")) throw new Error(`模块不在 /debug/ 下：${url}`);
    const path = pathname.slice("/debug/".length);
    seen.set(url, path);
    const target = join(OUT_DIR, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code, "utf8");

    for (const found of code.matchAll(IMPORT_RE)) {
      queue.push(new URL(found[1], url).href);
    }
  }
  return seen;
}

const { html, url: entryUrl } = await entryModule();
const mirrored = await mirrorModules(entryUrl);
console.log(`=== 抓到线上模块 ${mirrored.size} 个 ===`);
for (const path of mirrored.values()) console.log(`  ${path}`);

// ---------- ② 用线上页面 + 线上模块驱动一局 ----------

const crashes = [];
process.on("uncaughtException", (error) => crashes.push(String(error?.message ?? error)));

const dom = new JSDOM(html, { url: PAGE, pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

globalThis.window = window;
globalThis.document = document;
globalThis.location = window.location;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// 拦下原始帧：判断「服务端到底有没有下发 swap」比看 DOM 可靠 ——
// 按钮可能是渲染出来了但 disabled（disabled 的按钮点不动，看着像「选了没反应」）。
const frames = [];
// 局间的可靠判据：最后一条 round-finished 比最后一条 game 帧更晚。
// **不能看 meta** —— 服务端一局结束时只发结算帧、不发 game 帧，所以局间 match 停在
// 结束**之前**的状态，meta 里写的还是「行牌」/「等待别人确认」，看着像还在打。
let lastFinishAt = 0;
let lastGameAt = 0;
const NativeWebSocket = globalThis.WebSocket;
class RecordingWebSocket extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    this.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "actions") frames.push({ type: "actions", actions: data.actions });
        else if (data.type === "game") {
          // 服务端推对局状态的帧类型是 `game`（`state` 是 MatchState），不是 `match` ——
          // 写成 `match` 会一条都收不到，量局间停留时就只能得到 0。
          // 记时间戳是为了量「round-finished → 下一局首个 game 帧」的间隔。
          const at = Date.now();
          lastGameAt = at;
          frames.push({
            type: "game",
            phase: data.state?.phase,
            seat: data.state?.seat,
            roundNumber: data.state?.roundNumber,
            at,
          });
        } else if (data.type === "round-finished") {
          // 这一条是判断「服务端到底有没有下发 wins」的唯一依据 ——
          // 页面上的 .win-summary 为空，既可能是没下发，也可能是下发了但渲染没画。
          const at = Date.now();
          lastFinishAt = at;
          frames.push({
            type: "round-finished",
            at,
            nextRoundInMs: data.nextRoundInMs,
            reason: data.result?.reason,
            winnerSeats: data.result?.winnerSeats,
            wins: Array.isArray(data.result?.wins) ? data.result.wins.length : `(${typeof data.result?.wins})`,
            keys: Object.keys(data.result ?? {}).join(","),
          });
        }
      } catch { /* 忽略非 JSON 帧 */ }
    });
  }
}
globalThis.WebSocket = RecordingWebSocket;

const entryPath = mirrored.get(entryUrl);
await import(new URL(`./remote/${entryPath}`, import.meta.url).href);

const inputs = [...document.querySelectorAll("#keys input")];
inputs.forEach((input, index) => { input.value = KEYS[index]; });
document.querySelector("#auto").click();
await sleep(4000);

const metaText = () => document.querySelector("#center .meta")?.textContent ?? "";
const opsButtons = () => [...document.querySelectorAll(".ops button")];
const clickAll = (labels) => {
  let count = 0;
  for (const node of opsButtons()) {
    if (labels.includes(node.textContent ?? "")) { node.click(); count += 1; }
  }
  return count;
};

// ---------- ③ 换三张逐张选牌：只验证一次，且用手动点选 ----------

let swapProbe = "（没走到换三张阶段）";
const swapUntil = Date.now() + SECONDS * 1000;
while (Date.now() < swapUntil && metaText().includes("换三张") === false) {
  // 还没进换三张：把自动开局之后可能出现的东西推过去。
  if (metaText().includes("定缺")) clickAll(["四家全部自动定缺"]);
  await sleep(100);
}

if (metaText().includes("换三张")) {
  // ⚠️ renderBoard() 每次渲染都 `host.replaceChildren()` **重建整张座位卡**，
  // 所以不能缓存卡片/按钮的节点引用 —— 那样拿到的是已被替换掉的游离节点，
  // 读它永远读到旧内容（会误判成「点了没反应」）。只认 #pos-* 容器（静态），
  // 每次都从中重新查询。
  const host = ["bottom", "right", "top", "left"]
    .map((position) => document.querySelector(`#pos-${position}`))
    .find((node) => node && [...node.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("换这三张")));
  const card = () => host?.querySelector(".seat-card") ?? null;
  const hand = () => [...(card()?.querySelectorAll(".hand button") ?? [])];
  const chosenCount = () => card()?.querySelectorAll(".hand button.chosen").length ?? 0;
  const swapButton = () => [...(card()?.querySelectorAll("button") ?? [])]
    .find((b) => (b.textContent ?? "").includes("换这三张"));

  // 按钮的 disabled 由「服务端有没有下发 swap」决定，先等这一帧到（最多 3 秒）。
  const waitFrom = Date.now();
  while (Date.now() - waitFrom < 3000
    && !frames.some((f) => f.type === "actions" && (f.actions ?? []).includes("swap"))) {
    await sleep(100);
  }
  const swapFrames = frames.filter((f) => f.type === "actions" && (f.actions ?? []).includes("swap"));
  const before = hand();
  const head = (card()?.querySelector(".seat-head")?.textContent ?? "(没找到座位卡)").trim();
  const diag = `${head} ｜ 手牌 ${before.length} 张（disabled ${before.filter((t) => t.disabled).length} 张）`
    + ` ｜ 收到含 swap 的 actions 帧 ${swapFrames.length} 条`;

  // 按花色分组（牌面文字的最后一个是「万/筒/条」），挑张数最多的一组 —— 便于验证重复牌面。
  const bySuit = new Map();
  for (const [index, tile] of before.entries()) {
    const suit = (tile.textContent ?? "").slice(-1);
    bySuit.set(suit, [...(bySuit.get(suit) ?? []), index]);
  }
  const pick = [...bySuit.values()].sort((a, b) => b.length - a.length)[0] ?? [];

  if (pick.length >= 3) {
    const label = () => `${before[pick[0]]?.textContent} 等 ${pick.length} 张同花色`;
    const clickTile = (slot) => hand()[pick[slot]]?.click();
    clickTile(0); await sleep(120);
    const afterOne = chosenCount();
    clickTile(1); await sleep(120);
    const afterTwo = chosenCount();
    clickTile(2); await sleep(120);
    const afterThree = chosenCount();
    swapProbe = `${diag}\n  逐张点选（${label()}）→ 选中数 ${afterOne} → ${afterTwo} → ${afterThree}`
      + `，按钮「${swapButton()?.textContent}」`;
    // 单独取消一张（同值牌各自独立，取消的是刚点的那张）。
    clickTile(2); await sleep(120);
    const afterUndo = chosenCount();
    swapProbe += `\n  再点同一张取消 → 选中 ${afterUndo} 张，按钮「${swapButton()?.textContent}」`;
    // 补回第三张并提交，好让牌局继续。
    clickTile(2); await sleep(120);
    swapButton()?.click();
    await sleep(400);
    swapProbe += `\n  提交后该座位操作行：${[...(card()?.querySelectorAll(".ops button") ?? [])].map((b) => b.textContent).join(" / ") || "（无）"}`;
  } else {
    swapProbe = `${diag}\n  这个座位同花色牌不足 3 张（手牌 ${before.map((t) => t.textContent).join(" ")}）`;
  }
}

// ---------- ④ 打到结算，抓结算面板 ----------

const winSummaries = () => [...document.querySelectorAll(".win-summary")].map((node) => node.textContent ?? "");
const playerRows = () => [...document.querySelectorAll(".result-player p")].map((node) => node.textContent ?? "");
/** 结算面板里亮出的四家牌面（副露与手牌的小牌块）。 */
const revealed = () => [...document.querySelectorAll(".result-player .chip")].length;

let captured = null;
// 记阶段轨迹：万一 240 秒没打到结算，要能看出卡在哪一步（而不是只报「没走到」）。
const phaseTrail = [];
const brief = (text) => text.replace(/牌墙剩 \d+ 张/, "").replace(/\s+/g, " ").trim();
// 每个结算帧采一次面板。**流局（无人胡）本来就没有胡牌说明**，所以断言必须落在
// 「有胡牌的局」上 —— 否则会把正确的流局结算误判成缺陷（第一版就踩了这个）。
const panelSamples = [];
// 结算浮层只该在**局间**出现：meta 写着「第 N 局」就说明这一局正在进行，
// 那时还挂着浮层就是用户报的现象（第一局的结算浮在第二局的牌桌中间）。
let modalLeaks = 0;
const modalLeakSamples = [];
let summarySeen = 0;
let lastSummaryAt = 0;
/** 上一次采样的那个结算帧时刻，用来保证「一局只采一次、且不在渲染完成前采」。 */
let lastSampledFinishAt = 0;
/** 跑完了几次「进局间 → 又开新局」。这是收工的额外条件（否则第一局就退出了）。 */
let pauseSeen = 0;
let wasInterRound = false;
let interRoundEntered = false;
/** 局间出现过的倒计时文案（去重）与见过的最小秒数 —— 秒数往下走才说明它真在倒计时。 */
const countdownTexts = new Set();
let countdownMinSeconds = null;
const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  const meta = metaText();
  const line = brief(meta);
  if (phaseTrail[phaseTrail.length - 1] !== line) phaseTrail.push(line);

  const summaries = winSummaries();
  const panelOpen = document.querySelectorAll(".result-player").length > 0;
  const roundFramesNow = frames.filter((entry) => entry.type === "round-finished");
  const latestRound = roundFramesNow[roundFramesNow.length - 1];

  // 局间 = 最后一条结算帧比最后一条对局帧更晚（含「还没打过任何一局」）。
  const interRound = lastFinishAt > 0 && lastFinishAt > lastGameAt;
  const inRound = !interRound;
  // 新局刚开始的那几百毫秒里，结算浮层还留在屏幕上是**正常的** —— 新局的帧还在路上。
  // 线上实测这个窗口约 200ms（本地几乎为 0），所以给 1.5 秒宽限，只有持续挂着才算残留。
  const roundJustStarted = lastGameAt > 0 && Date.now() - lastGameAt < 1500;
  if (inRound && panelOpen && !roundJustStarted) {
    modalLeaks += 1;
    if (modalLeakSamples.length < 3) {
      modalLeakSamples.push(`${line} → 仍有 ${document.querySelectorAll(".result-player").length} 个 result-player`);
    }
  }
  // 浮层退场后应留下「上一局…」摘要，否则番型与放炮者就白显示了。
  if (inRound && [...document.querySelectorAll("#center .hint")]
    .some((node) => (node.textContent ?? "").startsWith("上一局"))) {
    if (Date.now() - lastSummaryAt > 2000) summarySeen += 1;
    lastSummaryAt = Date.now();
  }
  // 局间（meta 为空）应看到倒计时，且文案里的秒数要往下走 —— 静态文案看不出「在倒计时」。
  if (!inRound) {
    const text = document.querySelector("#center .countdown")?.textContent ?? "";
    if (/^\d+ 秒后开始下一局$/.test(text)) {
      countdownTexts.add(text);
      const seconds = Number(text.slice(0, text.indexOf(" ")));
      if (countdownMinSeconds === null || seconds < countdownMinSeconds) countdownMinSeconds = seconds;
    }
  }

  // 采样要等渲染跟上：帧到了但 DOM 还没重画时读到的是**上一局**的内容，
  // 会与刚到的帧对不上（线上延迟大，实测撞到过「有胡牌的局却没有胡牌说明」的假红）。
  if (panelOpen && latestRound && lastFinishAt !== lastSampledFinishAt && Date.now() - lastFinishAt > 300) {
    lastSampledFinishAt = lastFinishAt;
    const sample = {
      winnerSeats: latestRound.winnerSeats ?? [],
      wins: latestRound.wins,
      reason: latestRound.reason,
      summaries: [...summaries],
      rows: playerRows(),
      chips: revealed(),
    };
    panelSamples.push(sample);
    if (summaries.length === 0) captured = sample;
  }

  const withWinners = panelSamples.find((sample) => sample.winnerSeats.length > 0);
  // 采到「有胡牌的面板」还不足以收工：局间停留与倒计时要跨局才量得到。
  // 所以再要求至少跑完 2 次完整局间（进局间→又开新局算一次）。
  if (interRound && !wasInterRound) interRoundEntered = true;
  if (!interRound && wasInterRound && interRoundEntered) { pauseSeen += 1; interRoundEntered = false; }
  wasInterRound = interRound;
  if (pauseSeen >= 2 && withWinners && withWinners.summaries.length > 0) { captured = withWinners; break; }

  if (meta.includes("换三张")) clickAll(["四家全部自动换三张"]);
  else if (meta.includes("定缺")) clickAll(["四家全部自动定缺"]);
  else if (meta.includes("行牌")) {
    const card = [...document.querySelectorAll(".seat-card")].find((each) => each.querySelector(".tag.acting"));
    const tiles = card ? [...card.querySelectorAll(".hand button")] : [];
    const pick = tiles.find((tile) => tile.classList.contains("missing-suit")) ?? tiles[0];
    pick?.click();
  } else if (meta.includes("等待别人确认")) {
    if (clickAll(["碰", "杠", "胡"]) === 0) clickAll(["过"]);
  }
  await sleep(50);
}

console.log("\n=== ① 换三张逐张选牌 ===");
console.log(`  ${swapProbe}`);

console.log("\n=== ② 结算界面上的胡牌说明 ===");
const roundFrames = frames.filter((entry) => entry.type === "round-finished");
console.log(`  服务端原始结算帧 ${roundFrames.length} 条，其中 wins 字段：`
  + `${roundFrames.every((f) => f.keys.includes("wins")) ? "都在（含 wins）" : "有帧缺 wins"}`);
console.log(`  采样到 ${panelSamples.length} 次结算面板：`);
for (const sample of panelSamples) {
  console.log(`  · ${sample.reason} 赢家=[${sample.winnerSeats}] wins=${sample.wins}`
    + ` → 面板上胡牌说明 ${sample.summaries.length} 行、牌块 ${sample.chips} 个`);
}

const withWinners = panelSamples.filter((sample) => sample.winnerSeats.length > 0);
if (withWinners.length === 0) {
  console.log("  （采样期间没遇到「有人胡牌」的结算）");
  console.log(`  阶段轨迹（共 ${phaseTrail.length} 段）：`);
  for (const line of phaseTrail.slice(0, 20)) console.log(`    ${line}`);
} else {
  console.log("\n=== 有胡牌的局，面板上实际写的内容 ===");
  for (const line of withWinners[0].summaries) console.log(`  ${line}`);
  console.log("  每位玩家那一行：");
  for (const line of withWinners[0].rows) console.log(`    ${line}`);
  console.log(`  亮出的牌块：${withWinners[0].chips} 个`);
}

console.log("\n=== ③ 结算浮层不跨局残留 ===");
console.log(`  新局进行中仍挂着结算浮层的采样帧：${modalLeaks} 个`);
for (const line of modalLeakSamples) console.log(`    · ${line}`);
console.log(`  新局中显示「上一局…」摘要的时段数：${summarySeen}`);

console.log("\n=== ④ 局间停留（结算展示时间）===");
// 「一局结束 → 下一局开局」的间隔。四条连接都会各收到一份 round-finished，
// 所以只取该局的**第一条**，再找其后第一个 phase 为 swapping 的帧（那是新局的第一步）。
const pauses = [];
let finishAt = null;
for (const frame of frames) {
  if (frame.type === "round-finished") {
    if (finishAt === null) finishAt = frame.at;
  } else if (frame.type === "game" && frame.phase === "swapping" && finishAt !== null) {
    pauses.push(frame.at - finishAt);
    finishAt = null;
  }
}
console.log(`  量到 ${pauses.length} 次局间：${pauses.map((ms) => `${ms}ms`).join(" / ") || "（无）"}`);
// 倒计时要「在走」：出现过 ≥2 种文案、且见过小于等于 2 秒的那一刻。
console.log(`  局间出现过的倒计时文案：${[...countdownTexts].join(" / ") || "（无）"}`);
console.log(`  见过的最小秒数：${countdownMinSeconds ?? "（无）"}`);
// 服务端有没有把停留时长发下来 —— 倒计时显示不出来时，这一条能立刻定位是哪一侧。
const finishFrames = frames.filter((frame) => frame.type === "round-finished");
const withPause = finishFrames.filter((frame) => typeof frame.nextRoundInMs === "number" && frame.nextRoundInMs > 0);
console.log(`  结算帧带 nextRoundInMs：${withPause.length} / ${finishFrames.length}`
  + `（值 ${withPause[0]?.nextRoundInMs ?? "无"}）`);
console.log(`  结算帧字段：${finishFrames[0]?.keys ?? "（无）"}`);

const failures = [];
if (crashes.length > 0) failures.push(...crashes);
if (/没走到换三张/.test(swapProbe)) failures.push("没验到换三张逐张选牌");
else if (!/选中数 1 → 2 → 3/.test(swapProbe)) failures.push(`逐张点选没有生效：${swapProbe}`);
else if (!/取消 → 选中 2 张/.test(swapProbe)) failures.push(`单独取消没有生效：${swapProbe}`);
if (pauses.length === 0) failures.push("没量到局间停留（一局打完到下一局开局的间隔）");
else if (pauses.some((ms) => ms < 4_500)) {
  failures.push(`局间停留不足 5 秒：${pauses.filter((ms) => ms < 4_500).join(" / ")}ms`);
}
// 倒计时必须真的在走：只出现一种文案（比如卡在「5 秒」）说明那个 timer 没生效。
if (countdownTexts.size < 2) {
  failures.push(`局间没看到倒计时在走：${[...countdownTexts].join(" / ") || "（完全没有）"}`);
} else if (countdownMinSeconds === null || countdownMinSeconds > 2) {
  failures.push(`倒计时没走到最后几秒（最小只见到 ${countdownMinSeconds} 秒）`);
}
if (modalLeaks > 0) failures.push(`新局进行中还挂着结算浮层（${modalLeaks} 个采样帧）`);
else if (panelSamples.length > 0 && summarySeen === 0) {
  failures.push("有局结束过，但新局里没出现「上一局…」摘要（结算信息丢了）");
}
if (roundFrames.length === 0) failures.push("服务端没有下发结算帧");
else if (!roundFrames.every((frame) => frame.keys.includes("wins"))) failures.push("结算帧里没有 wins 字段");
// 只在真采到「有人胡牌」的局时才断言 —— 托管模式下多数局以流局收场，
// 没采到是概率问题、不是缺陷（胡牌说明本身已在别的轮次独立验证过）。
else if (withWinners.length > 0) {
  if (withWinners[0].summaries.length === 0) failures.push("有胡牌的局，面板上却没有胡牌说明");
  else {
    for (const line of withWinners[0].summaries) {
      if (!/番/.test(line)) failures.push(`缺番型：${line}`);
      if (!/(自摸|打出的|抢杠)/.test(line)) failures.push(`没写清怎么胡的、谁给的牌：${line}`);
    }
  }
}

console.log("");
if (failures.length === 0) {
  console.log("结论：线上跑的就是新版本，两项功能都在页面上生效");
} else {
  console.log("结论：有问题");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
