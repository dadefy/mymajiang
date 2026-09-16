import { randomUUID } from "node:crypto";
import {
  MatchRoom,
  type AccountStore,
  type RecordedRound,
  type RoomResult,
  type UserAccount,
} from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import {
  INSERT_POINT_LEDGER_SQL,
  UPSERT_ACCOUNT_SQL,
  accountParameters,
  ledgerParameters,
} from "./postgres-statements.js";
import { PostgresWriteQueue, type SqlStatement } from "./postgres-write-queue.js";

interface RoomRow {
  room_id: string;
  /** 6 位数字房间号，`CHAR(6)` 读回来可能带补空格，用前一律 trim。 */
  room_no: string;
  status: MatchRoom["status"];
  owner_id: string;
  completed_rounds: number;
}

interface RoomPlayerRow {
  room_id: string;
  user_id: string;
  seat: number | null;
  joined_at: Date;
  ready: boolean;
  opening_balance: string | null;
  raw_delta: string | null;
}

/**
 * `room_no` 只在插入时写：房间号是不可变的，而且它是「还在用的房间」的唯一键
 * （部分唯一索引 `match_rooms_active_room_no`），冲突分支里再写一次没有意义。
 */
const UPSERT_ROOM_SQL = `INSERT INTO match_rooms (
    room_id, room_no, rule_version, status, owner_id, completed_rounds,
    created_at, finalized_at, final_reason
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (room_id) DO UPDATE SET
    status = EXCLUDED.status, owner_id = EXCLUDED.owner_id,
    completed_rounds = EXCLUDED.completed_rounds,
    finalized_at = EXCLUDED.finalized_at, final_reason = EXCLUDED.final_reason`;

const UPSERT_ROOM_PLAYER_SQL = `INSERT INTO match_room_players (
    room_id, user_id, seat, joined_at, ready, opening_balance, raw_delta, account_delta
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (room_id, user_id) DO UPDATE SET
    seat = EXCLUDED.seat, ready = EXCLUDED.ready,
    opening_balance = EXCLUDED.opening_balance, raw_delta = EXCLUDED.raw_delta,
    account_delta = EXCLUDED.account_delta`;

const DELETE_ROOM_PLAYER_SQL = `DELETE FROM match_room_players WHERE room_id = $1 AND user_id = $2`;

// A finished round is immutable, so a repeated write must not overwrite it.
const INSERT_ROUND_SQL = `INSERT INTO match_rounds (
    round_id, room_id, round_number, finish_reason, winner_seats, next_dealer_seat,
    deltas, events, finished_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT DO NOTHING`;

const DISSOLVE_UNUSABLE_SQL = `UPDATE match_rooms
  SET status = 'dissolved', finalized_at = NOW(), final_reason = 'dissolved'
  WHERE room_id = $1 AND status IN ('waiting', 'playing')`;

/** A settlement is caused by the match itself, not by an administrator. */
const SETTLEMENT_ACTOR = "match";

export interface RoomStoreOptions {
  queue?: PostgresWriteQueue;
  createLedgerId?: () => string;
}

/**
 * A match room that records itself.
 *
 * The domain still owns every rule; each override runs `super` first and then queues the matching
 * write. The settlement is the one that matters: the four account balances and the four
 * `match_settlement` ledger rows go out in a single transaction, so points can never move without a
 * traceable ledger row, nor the other way round.
 */
export class PostgresMatchRoom extends MatchRoom {
  private constructor(
    private readonly queue: PostgresWriteQueue,
    private readonly createLedgerId: () => string,
    roomId: string,
    roomNo: string,
    owner: UserAccount,
    mode: "create" | "restore" = "create",
    private readonly clock: () => Date = () => new Date(),
  ) {
    super(roomId, roomNo, owner, clock, mode);
  }

