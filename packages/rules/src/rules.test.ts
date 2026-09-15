import { describe, expect, it } from "vitest";
import {
  MIANYANG_XZ_1_0,
  calculateFan,
  capLossesByOpeningBalance,
  isSevenPairs,
  isStandardWin,
  parseTiles,
  settleWin,
} from "./index.js";

describe("MIANYANG_XZ_1_0", () => {
  it("locks the confirmed room configuration", () => {
    expect(MIANYANG_XZ_1_0).toMatchObject({
      playerCount: 4,
      rounds: 8,
      maxFan: 4,
      minimumEntryPoints: 500,
      allowNegativeAccountPoints: false,
      timelyRain: false,
    });
  });
});

describe("winning hand validation", () => {
  it("recognizes a standard hand", () => {
    expect(isStandardWin(parseTiles("123456789m123p11p"))).toBe(true);
  });

  it("recognizes seven pairs including a four-of-a-kind as two pairs", () => {
    const tiles = parseTiles("11112233445566m");
    expect(isSevenPairs(tiles)).toBe(true);
  });
});

describe("fan calculation", () => {
  it("rejects a hand that still contains the missing suit", () => {
    const result = calculateFan({
      concealedTiles: parseTiles("123456789m123p11p"),
      declaredMelds: [],
      missingSuit: "tong",
      method: "discard",
    });
    expect(result.valid).toBe(false);
  });

  it("adds closed-hand and self-draw fan", () => {
    const result = calculateFan({
      concealedTiles: parseTiles("123456789m123p11p"),
      declaredMelds: [],
      missingSuit: "tiao",
      method: "self-draw",
    });
    expect(result.valid).toBe(true);
    expect(result.items.map((item) => item.code)).toEqual(expect.arrayContaining(["CLOSED", "SELF_DRAW"]));
    expect(result.finalFan).toBe(2);
    expect(result.paymentPerOpponent).toBe(4);
  });

  it("scores a closed clean all-pungs hand at the four-fan cap", () => {
    const result = calculateFan({
      concealedTiles: parseTiles("11122233344455m"),
      declaredMelds: [],
      missingSuit: "tong",
      method: "discard",
    });
    expect(result.items.map((item) => item.code)).toEqual(expect.arrayContaining(["ALL_PUNGS", "CLEAN_SUIT"]));
    expect(result.finalFan).toBe(4);
  });

  it("caps clean dragon seven pairs at four fan", () => {
    const result = calculateFan({
      concealedTiles: parseTiles("11112233445566m"),
      declaredMelds: [],
      missingSuit: "tong",
      method: "discard",
    });
    expect(result.valid).toBe(true);
    expect(result.rawFan).toBeGreaterThan(4);
    expect(result.finalFan).toBe(4);
    expect(result.paymentPerOpponent).toBe(16);
  });
});

describe("settlement", () => {
  it("creates a zero-sum self-draw settlement", () => {
    expect(settleWin("A", ["B", "C", "D"], 16)).toEqual([
      { playerId: "A", delta: 48 },
      { playerId: "B", delta: -16 },
      { playerId: "C", delta: -16 },
      { playerId: "D", delta: -16 },
    ]);
  });

  it("caps losses at opening balances and distributes actual losses proportionally", () => {
    const result = capLossesByOpeningBalance(
      [
        { playerId: "A", delta: -700 },
        { playerId: "B", delta: 500 },
        { playerId: "C", delta: 200 },
      ],
      { A: 600, B: 500, C: 500 },
    );
    expect(result).toEqual([
      { playerId: "A", delta: -600 },
      { playerId: "B", delta: 429 },
      { playerId: "C", delta: 171 },
    ]);
  });
});
