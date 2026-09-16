import type { Suit, Tile } from "../protocol.js";

/**
 * 牌面文字。
 *
 * 牌的编号是 0..26：0-8 万、9-17 筒、18-26 条（与 `packages/rules` 的编码一致）。
 * 单人版与四家同屏版都要用，所以收在一处 —— 两处各写一份的话，
 * 牌面显示一旦有一边改了，另一个页面会静默地继续显示旧编号。
 */

export const SUIT_LABEL: Record<Suit, string> = { wan: "万", tong: "筒", tiao: "条" };

export const SUITS = ["wan", "tong", "tiao"] as const;

export function suitOf(tile: Tile): Suit {
  return SUITS[Math.floor(tile / 9)] ?? "wan";
}

export function tileLabel(tile: Tile): string {
  return `${(tile % 9) + 1}${SUIT_LABEL[suitOf(tile)]}`;
}
