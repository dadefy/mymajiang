import type { Tile, VisibleMeld } from "../protocol.js";
import { element } from "./dom.js";
import { tileLabel } from "./tile-label.js";
import { meldDisplay } from "./tile-view.js";

/**
 * 牌块：小尺寸的牌，用来画副露与弃牌堆（手牌用更大的按钮）。
 *
 * `/debug` 与 `/multi` 共用一份 —— 这两个页面是「同构但分开写」的，
 * 之前动作按钮的对应关系各写一遍，结果三个动作名一起写错；牌块同理，
 * 数量（碰 3 张 / 杠 4 张 / 暗杠扣几张）错了一眼看不出来。
 */

/** 一张亮着的牌。 */
export function tileChip(tile: Tile): HTMLElement {
  return element("span", { className: "chip", text: tileLabel(tile) });
}

/** 一张**扣着**的牌：别人的暗杠只让对手看见「有四张牌」。 */
export function backChip(): HTMLElement {
  return element("span", { className: "chip back" });
}

/**
 * 副露：一副一个框，框里按真实张数摆。
 *
 * 碰 3 张全亮；明杠 4 张全亮；**暗杠亮 1 张、其余 3 张扣着**
 * （口径在服务端 `meld-visibility.ts`，客户端只负责画）。
 */
export function meldBox(melds: readonly VisibleMeld[]): HTMLElement {
  const box = element("div", { className: "melds" });
  for (const meld of melds) {
    const view = meldDisplay(meld);
    const group = element("div", {
      className: `meld-group${meld.kind === "kong" ? " kong" : ""}${view.faceDown > 0 ? " hidden-part" : ""}`,
    });
    group.append(element("span", { className: "kind", text: view.kindLabel }));
    for (const tile of view.faceUp) group.append(tileChip(tile));
    for (let index = 0; index < view.faceDown; index += 1) group.append(backChip());
    box.append(group);
  }
  return box;
}
