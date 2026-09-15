import type { RoundResult, ScoreDelta, SettlementEvent } from "@mianyang-mahjong/rules";
import type { PostgresDatabase } from "./database.js";
import type {
  MatchCursor,
  MatchHistoryReader,
  MatchPage,
  MatchPlayerSummary,
  MatchRoundRecord,
  MatchSummary,
} from "./match-history.js";

interface MatchRow {
  room_id: string;
  rule_version: string;
  status: MatchSummary["status"];
  completed_rounds: number;
  final_reason: MatchSummary["finalReason"] | null;
  created_at: Date;
  finalized_at: Date | null;
}

interface MatchPlayerRow {
  room_id: string;
  user_id: string;
  seat: number | null;
  raw_delta: string | null;
  account_delta: string | null;
}

interface RoundRow {
  round_id: string;
  round_number: number;
  finish_reason: RoundResult["reason"];
  winner_seats: unknown;
  next_dealer_seat: number;
  deltas: unknown;
  events: unknown;
  finished_at: Date;
}

const MATCH_COLUMNS = `r.room_id, r.rule_version, r.status, r.completed_rounds,
    r.final_reason, r.created_at, r.finalized_at`;

/**
 * `completed_rounds > 0` keeps a room that dissolved before the first deal out of the record: it
 * never was a match. Every room that reaches one of these statuses with rounds played has been
 * settled, so its per-player deltas are present.
 */
const RECORDED_MATCH_FILTER = `r.status IN ('finished', 'dissolved') AND r.completed_rounds > 0`;

/** Matches are ordered by `finalized_at DESC NULLS LAST, created_at DESC`; the cursor holds both. */
interface MatchCursorData {
  /** ISO string, or null for a match whose finalized_at has not been backfilled. */
  finalizedAt: string | null;
  roomId: string;
}

const CURSOR_MARKER = "m1:";

function encodeCursor(cursor: MatchCursorData): MatchCursor {
  return CURSOR_MARKER + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: MatchCursor): MatchCursorData {
  if (!value.startsWith(CURSOR_MARKER)) throw new Error("INVALID_CURSOR");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(CURSOR_MARKER.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    !("roomId" in parsed) || typeof (parsed as { roomId?: unknown }).roomId !== "string" ||
    !("finalizedAt" in parsed) ||
    (typeof (parsed as { finalizedAt?: unknown }).finalizedAt !== "string" && (parsed as { finalizedAt?: unknown }).finalizedAt !== null)
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return parsed as MatchCursorData;
}

/** Reads finished matches, their players and their rounds back out of PostgreSQL. */
export class PostgresMatchHistory implements MatchHistoryReader {
  constructor(private readonly database: PostgresDatabase) {}

  async listMatchesFor(userId: string, limit: number, cursor?: MatchCursor): Promise<MatchPage> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    // Fetch one extra row so we can tell whether another page follows.
    const params: unknown[] = [userId];
    const conditions = [
      `mine.user_id = $${params.length}`,
    ];
    if (after) {
      // Keyset pagination over (finalized_at, room_id). A match with NULL finalized_at sorts last,
      // so it is only reachable once every timestamped match has been consumed.
      const f = params.length + 1;
      const r = params.length + 2;
      conditions.push(
        `((r.finalized_at IS NOT NULL AND (r.finalized_at, r.room_id) < ($${f}::timestamptz, $${r}::uuid)) ` +
        ` OR (r.finalized_at IS NULL AND $${f}::timestamptz IS NULL))`,
      );
      params.push(after.finalizedAt === null ? null : new Date(after.finalizedAt), after.roomId);
    }
    params.push(limit + 1);
    const rows = await this.database.pool.query<MatchRow>(
      `SELECT ${MATCH_COLUMNS}
         FROM match_rooms r
         JOIN match_room_players mine ON mine.room_id = r.room_id
        WHERE ${RECORDED_MATCH_FILTER} AND ${conditions.join(" AND ")}
        ORDER BY r.finalized_at DESC NULLS LAST, r.created_at DESC, r.room_id ASC
        LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    const summaries = await this.withPlayers(page);
    const last = page[page.length - 1];
    return {
      matches: summaries,
      nextCursor: hasMore && last
        ? encodeCursor({ finalizedAt: last.finalized_at?.toISOString() ?? null, roomId: last.room_id })
        : undefined,
    };
  }

  async findMatch(roomId: string): Promise<MatchSummary | undefined> {
    const matches = await this.database.pool.query<MatchRow>(
      `SELECT ${MATCH_COLUMNS} FROM match_rooms r
        WHERE r.room_id = $1 AND ${RECORDED_MATCH_FILTER}`,
      [roomId],
    );
    const summaries = await this.withPlayers(matches.rows);
    return summaries[0];
  }

  async listRounds(roomId: string): Promise<MatchRoundRecord[]> {
    const rounds = await this.database.pool.query<RoundRow>(
      `SELECT round_id, round_number, finish_reason, winner_seats, next_dealer_seat,
              deltas, events, finished_at
         FROM match_rounds WHERE room_id = $1 ORDER BY round_number ASC`,
      [roomId],
    );
    return rounds.rows.map(roundFromRow);
  }

  /** Loads the players of every room in one round trip, then groups them back onto their match. */
  private async withPlayers(rooms: readonly MatchRow[]): Promise<MatchSummary[]> {
    if (rooms.length === 0) return [];
    const players = await this.database.pool.query<MatchPlayerRow>(
      `SELECT room_id, user_id, seat, raw_delta, account_delta
         FROM match_room_players
        WHERE room_id = ANY($1::uuid[])
        ORDER BY seat ASC NULLS LAST, user_id ASC`,
      [rooms.map((room) => room.room_id)],
    );
    return rooms.map((room) =>
      matchFromRow(
        room,
        players.rows.filter((player) => player.room_id === room.room_id),
      ),
    );
  }
}

function matchFromRow(row: MatchRow, players: readonly MatchPlayerRow[]): MatchSummary {
  const roomId = row.room_id;
  return {
    roomId,
    ruleVersion: row.rule_version,
    status: row.status,
    completedRounds: row.completed_rounds,
    // Older rows can predate the column; the status already says how the match ended.
    finalReason: row.final_reason ?? (row.status === "finished" ? "completed" : "dissolved"),
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
    players: players.map((player) => playerSummary(player, roomId)),
  };
}

function playerSummary(row: MatchPlayerRow, roomId: string): MatchPlayerSummary {
  return {
    userId: row.user_id.trim(),
    seat: row.seat,
    rawDelta: settledInteger(row.raw_delta, roomId, "raw_delta"),
    accountDelta: settledInteger(row.account_delta, roomId, "account_delta"),
  };
}

function roundFromRow(row: RoundRow): MatchRoundRecord {
  return {
    roundId: row.round_id,
    roundNumber: row.round_number,
    finishReason: row.finish_reason,
    winnerSeats: asArray<number>(row.winner_seats, row.round_id, "winner_seats"),
    nextDealerSeat: row.next_dealer_seat,
    deltas: asArray<ScoreDelta>(row.deltas, row.round_id, "deltas"),
    events: asArray<SettlementEvent>(row.events, row.round_id, "events"),
    finishedAt: row.finished_at,
  };
}

/** A recorded match has been settled, so a missing delta means the row is corrupt, not empty. */
function settledInteger(value: string | null, roomId: string, column: string): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Match ${roomId} has no usable ${column}`);
  }
  return parsed;
}

function asArray<T>(value: unknown, roundId: string, column: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`match_rounds.${column} for ${roundId} is not a JSON array`);
  }
  return value as T[];
}
