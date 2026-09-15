import type { GameState } from "@mianyang-mahjong/rules";

export interface StoredRoundState {
  roundNumber: number;
  state: GameState;
}

/**
 * Snapshot of the round currently being played, so a restarted process can carry on instead of
 * throwing the round away.
 *
 * The state contains the wall and every player's hand: it is server-secret and must never be sent
 * to a client. `MahjongGame.snapshot()` is the client-safe view.
 *
 * Saving happens after every state change, which is a few dozen writes per round; that is cheap
 * because all repositories share one ordered write queue. Batching or throttling it is a possible
 * later optimisation, not a correctness requirement.
 */
export interface GameStateStore {
  /** Overwrites the snapshot of the round in flight. */
  save(roomId: string, roundNumber: number, state: GameState): void;

  /** Reads the round in flight, or undefined when the room has no saved round. */
  load(roomId: string): Promise<StoredRoundState | undefined>;

  /** Drops the snapshot once the round is no longer in flight. */
  clear(roomId: string): void;
}
