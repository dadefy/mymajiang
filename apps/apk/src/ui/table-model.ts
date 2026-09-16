import type { Suit, Tile } from "@mianyang-mahjong/client";

export type TableAction =
  | "swap"
  | "choose-missing"
  | "discard"
  | "hu"
  | "peng"
  | "kong"
  | "pass"
  | "kong-concealed"
  | "kong-added";

export function tileSuit(tile: Tile): Suit {
  if (tile < 0 || tile > 26 || !Number.isInteger(tile)) throw new Error(`Invalid tile: ${tile}`);
  if (tile < 9) return "wan";
  if (tile < 18) return "tong";
  return "tiao";
}

export function tileAsset(tile: Tile): string {
  const suit = tileSuit(tile);
  return `resources/tiles/${suit}_${(tile % 9) + 1}.png`;
}

export function sortedHand(hand: readonly Tile[]): Tile[] {
  return [...hand].sort((left, right) => left - right);
}

export function swapSelectionIsValid(hand: readonly Tile[], selectedIndexes: ReadonlySet<number>): boolean {
  if (selectedIndexes.size !== 3) return false;
  const selected = [...selectedIndexes].map((index) => hand[index]).filter((tile): tile is Tile => tile !== undefined);
  return selected.length === 3 && selected.every((tile) => tileSuit(tile) === tileSuit(selected[0]!));
}

export function selectedTiles(hand: readonly Tile[], selectedIndexes: ReadonlySet<number>): Tile[] {
  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => hand[index])
    .filter((tile): tile is Tile => tile !== undefined);
}

export function discardableIndexes(hand: readonly Tile[], missingSuit: Suit | null): Set<number> {
  if (!missingSuit) return new Set(hand.map((_, index) => index));
  const missingIndexes: number[] = [];
  hand.forEach((tile, index) => {
    if (tileSuit(tile) === missingSuit) missingIndexes.push(index);
  });
  return new Set((missingIndexes.length > 0 ? missingIndexes : hand.map((_, index) => index)));
}

export function actionAvailable(actions: readonly string[], action: TableAction): boolean {
  return actions.indexOf(action) >= 0;
}
