import type { RoundResult, ScoreDelta, SettlementEvent } from "@mianyang-mahjong/rules";

export interface MatchPlayerSummary {
  userId: string;
  seat: number | null;
  /** Points won or lost before the opening-balance cap; set once the match was settled. */
  rawDelta: number;
  /** Points actually applied to the account; set once the match was settled. */
  accountDelta: number;
}

export interface MatchSummary {
  roomId: string;
  ruleVersion: string;
  status: "finished" | "dissolved";
  completedRounds: number;
  finalReason: "completed" | "dissolved";
  createdAt: Date;
  /** Null only for rooms finished before the column existed; new finalizations always set it. */
  finalizedAt: Date | null;
  players: MatchPlayerSummary[];
}

export interface MatchRoundRecord {
  roundId: string;
  roundNumber: number;
  finishReason: RoundResult["reason"];
  winnerSeats: number[];
  nextDealerSeat: number;
  deltas: ScoreDelta[];
  /** Server-side settlement events, stored with the round because they cannot be recomputed. */
  events: SettlementEvent[];
  finishedAt: Date;
}

/**
 * Opaque cursor returned by {@link MatchHistoryReader.listMatchesFor}. Its encoding is an
 * implementation detail; callers must only pass a cursor they got back from the same method.
 */
export type MatchCursor = string;

/** One page of a match list. `nextCursor` is undefined when there are no older matches. */
export interface MatchPage {
  matches: MatchSummary[];
  nextCursor: MatchCursor | undefined;
}

/**
 * Reads finished matches back out of durable storage.
 *
 * History is a persistence feature: a match only has a record if the server had a database when it
 * was played. Implementations must only return matches that actually played at least one round, so
 * a room dissolved before the first deal never shows up as a result.
 */
export interface MatchHistoryReader {
  /**
   * Matches this player took part in, most recently finished first, in pages.
   *
   * Pass `undefined` as the cursor for the first page; the returned `nextCursor` (when present)
   * fetches the following, older page. Matches are keyed by their room id, so a match is never
   * returned twice and none is skipped, regardless of how `finalized_at` ties are ordered.
   */
  listMatchesFor(userId: string, limit: number, cursor?: MatchCursor): Promise<MatchPage>;

  /** One match with all of its players, or undefined when the room has no recorded result. */
  findMatch(roomId: string): Promise<MatchSummary | undefined>;

  /** Every round of a match in round order. Empty when the match has no recorded result. */
  listRounds(roomId: string): Promise<MatchRoundRecord[]>;
}
