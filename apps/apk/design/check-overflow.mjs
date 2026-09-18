// 牌局外 UI 自动检查：溢出 / 重叠 / 安全区 / 控制台错误 + 截图。
// 用法：node check-overflow.mjs
// 组合：{1920, 2340, 2400} × {普通, 极端文本}，全部检查；截图存 ./screenshots/。
// 零依赖：本机 Chrome --headless=new + CDP（内置 WebSocket）。
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DESIGN = import.meta.dirname;
const SHOT = join(DESIGN, "screenshots");
mkdirSync(SHOT, { recursive: true });
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9227;
const UDD = join(DESIGN, ".chrome-profile");
const SCREENSDefault = ["01-login","02-lobby","03-create-room"];
const SCREENS = process.argv[2] ? process.argv[2].split(",") : SCREENSDefault;
const VIEWPORTS = [1920, 2340, 2400];

const problems = [];
let chrome;
try {
  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${UDD}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", "about:blank",
  ], { stdio: "ignore" });

  // 等 CDP 端口就绪
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      targets = JSON.parse(execSync(`curl -s http://127.0.0.1:${PORT}/json/list`, { encoding: "utf8" }));
      if (targets.some((t) => t.type === "page")) break;
    } catch { /* retry */ }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 120));
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErrors.push(msg.params.entry.text.slice(0, 120));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, (msg) => resolve(msg.result ?? msg.error));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitLoad = () => new Promise((resolve) => {
    const id = ++msgId;
    const onMsg = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) { ws.removeEventListener("message", onMsg); resolve(); }
      if (msg.method === "Page.loadEventFired") { ws.removeEventListener("message", onMsg); resolve(); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Page.enable" }));
    ws.send(JSON.stringify({ id: id + 0.5, method: "Page.reload" }));
  });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");

  const CHECK_FN = `
    (() => {
      const W = innerWidth, H = innerHeight, SAFE = 32;
      const out = { overflow: [], overlap: [], safe: [] };
      const leaves = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
        const semantic = el.textContent.trim() || el.classList.contains("avatar");
        const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if ((ownText || el.classList.contains("avatar")) && el !== document.body) {
          if (r.left < SAFE - 0.5 || r.top < SAFE - 0.5 || r.right > W - SAFE + 0.5 || r.bottom > H - SAFE + 0.5) {
            out.safe.push((el.className || el.tagName) + " [" + Math.round(r.left) + "," + Math.round(r.top) + "," + Math.round(r.right) + "," + Math.round(r.bottom) + "] " + el.textContent.trim().slice(0, 14));
          }
        }
        // 有 ellipsis / overflow hidden 的元素属于"设计上截断"，不算溢出缺陷
        const clamped = cs.textOverflow === "ellipsis" || (cs.overflowX === "hidden" && el.clientWidth > 0);
        if (ownText && !clamped && el.scrollWidth > el.clientWidth + 2) {
          out.overflow.push((el.className || el.tagName) + " <" + el.textContent.trim().slice(0, 14) + ">");
        }
        const isLeaf = el.children.length === 0;
        if ((isLeaf && el.textContent.trim()) || el.tagName === "BUTTON" || el.classList.contains("avatar")) {
          leaves.push({ el, r, text: el.textContent.trim().slice(0, 12) || "[图形]" });
        }
      }
      for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i], b = leaves[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix > 4 && iy > 4) out.overlap.push(a.text + " × " + b.text);
      }
      out.overlap = [...new Set(out.overlap)].slice(0, 8);
      out.overflow = [...new Set(out.overflow)].slice(0, 8);
      out.safe = [...new Set(out.safe)].slice(0, 8);
      return JSON.stringify(out);
    })()
  `;

  for (const name of SCREENS) {
    const fileUrl = "file:///" + join(DESIGN, "screens", `${name}.html`).replace(/\\/g, "/");
    for (const width of VIEWPORTS) {
      for (const ext of [false, true]) {
        const url = ext ? `${fileUrl}?ext=1` : fileUrl;
        await send("Emulation.setDeviceMetricsOverride", { width, height: 1080, deviceScaleFactor: 1, mobile: false });
        await send("Page.navigate", { url });
        await sleep(420); // 字体/布局稳定
        consoleErrors.length = 0;
        const res = await send("Runtime.evaluate", { expression: CHECK_FN, returnByValue: true });
        const errs = JSON.parse(res.result.value ?? "{}");
        const hasProblem = errs.overflow.length || errs.overlap.length || errs.safe.length || consoleErrors.length;
        if (hasProblem || ext) {
          const shot = await send("Page.captureScreenshot", { format: "png" });
          writeFileSync(join(SHOT, `${name}-${width}${ext ? "-ext" : ""}.png`), Buffer.from(shot.data, "base64"));
        }
        if (hasProblem) {
          problems.push({ name, width, ext: ext ? "极端" : "普通", ...errs, console: consoleErrors.slice(0, 3) });
        }
      }
    }
  }

  // 摘要
  if (problems.length === 0) {
    console.log(`PASS: ${SCREENS.length} 页 × 3 分辨率 × 2 文本模式 = ${SCREENS.length*6} 组合，0 溢出 / 0 重叠 / 0 安全区越界 / 0 控制台错误`);
  } else {
    console.log(`发现 ${problems.length} 组问题（共 ${SCREENS.length*6} 组合）：`);
    for (const p of problems) {
      console.log(`- ${p.name} @${p.width} ${p.ext}`);
      for (const o of p.overflow) console.log("  溢出:", o);
      for (const o of p.overlap) console.log("  重叠:", o);
      for (const o of p.safe) console.log("  安全区:", o);
      for (const o of p.console) console.log("  控制台:", o);
    }
    process.exitCode = 1;
  }
  ws.close();
} finally {
  if (chrome) chrome.kill();
  if (existsSync(UDD)) {
    try { rmSync(UDD, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* Chrome 句柄未释放时跳过，下次覆盖 */ }
  }
}
