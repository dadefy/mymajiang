import type { MatchState, Tile } from "../protocol.js";
import { suitOf } from "./tile-label.js";

/** 同一张实体牌点两次才出牌；相同牌面的不同下标不互相确认。 */
export class DiscardSelection {
  index: number | null = null;
  private key = "";
  private pending = false;
  private enabled = false;
  private notice: string | undefined;
  sync(match: MatchState, actions: readonly string[], notice?: string): void {
    const key = `${match.roomId}:${match.roundNumber}:${match.phase}:${match.currentPlayerSeat}:${[...match.hand].sort((a,b) => a-b).join(",")}`;
    this.enabled = match.phase === "playing" && match.currentPlayerSeat === match.seat && !match.won && actions.includes("discard");
    if (key !== this.key || !this.enabled) { this.index = null; this.pending = false; }
    if (notice && notice !== this.notice) this.pending = false;
    this.key = key; this.notice = notice;
  }
  canSelect(match: MatchState, tile: Tile): boolean {
    return this.enabled && !this.pending && (!match.missingSuit || !match.hand.some(each => suitOf(each) === match.missingSuit) || suitOf(tile) === match.missingSuit);
  }
  click(match: MatchState, index: number): Tile | undefined {
    const hand = [...match.hand].sort((a,b) => a-b);
    const tile = hand[index];
    if (tile === undefined || !this.canSelect(match, tile)) return;
    if (this.index !== index) { this.index = index; return; }
    this.index = null; this.pending = true;
    return tile;
  }
}
