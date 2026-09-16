/**
 * 用无头 Chrome 量牌桌上各处牌块的**几何尺寸**。
 *
 * jsdom 没有布局引擎，`getBoundingClientRect()` 永远返回 0 —— 「牌被拉成长条」
 * 「副露横着摆」这类缺陷它一张都看不见，而这类缺陷只有真的画出来才发现得了。
 * 这里跑真实页面（真实的 CSS 级联，含页面模板那一份），量完再断言。
 *
 * 需要的环境：
 *   - 本地服务在跑（默认 http://127.0.0.1:3000）
 *   - 四把**没有进过房间**的密钥：`$env:KEYS = "k1,k2,k3,k4"`
 *   - 本机装了 Chrome 或 Edge（找不到就跳过，不算失败）
 *
 * 手牌取自真实对局；副露用真实的 `meldBox()` 注入最坏情况（1 碰 + 3 杠 = 14 张），
 * 因为「等一局里真的有人碰」等不到时会变成假绿。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE = process.env.PAGE ?? "http://127.0.0.1:3000/multi";
const KEYS = (process.env.KEYS ?? "").split(",").filter(Boolean);
const SHOT = process.env.SHOT ?? "";
const PORT = Number(process.env.CDP_PORT ?? 9333);
const VIEWPORTS = [[1280, 900], [1920, 1080], [1024, 700]];

const CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const browser = CANDIDATES.find((each) => existsSync(each));
if (!browser) {
  console.log("跳过：本机没有 Chrome / Edge，量不出布局。");
  process.exit(0);
}
if (KEYS.length !== 4) {
  console.log("跳过：需要 4 把未进房的密钥（KEYS 环境变量），否则进不了牌桌。");
  process.exit(0);
}

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(join(tmpdir(), "mymj-geometry-"));
const chrome = spawn(browser, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--window-size=1280,900",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  PAGE,
], { stdio: "ignore" });

async function firstPage() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((each) => each.type === "page" && each.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error("CDP 连不上浏览器");
}

const page = await firstPage();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本抛错");
  return result.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await sleep(1200);

await evaluate(`(() => {
  const keys = ${JSON.stringify(KEYS)};
  [...document.querySelectorAll('#keys input')].forEach((input, index) => {
    input.value = keys[index];
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.querySelector('#auto').click();
})()`);

/** 该自动的自动；轮到谁就替谁把第一张可选的牌打出去。 */
const STEP = `(() => {
  const ops = [...document.querySelectorAll('#board .ops button')];
  for (const button of ops) if (button.textContent.trim() === '自动') button.click();
  const claim = ops.find((b) => ['碰', '杠', '胡'].includes(b.textContent.trim()));
  if (claim) { claim.click(); return; }
  const pass = ops.find((b) => b.textContent.trim() === '过');
  if (pass) { pass.click(); return; }
  const tiles = [...document.querySelectorAll('#board .seat button.tile:not(:disabled)')];
  if (tiles.length) { tiles[0].click(); tiles[0].click(); }
})()`;

const deadline = Date.now() + 60_000;
let tiles = 0;
while (Date.now() < deadline) {
  tiles = Number(await evaluate(`document.querySelectorAll('#board .seat .hand button.tile').length`)) || 0;
  if (tiles > 0) break;
  await sleep(300);
}
if (tiles === 0) {
  console.log("跳过：60 秒内没进到牌桌（密钥可能已经进过房间，或服务端不是内存模式的干净状态）。");
  socket.close();
  chrome.kill();
  process.exit(0);
}
console.log(`牌桌已就绪，共 ${tiles} 张手牌在屏。`);

