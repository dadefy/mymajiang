/**
 * 在 jsdom 里直接跑**共用的副露渲染器**，看它到底画出几张亮牌、几张扣牌。
 *
 * 单测能证明 `meldDisplay` 的数据对（1 亮 3 扣），但证明不了渲染器真的照它画 ——
 * 少一个 append、类名写错，数据全对而屏幕上还是四张亮牌。
 */
import { JSDOM } from "jsdom";

// 客户端产物，先跑 pnpm build。路径相对本文件，不写死绝对路径。
const DIST = new URL("../../apps/client/dist/browser", import.meta.url).href;

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { meldBox } = await import(`${DIST}/tile-chips.js`);

/** 把一副副露画出来，数一数亮/扣各几张。 */
function render(melds) {
  const box = meldBox(melds);
  const groups = [...box.querySelectorAll(".meld-group")];
  return groups.map((group) => {
    const chips = [...group.querySelectorAll(".chip")];
    return {
      kind: group.querySelector(".kind")?.textContent ?? "?",
      faceUp: chips.filter((chip) => !chip.classList.contains("back")).map((chip) => chip.textContent),
      faceDown: chips.filter((chip) => chip.classList.contains("back")).length,
      kongStyle: group.classList.contains("kong"),
    };
  });
}

const cases = [
  ["碰", [{ kind: "pong", tile: 0 }], 3, 0, "碰"],
  ["明杠", [{ kind: "kong", tile: 13 }], 4, 0, "杠"],
  ["暗杠（牌值可见）", [{ kind: "kong", tile: 20, concealed: true }], 1, 3, "暗杠"],
  ["暗杠（牌值不可见）", [{ kind: "kong", tile: null, concealed: true }], 0, 4, "暗杠"],
];

let failed = 0;
for (const [label, melds, expectUp, expectDown, expectKind] of cases) {
  const [drawn] = render(melds);
  const ok = drawn && drawn.faceUp.length === expectUp && drawn.faceDown === expectDown && drawn.kind === expectKind;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "通过" : "失败"}  ${label.padEnd(18)} → ${drawn?.kind}  ` +
    `亮 ${drawn?.faceUp.length} 张 [${drawn?.faceUp.join(" ")}]  扣 ${drawn?.faceDown} 张` +
    `（期望：亮 ${expectUp} 扣 ${expectDown}）`,
  );
}

// 一副副露的牌数必须守恒：亮的 + 扣的 = 碰 3 / 杠 4。
for (const [label, melds] of cases) {
  const [drawn] = render(melds);
  if (drawn.faceUp.length + drawn.faceDown !== 3 + (melds[0].kind === "kong" ? 1 : 0)) {
    failed += 1;
    console.log(`失败  ${label} 牌数不守恒：${drawn.faceUp.length} + ${drawn.faceDown}`);
  }
}

// 多副混在一起时互不串台（血战后期的常态）。
const mixed = render([
  { kind: "pong", tile: 5 },
  { kind: "kong", tile: 20, concealed: true },
  { kind: "kong", tile: 13 },
]);
console.log(`\n多副混排：${mixed.map((m) => `${m.kind}(亮${m.faceUp.length}/扣${m.faceDown})`).join("  ")}`);
if (mixed.length !== 3) {
  failed += 1;
  console.log("失败  多副副露没有被分成三个框");
}

// 一副都没有时不该冒出空框。
if (meldBox([]).childElementCount !== 0) {
  failed += 1;
  console.log("失败  没有副露时仍然画了框");
}

console.log("");
if (failed === 0) {
  console.log("结论：暗杠只亮一张、其余三张扣着；碰与明杠全亮 —— 渲染器照做了");
} else {
  console.log(`结论：有 ${failed} 处不符`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