  /** Creates a room and records its room row plus the owner's membership row. */
  static create(
    queue: PostgresWriteQueue,
    createLedgerId: () => string,
    roomId: string,
    roomNo: string,
    owner: UserAccount,
    clock?: () => Date,
  ): PostgresMatchRoom {
    const room = new PostgresMatchRoom(queue, createLedgerId, roomId, roomNo, owner, "create", clock);
    room.queue.enqueueTransaction([
      { sql: UPSERT_ROOM_SQL, parameters: roomParameters(room, null) },
      { sql: UPSERT_ROOM_PLAYER_SQL, parameters: roomPlayerParameters(room, owner.userId, null) },
    ]);
    return room;
  }

  /** Rebuilds a room read from storage. Nothing is written until the room is used again. */
  static revive(
    queue: PostgresWriteQueue,
    createLedgerId: () => string,
    row: RoomRow,
    owner: UserAccount,
  ): PostgresMatchRoom {
    const room = new PostgresMatchRoom(
      queue,
      createLedgerId,
      row.room_id,
      // CHAR(6) 读回来可能带补空格，交给域层前先去掉。
      row.room_no.trim(),
      owner,
      "restore",
    );
    room.ownerId = row.owner_id.trim();
    room.completedRounds = row.completed_rounds;
    return room;
  }

  override join(account: UserAccount): void {
    super.join(account);
    this.queue.enqueue(UPSERT_ROOM_PLAYER_SQL, roomPlayerParameters(this, account.userId, null));
  }

  override leave(userId: string): void {
    super.leave(userId);
    this.queue.enqueueTransaction([
      { sql: DELETE_ROOM_PLAYER_SQL, parameters: [this.roomId, userId] },
      // Leaving can hand ownership over, or dissolve the room when the last player walks out.
      { sql: UPSERT_ROOM_SQL, parameters: roomParameters(this, this.status === "dissolved" ? this.clock() : null) },
    ]);
  }

  override setReady(userId: string, ready: boolean): void {
    super.setReady(userId, ready);
    this.queue.enqueue(UPSERT_ROOM_PLAYER_SQL, roomPlayerParameters(this, userId, null));
  }

  override start(requesterId: string): void {
    super.start(requesterId);
    this.queue.enqueueTransaction([
      { sql: UPSERT_ROOM_SQL, parameters: roomParameters(this, null) },
      ...[...this.players.values()].map((player) => ({
        sql: UPSERT_ROOM_PLAYER_SQL,
        parameters: roomPlayerParameters(this, player.account.userId, null),
      })),
    ]);
  }

  override recordCompletedRound(round: RecordedRound): RoomResult | undefined {
    const roundNumber = this.completedRounds + 1;
    const result = super.recordCompletedRound(round);
    const statements: SqlStatement[] = [
      { sql: INSERT_ROUND_SQL, parameters: roundParameters(this, roundNumber, round, this.clock()) },
    ];
    // `finalize` already recorded the finished room, including the round counter.
    if (!result) {
      statements.push({ sql: UPSERT_ROOM_SQL, parameters: roomParameters(this, null) });
    }
    this.queue.enqueueTransaction(statements);
    return result;
  }

  override requestDissolve(userId: string): boolean {
    const dissolvingWaitingRoom = this.status === "waiting";
    const dissolved = super.requestDissolve(userId);
    // A waiting room dissolves outright; a playing room only starts a vote, which changes nothing.
    if (dissolvingWaitingRoom) {
      this.queue.enqueue(UPSERT_ROOM_SQL, roomParameters(this, this.clock()));
    }
    return dissolved;
  }

  /**
   * Records the state a revived room was rebuilt into, e.g. after clearing stale ready flags.
   */
  recordRestoredState(): void {
    this.queue.enqueueTransaction([
      { sql: UPSERT_ROOM_SQL, parameters: roomParameters(this, null) },
      ...[...this.players.values()].map((player) => ({
        sql: UPSERT_ROOM_PLAYER_SQL,
        parameters: roomPlayerParameters(this, player.account.userId, null),
      })),
    ]);
  }

