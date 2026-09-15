import { countTiles, tileRank, tileSuit } from "./tiles.js";
import type { DeclaredMeld, Suit, Tile } from "./types.js";

function meldKey(counts: readonly number[], meldsNeeded: number): string {
  return `${meldsNeeded}:${counts.join("")}`;
}

function canFormMelds(counts: number[], meldsNeeded: number, memo: Map<string, boolean>): boolean {
  if (meldsNeeded === 0) {
    return counts.every((count) => count === 0);
  }
  const key = meldKey(counts, meldsNeeded);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const tile = counts.findIndex((count) => count > 0);
  if (tile < 0) return false;

  if (counts[tile]! >= 3) {
    counts[tile]! -= 3;
    if (canFormMelds(counts, meldsNeeded - 1, memo)) {
      counts[tile]! += 3;
      memo.set(key, true);
      return true;
    }
    counts[tile]! += 3;
  }

  const rank = tileRank(tile);
  if (rank <= 7 && counts[tile + 1]! > 0 && counts[tile + 2]! > 0) {
    counts[tile]!--;
    counts[tile + 1]!--;
    counts[tile + 2]!--;
    if (canFormMelds(counts, meldsNeeded - 1, memo)) {
      counts[tile]!++;
      counts[tile + 1]!++;
      counts[tile + 2]!++;
      memo.set(key, true);
      return true;
    }
    counts[tile]!++;
    counts[tile + 1]!++;
    counts[tile + 2]!++;
  }

  memo.set(key, false);
  return false;
}

export function isStandardWin(concealedTiles: readonly Tile[], declaredMeldCount = 0): boolean {
  const meldsNeeded = 4 - declaredMeldCount;
  if (meldsNeeded < 0 || concealedTiles.length !== meldsNeeded * 3 + 2) return false;
  const counts = countTiles(concealedTiles);

  for (let pair = 0; pair < counts.length; pair += 1) {
    if (counts[pair]! < 2) continue;
    counts[pair]! -= 2;
    if (canFormMelds(counts, meldsNeeded, new Map())) {
      counts[pair]! += 2;
      return true;
    }
    counts[pair]! += 2;
  }
  return false;
}

export function isSevenPairs(concealedTiles: readonly Tile[], declaredMeldCount = 0): boolean {
  if (declaredMeldCount !== 0 || concealedTiles.length !== 14) return false;
  return countTiles(concealedTiles).every((count) => count % 2 === 0);
}

export function isAllPungs(concealedTiles: readonly Tile[], declaredMelds: readonly DeclaredMeld[]): boolean {
  const counts = countTiles(concealedTiles);
  const meldsNeeded = 4 - declaredMelds.length;
  if (concealedTiles.length !== meldsNeeded * 3 + 2) return false;

  for (let pair = 0; pair < counts.length; pair += 1) {
    if (counts[pair]! < 2) continue;
    counts[pair]! -= 2;
    const valid = counts.every((count) => count % 3 === 0);
    counts[pair]! += 2;
    if (valid) return true;
  }
  return false;
}

export function containsMissingSuit(tiles: readonly Tile[], melds: readonly DeclaredMeld[], suit: Suit): boolean {
  return tiles.some((tile) => tileSuit(tile) === suit) || melds.some((meld) => tileSuit(meld.tile) === suit);
}

export function allPhysicalTiles(tiles: readonly Tile[], melds: readonly DeclaredMeld[]): Tile[] {
  return [
    ...tiles,
    ...melds.flatMap((meld) => Array<Tile>(meld.kind === "kong" ? 4 : 3).fill(meld.tile)),
  ];
}

export function countRoots(tiles: readonly Tile[], melds: readonly DeclaredMeld[]): number {
  return countTiles(allPhysicalTiles(tiles, melds)).filter((count) => count === 4).length;
}

