/**
 * 用 jsdom 把线上 /multi 页面原样加载，再让 multi-client 模块真正执行一遍。
 *
 * 目的：HTTP 200 只能证明「文件取得到」，证明不了「JS 跑得起来」。
 * 这里检查模块执行后 DOM 是否被正确填充（输入框是 JS 动态创建的，
 * JS 一挂就会只剩标题和按钮，看起来就像「打不开」）。
 */
import { JSDOM } from "jsdom";

const PAGE = process.env.PAGE ?? "https://mianyang-mahjong-table.app.workbuddy.host/multi";
// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const MODULE = new URL("../../apps/client/dist/browser/multi-client.js", import.meta.url).href;

const html = await (await fetch(PAGE)).text();
console.log(`线上页面：${html.length} 字节`);

const dom = new JSDOM(html, { url: PAGE, pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const before = window.document.querySelectorAll("#keys input").length;
console.log(`模块执行前，#keys 里的输入框：${before} 个（应为 0 —— 它们由 JS 创建）`);

let crashed = null;
try {
  await import(MODULE);
} catch (error) {
  crashed = error;
}

const after = window.document.querySelectorAll("#keys input").length;
const boardHidden = window.document.querySelector("#board")?.hidden;
const barText = window.document.querySelector("#bar")?.textContent?.trim() ?? "";
const autoText = window.document.querySelector("#auto")?.textContent ?? "";
const statusText = window.document.querySelector("#status")?.textContent ?? "";

console.log(`模块执行后，#keys 里的输入框：${after} 个`);
console.log(`#board 是否隐藏：${boardHidden}`);
console.log(`#bar 内容：${JSON.stringify(barText)}`);
console.log(`#auto 按钮：${JSON.stringify(autoText)}`);
console.log(`#status：${JSON.stringify(statusText)}`);

if (crashed) {
  console.log("\n模块执行抛错：");
  console.log(crashed.stack ?? String(crashed));
  process.exitCode = 1;
} else if (after === 4 && boardHidden === true && barText.length > 0) {
  console.log("\n结论：页面在浏览器里能正常初始化 —— 四个输入框、按钮、顶栏都就位了");
} else {
  console.log("\n结论：模块没抛错，但 DOM 没有按预期填充");
  process.exitCode = 1;
}
