import { describe, expect, it, vi } from "vitest";
import { SwapSelection } from "../src/browser/swap-selection.js";
import type { MatchState } from "../src/protocol.js";
const hand = [0, 0, 2, 9];
const match = { roomId: "r", roundNumber: 1, phase: "swapping", hand } as MatchState;
describe("swap selection", () => {
  it("selects identical faces independently and submits all three physical copies", () => {
    const selection = new SwapSelection(); selection.sync(match, ["swap"]);
    selection.toggle(0); expect(selection.has(1)).toBe(false);
    selection.toggle(1); selection.toggle(2);
    expect(selection.length).toBe(3); expect(selection.tiles(hand)).toEqual([0,0,2]);
    expect(selection.valid(hand)).toBe(true);
    selection.toggle(0); expect(selection.has(1)).toBe(true); expect(selection.length).toBe(2);
  });
  it("blocks duplicate submission and clears choices after timeout or round change", () => {
    const selection = new SwapSelection(); selection.sync(match, ["swap"]);
    const send = vi.fn(); selection.submit(send); selection.submit(send);
    expect(send).toHaveBeenCalledTimes(1); expect(selection.enabled).toBe(false);
    selection.sync(match, []); selection.toggle(0); expect(selection.length).toBe(0);
    selection.sync({...match, roundNumber:2}, ["swap"]);
    expect(selection.enabled).toBe(true); expect(selection.length).toBe(0);
  });
  it("rejects mixed suits and allows retry after a server error", () => {
    const selection = new SwapSelection(); selection.sync(match, ["swap"]);
    for (const index of [0,1,3]) selection.toggle(index);
    expect(selection.valid(hand)).toBe(false);
    selection.submit(() => {}); selection.sync(match, ["swap"], "failed");
    expect(selection.enabled).toBe(true);
  });
});