const injected = await evaluate(`(async () => {
  const base = document.querySelector('script[type=module]').src.replace(/[^/]+$/, '');
  const mod = await import(base + 'tile-chips.js');
  const melds = [
    { kind: 'pong', tile: 20 },
    { kind: 'kong', tile: 13 },
    { kind: 'kong', tile: 24, concealed: true },
    { kind: 'pong', tile: 5 },
  ];
  for (const pos of ['left', 'right']) {
    const host = document.querySelector('#board .seat.' + pos + ' .melds');
    if (!host) return 'missing:' + pos;
    host.replaceChildren(...mod.meldBox(melds).children);
  }
  return 'ok';
})()`);
console.log(`副露注入：${injected}（1 碰 3 张 + 明杠 4 张 + 暗杠 4 张 + 碰 3 张）`);

const measure = `(() => {
  const one = (value) => Math.round(value * 10) / 10;
  const size = (node) => { const r = node.getBoundingClientRect(); return { w: one(r.width), h: one(r.height) }; };
  const seats = {};
  for (const pos of ['top', 'bottom', 'left', 'right']) {
    const seat = document.querySelector('#board .seat.' + pos);
    const tiles = [...seat.querySelectorAll('.hand button.tile')];
    const groups = [...seat.querySelectorAll('.meld-group')];
    const chips = groups.flatMap((group) => [...group.querySelectorAll('.chip')]);
    const melds = seat.querySelector('.melds');
    seats[pos] = {
      tiles: tiles.length,
      tile: tiles[0] ? size(tiles[0]) : null,
      ratio: tiles[0] ? one(tiles[0].getBoundingClientRect().width / tiles[0].getBoundingClientRect().height) : null,
      groups: groups.length,
      direction: groups[0] ? getComputedStyle(groups[0]).flexDirection : null,
      chip: chips[0] ? size(chips[0]) : null,
      backs: chips.filter((chip) => chip.classList.contains('back')).length,
      meldsOverflow: melds ? melds.scrollHeight > melds.clientHeight + 1 : null,
      board: size(document.querySelector('#board')),
    };
  }
  return seats;
})()`;

for (const [width, height] of VIEWPORTS) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  const seats = await evaluate(measure);
  console.log(`\n视口 ${width}x${height} → 牌桌 ${seats.top.board.w}x${seats.top.board.h}`);
  for (const pos of ["top", "bottom", "left", "right"]) {
    const seat = seats[pos];
    console.log(`  ${pos.padEnd(6)} 牌 ${JSON.stringify(seat.tile)} 比 ${seat.ratio}｜副露 ${seat.groups} 组 方向 ${seat.direction} 牌块 ${JSON.stringify(seat.chip)}`);
  }

  // 上下两家本来就该是方的；左右两家以前会被拉成 3:1 的长条。
  // 实测四方都在 1.0~1.2，把上界定在 1.35 才留得住余量又不放跑长条。
  for (const pos of ["top", "bottom", "left", "right"]) {
    const ratio = seats[pos].ratio;
    if (ratio === null) continue;
    check(ratio > 0.85 && ratio < 1.35, `${width}px · ${pos} 家牌的宽高比 ${ratio} 在 0.85~1.35 之间（长条会掉出去）`);
  }
  for (const pos of ["left", "right"]) {
    check(seats[pos].direction === "column", `${width}px · ${pos} 家副露组内竖排（实际 ${seats[pos].direction}）`);
    check(seats[pos].meldsOverflow === false, `${width}px · ${pos} 家 4 副副露不溢出（实际 ${seats[pos].meldsOverflow}）`);
    check(seats[pos].backs === 3, `${width}px · ${pos} 家暗杠仍扣 3 张（实际 ${seats[pos].backs}）`);
  }
  check(seats.left.chip !== null && seats.left.chip.h > 0, `${width}px · 侧边副露牌块量得出高度（实际 ${JSON.stringify(seats.left.chip)}）`);

  if (SHOT && width === VIEWPORTS[0][0]) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
    console.log(`  截图：${SHOT}`);
  }
}

socket.close();
chrome.kill();

if (failures.length > 0) {
  console.log(`\n${failures.length} 项不达标。`);
  process.exitCode = 1;
} else {
  console.log("\n结论：四家牌的宽高比一致，侧边副露竖排且不溢出。");
}
