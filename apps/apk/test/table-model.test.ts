import { describe, expect, it } from "vitest";
import {
  actionAvailable,
  discardableIndexes,
  selectedTiles,
  sortedHand,
  swapSelectionIsValid,
  tileAsset,
  tileSuit,
} from "../src/ui/table-model.js";

describe("table model", () => {
  it("maps tiles to suits and LayaAir asset paths", () => {
    expect(tileSuit(0)).toBe("wan");
    expect(tileSuit(17)).toBe("tong");
    expect(tileSuit(26)).toBe("tiao");
    expect(tileAsset(18)).toBe("resources/tiles/tiao_1.png");
    expect(() => tileSuit(27)).toThrow("Invalid tile");
  });

  it("sorts a hand without mutating the socket snapshot", () => {
    const hand = [20, 2, 11];
    expect(sortedHand(hand)).toEqual([2, 11, 20]);
    expect(hand).toEqual([20, 2, 11]);
  });

  it("accepts exactly three swap tiles from one suit", () => {
    const hand = [0, 1, 2, 9, 10];
    expect(swapSelectionIsValid(hand, new Set([0, 1, 2]))).toBe(true);
    expect(swapSelectionIsValid(hand, new Set([0, 1]))).toBe(false);
    expect(swapSelectionIsValid(hand, new Set([0, 1, 3]))).toBe(false);
    expect(selectedTiles(hand, new Set([3, 1, 0]))).toEqual([0, 1, 9]);
  });

  it("forces missing-suit discards until that suit is empty", () => {
    expect([...discardableIndexes([0, 9, 1], "wan")]).toEqual([0, 2]);
    expect([...discardableIndexes([9, 10], "wan")]).toEqual([0, 1]);
    expect([...discardableIndexes([9, 10], null)]).toEqual([0, 1]);
  });

  it("uses the server action list as the authority", () => {
    expect(actionAvailable(["discard", "hu"], "hu")).toBe(true);
    expect(actionAvailable(["discard"], "peng")).toBe(false);
  });
});