  protected override finalize(reason: "completed" | "dissolved"): RoomResult {
    const result = super.finalize(reason);
    const finalizedAt = this.clock();
    this.queue.enqueueTransaction([
      { sql: UPSERT_ROOM_SQL, parameters: roomParameters(this, finalizedAt) },
      ...this.settlementStatements(result, finalizedAt),
    ]);
    return result;
  }

  private settlementStatements(result: RoomResult, finalizedAt: Date): SqlStatement[] {
    const statements: SqlStatement[] = [];
    for (const player of this.players.values()) {
      const accountDelta = result.accountDeltas.find((entry) => entry.playerId === player.account.userId)?.delta ?? 0;
      statements.push({ sql: UPSERT_ACCOUNT_SQL, parameters: accountParameters(player.account) });
      statements.push({
        sql: UPSERT_ROOM_PLAYER_SQL,
        parameters: roomPlayerParameters(this, player.account.userId, accountDelta),
      });
      if (accountDelta === 0) continue;
      statements.push({
        sql: INSERT_POINT_LEDGER_SQL,
        parameters: ledgerParameters({
          ledgerId: this.createLedgerId(),
          userId: player.account.userId,
          type: "match_settlement",
          delta: accountDelta,
          // `super.finalize` already applied the delta, so the balance before it is a subtraction.
          balanceBefore: player.account.points - accountDelta,
          balanceAfter: player.account.points,
          reason: settlementReason(this.completedRounds, result.reason),
          actorId: SETTLEMENT_ACTOR,
          roomId: this.roomId,
          createdAt: finalizedAt,
        }),
      });
    }
    return statements;
  }
}

/**
 * Rooms backed by PostgreSQL.
 *
 * `createRoom` is the factory that `POST /v1/rooms` calls; `rooms` holds whatever could be
 * restored from storage at startup.
 */
export class PostgresRoomStore {
  readonly rooms: Map<string, MatchRoom>;
  private readonly queue: PostgresWriteQueue;
  private readonly createLedgerId: () => string;

  private constructor(queue: PostgresWriteQueue, createLedgerId: () => string, rooms: Map<string, MatchRoom>) {
    this.queue = queue;
    this.createLedgerId = createLedgerId;
    this.rooms = rooms;
  }

  /**
   * Reads rooms that are still usable and rebuilds them in memory.
   *
   * A room that was `waiting` comes back with every ready flag cleared: nobody is connected after a
   * restart, and the owner must not be able to start a match with absent players.
   *
   * A room that was `playing` comes back as `playing` with its seats, opening balances and
   * accumulated deltas intact. The rules engine is not part of the room, so whether the current
   * round can be resumed is decided by the realtime layer from `match_round_states`; the room itself
   * only has to be truthful about the match so far.
   *
   * Rooms that finished earlier stay in the database as history and are not loaded. Rooms with no
   * players left, or whose owner account is gone, are closed instead of failing the whole start.
   */
  static async load(
    database: PostgresDatabase,
    accounts: AccountStore,
    options: RoomStoreOptions = {},
  ): Promise<PostgresRoomStore> {
    const queue = options.queue ?? new PostgresWriteQueue(database);
    const createLedgerId = options.createLedgerId ?? randomUUID;
    const rooms = new Map<string, MatchRoom>();

    const [roomRows, playerRows] = await Promise.all([
      database.pool.query<RoomRow>(
        `SELECT room_id, room_no, status, owner_id, completed_rounds FROM match_rooms
          WHERE status IN ('waiting', 'playing') ORDER BY created_at ASC, room_id ASC`,
      ),
      database.pool.query<RoomPlayerRow>(
        `SELECT p.room_id, p.user_id, p.seat, p.joined_at, p.ready, p.opening_balance, p.raw_delta
           FROM match_room_players p
           JOIN match_rooms r ON r.room_id = p.room_id
          WHERE r.status IN ('waiting', 'playing') ORDER BY p.joined_at ASC, p.user_id ASC`,
      ),
    ]);

    const store = new PostgresRoomStore(queue, createLedgerId, rooms);

    for (const row of roomRows.rows) {
      const roomId = row.room_id;
      const seated = playerRows.rows.filter((player) => player.room_id === roomId);
      const owner = accounts.findAccountById(row.owner_id.trim());
      if (!owner || seated.length === 0) {
        // Nothing left to continue with; close it so it stops showing up as usable.
        queue.enqueue(DISSOLVE_UNUSABLE_SQL, [roomId]);
        continue;
      }
      const room = PostgresMatchRoom.revive(queue, createLedgerId, row, owner);
      for (const player of seated) {
        const userId = player.user_id.trim();
        const account = accounts.findAccountById(userId);
        if (!account) throw new Error(`Room ${roomId} references unknown user ${userId}`);
        room.players.set(userId, {
          account,
          joinedAt: player.joined_at,
          // Nobody is connected after a restart, so no seat is ready either.
          ready: false,
          connected: false,
          ...(player.seat === null ? {} : { seat: player.seat }),
        });
      }

      if (row.status === "playing") {
        room.status = "playing";
        for (const player of seated) {
          const userId = player.user_id.trim();
          room.openingBalances.set(userId, storedInteger(player.opening_balance, roomId, "opening_balance"));
          room.rawDeltas.set(userId, storedInteger(player.raw_delta, roomId, "raw_delta"));
        }
      }

      room.recordRestoredState();
      rooms.set(roomId, room);
    }
    return store;
  }

