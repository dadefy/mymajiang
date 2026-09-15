import type { GameState } from "@mianyang-mahjong/rules";
import type { PostgresDatabase } from "./database.js";
import type { GameStateStore, StoredRoundState } from "./game-state-store.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface RoundStateRow {
  round_number: number;
  state: unknown;
}

const UPSERT_STATE_SQL = `INSERT INTO match_round_states (room_id, round_number, state, saved_at)
  VALUES ($1,$2,$3,NOW())
  ON CONFLICT (room_id) DO UPDATE SET
    round_number = EXCLUDED.round_number, state = EXCLUDED.state, saved_at = NOW()`;

const DELETE_STATE_SQL = `DELETE FROM match_round_states WHERE room_id = $1`;

/**
 * Stores the round in flight as one JSONB document per room.
 *
 * `save` and `clear` go through the shared write queue so they keep their order relative to the
 * room, round and ledger writes. `load` is a plain read: the caller validates the snapshot with
 * `MahjongGame.restore`, which is the only place that can decide whether it is usable.
 */
export class PostgresGameStateStore implements GameStateStore {
  private constructor(
    private readonly database: PostgresDatabase,
    private readonly queue: PostgresWriteQueue,
  ) {}

  static create(
    database: PostgresDatabase,
    queue: PostgresWriteQueue = new PostgresWriteQueue(database),
  ): PostgresGameStateStore {
    return new PostgresGameStateStore(database, queue);
  }

  save(roomId: string, roundNumber: number, state: GameState): void {
    this.queue.enqueue(UPSERT_STATE_SQL, [roomId, roundNumber, JSON.stringify(state)]);
  }

  async load(roomId: string): Promise<StoredRoundState | undefined> {
    const rows = await this.database.pool.query<RoundStateRow>(
      "SELECT round_number, state FROM match_round_states WHERE room_id = $1",
      [roomId],
    );
    const row = rows.rows[0];
    if (!row) return undefined;
    return { roundNumber: row.round_number, state: parseState(row.state) };
  }

  clear(roomId: string): void {
    this.queue.enqueue(DELETE_STATE_SQL, [roomId]);
  }

  /**
   * Waits for every queued write. All repositories share one queue, so flushing any of them drains
   * the others too.
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }
}

/** `pg` parses JSONB into a value already, but a raw text column would still arrive as a string. */
function parseState(value: unknown): GameState {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored round state is not an object");
  }
  return parsed as GameState;
}
