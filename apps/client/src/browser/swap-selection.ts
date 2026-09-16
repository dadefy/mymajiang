import type { MatchState, Tile } from "../protocol.js";
import { suitOf } from "./tile-label.js";

/** 下标对应排好序的手牌，每张同值牌仍是独立的选择。 */
export class SwapSelection {
  private indexes: number[] = [];
  private key = "";
  private pending = false;
  private allowed = false;
  private notice: string | undefined;
  get length(): number { return this.indexes.length; }
  get enabled(): boolean { return this.allowed && !this.pending; }
  has(index: number): boolean { return this.indexes.includes(index); }
  clear(): void { this.indexes = []; this.pending = false; }
  sync(match: MatchState, actions: readonly string[], notice?: string): void {
    const key = `${match.roomId}:${match.roundNumber}:${match.phase}:${[...match.hand].sort((a,b) => a-b).join(",")}`;
    if (key !== this.key) { this.clear(); this.key = key; }
    this.allowed = match.phase === "swapping" && actions.includes("swap");
    if (!this.allowed) this.clear();
    if (notice && notice !== this.notice) this.pending = false;
    this.notice = notice;
  }
  toggle(index: number): void {
    if (!this.enabled) return;
    this.indexes = this.has(index) ? this.indexes.filter((each) => each !== index) : [...this.indexes, index].slice(-3);
  }
  tiles(hand: readonly Tile[]): Tile[] { return this.indexes.map((index) => hand[index]!); }
  valid(hand: readonly Tile[]): boolean {
    const tiles = this.tiles(hand);
    return this.enabled && tiles.length === 3 && tiles.every((tile) => tile !== undefined && suitOf(tile) === suitOf(tiles[0]!));
  }
  submit(send: () => void): void {
    if (!this.enabled) return;
    this.pending = true;
    this.indexes = [];
    send();
  }
}
