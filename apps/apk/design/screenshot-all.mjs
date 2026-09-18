// 补齐 14 页 1920（末页 2400）标准态截图。结构与 check-overflow.mjs 相同的 CDP 模式。
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DESIGN = import.meta.dirname;
const SHOT = join(DESIGN, "screenshots");
mkdirSync(SHOT, { recursive: true });
const PORT = 9229;
const UDD = join(DESIGN, ".chrome-profile3");
const NAMESDefault = ["01-login","02-lobby","03-create-room"];
const NAMES = process.argv[2] ? process.argv[2].split(",") : NAMESDefault;

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${UDD}`,
    "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

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
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const loadAndShot = async (url, width, file) => {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(420);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOT, file), Buffer.from(shot.result.data, "base64"));
  console.log("shot:", file);
};

await send("Page.enable");
for (const name of NAMES) {
  const width = name === "14-lobby-2400" ? 2400 : 1920;
  const url = "file:///" + join(DESIGN, "screens", `${name}.html`).replace(/\\/g, "/");
  await loadAndShot(url, width, `${name}-1920.png`);
}
ws.close();
chrome.kill();
rmSync(UDD, { recursive: true, force: true, maxRetries: 3 });
console.log("完成");
