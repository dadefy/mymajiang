import type { Suit, Tile } from "./types.js";

const SUITS: readonly Suit[] = ["wan", "tong", "tiao"];

export function createTile(suit: Suit, rank: number): Tile {
  if (!Number.isInteger(rank) || rank < 1 || rank > 9) {
    throw new RangeError(`Invalid tile rank: ${rank}`);
  }
  return SUITS.indexOf(suit) * 9 + rank - 1;
}

export function tileSuit(tile: Tile): Suit {
  assertTile(tile);
  return SUITS[Math.floor(tile / 9)]!;
}

export function tileRank(tile: Tile): number {
  assertTile(tile);
  return (tile % 9) + 1;
}

export function assertTile(tile: Tile): void {
  if (!Number.isInteger(tile) || tile < 0 || tile >= 27) {
    throw new RangeError(`Invalid tile: ${tile}`);
  }
}

export function countTiles(tiles: readonly Tile[]): number[] {
  const counts = Array<number>(27).fill(0);
  for (const tile of tiles) {
    assertTile(tile);
    counts[tile] = (counts[tile] ?? 0) + 1;
    if (counts[tile]! > 4) {
      throw new RangeError(`More than four copies of tile ${tile}`);
    }
  }
  return counts;
}

export function parseTiles(notation: string): Tile[] {
  const tiles: Tile[] = [];
  let digits = "";
  const suitMap: Record<string, Suit> = { m: "wan", p: "tong", s: "tiao" };

  for (const character of notation.replace(/\s/g, "")) {
    if (/^[1-9]$/.test(character)) {
      digits += character;
      continue;
    }
    const suit = suitMap[character];
    if (!suit || digits.length === 0) {
      throw new Error(`Invalid tile notation: ${notation}`);
    }
    for (const digit of digits) {
      tiles.push(createTile(suit, Number(digit)));
    }
    digits = "";
  }

  if (digits.length > 0) {
    throw new Error(`Missing suit in tile notation: ${notation}`);
  }
  countTiles(tiles);
  return tiles;
}

