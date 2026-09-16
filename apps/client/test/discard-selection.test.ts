import { describe, expect, it } from "vitest";
import type { MatchState } from "../src/protocol.js";
import { DiscardSelection } from "../src/browser/discard-selection.js";
const match = { roomId:"r", roundNumber:1, phase:"playing", currentPlayerSeat:0, seat:0, won:false, missingSuit:null, hand:[0,0,2,9] } as MatchState;
describe("two-click discard", () => {
  it("raises the first click, changes selection on another card, and confirms the same physical copy", () => {
    const choice = new DiscardSelection(); choice.sync(match,["discard"]);
    expect(choice.click(match,0)).toBeUndefined(); expect(choice.index).toBe(0);
    expect(choice.click(match,1)).toBeUndefined(); expect(choice.index).toBe(1);
    expect(choice.click(match,1)).toBe(0); expect(choice.index).toBeNull();
    expect(choice.click(match,1)).toBeUndefined();
  });
  it("cannot select or discard while waiting or responding to another discard", () => {
    const choice = new DiscardSelection(); choice.sync(match,[]);
    expect(choice.click(match,0)).toBeUndefined(); expect(choice.index).toBeNull();
    choice.sync({...match,phase:"claiming"},["hu","pass"]);
    expect(choice.click(match,0)).toBeUndefined(); expect(choice.index).toBeNull();
  });
  it("enforces missing-suit selection and clears stale choices when the hand changes", () => {
    const choice = new DiscardSelection(); const missing = {...match, missingSuit:"wan" as const}; choice.sync(missing,["discard"]);
    expect(choice.click(missing,3)).toBeUndefined(); expect(choice.index).toBeNull();
    choice.click(missing,0);
    const next={...match,hand:[0,2,9]}; choice.sync(next,["discard"]);
    expect(choice.index).toBeNull(); expect(choice.click(next,0)).toBeUndefined();
  });
  it("resets at turn and round boundaries", () => {
    const choice = new DiscardSelection(); choice.sync(match,["discard"]); choice.click(match,0);
    choice.sync({...match,currentPlayerSeat:1},[]);expect(choice.index).toBeNull();
    choice.sync({...match,roundNumber:2},["discard"]);expect(choice.click(match,0)).toBeUndefined();
  });
});