  /** Factory for creating a room that records itself from the very first write. */
  createRoom(roomId: string, roomNo: string, owner: UserAccount): MatchRoom {
    return PostgresMatchRoom.create(this.queue, this.createLedgerId, roomId, roomNo, owner);
  }

  /**
   * Waits for every queued write. All repositories share one queue, so flushing any of them drains
   * the others too.
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }
}

function settlementReason(completedRounds: number, reason: RoomResult["reason"]): string {
  return reason === "completed" ? `打满 ${completedRounds} 局结算` : `${completedRounds} 局后解散结算`;
}

/**
 * `created_at` is only ever read on insert: every conflicting write updates the other columns and
 * leaves it alone, so a revived room's reconstructed in-memory value never reaches the database.
 */
function roomParameters(room: MatchRoom, finalizedAt: Date | null): readonly unknown[] {
  return [
    room.roomId,
    room.roomNo,
    room.ruleVersion,
    room.status,
    room.ownerId,
    room.completedRounds,
    room.createdAt,
    finalizedAt,
    finalizedAt ? (room.result?.reason ?? "dissolved") : null,
  ];
}

function roomPlayerParameters(room: MatchRoom, userId: string, accountDelta: number | null): readonly unknown[] {
  const player = room.players.get(userId);
  if (!player) throw new Error(`Player ${userId} is missing from room ${room.roomId}`);
  return [
    room.roomId,
    userId,
    player.seat ?? null,
    player.joinedAt,
    player.ready,
    room.openingBalances.get(userId) ?? null,
    room.rawDeltas.get(userId) ?? null,
    accountDelta,
  ];
}

function roundParameters(
  room: MatchRoom,
  roundNumber: number,
  round: RecordedRound,
  finishedAt: Date,
): readonly unknown[] {
  return [
    randomUUID(),
    room.roomId,
    roundNumber,
    round.reason,
    JSON.stringify(round.winnerSeats),
    round.nextDealerSeat,
    JSON.stringify(round.deltas),
    JSON.stringify(round.events ?? []),
    finishedAt,
  ];
}

/** A settlement must never silently treat a missing balance as zero: that would mangle the cap. */
function storedInteger(value: string | null, roomId: string, column: string): number {
  const parsed = value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Room ${roomId} has no usable ${column}`);
  }
  return parsed;
}
