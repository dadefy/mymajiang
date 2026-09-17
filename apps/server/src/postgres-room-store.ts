import { randomUUID } from "node:crypto";
import {
  MatchRoom,
  type AccountStore,
  type RecordedRound,
  type RoomResult,
  type SeatControl,
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
  /** `VARCHAR(16)`：只有 'human' / 'trustee' 两个合法值（表上有 CHECK）。 */
  control: string;
  away: boolean;
  control_changed_at: Date | null;
  /**
   * 人工控制权保护期的**绝对截止时刻**（墙钟，migration 011）。
   *
   * NULL = 没有保护期（在线 / 已托管 / 已结算 / 还在等待期）。
   * 有值时，判据只有一条：`now > reconnect_deadline` ⇒ 保护期已过 ⇒ 转托管。
   * 服务重启后它照样在库里，所以停机期间也在流逝 —— 这是"重启不重送 120 秒"的依据。
   */
  reconnect_deadline: Date | null;
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
    room_id, user_id, seat, joined_at, ready, opening_balance, raw_delta, account_delta,
    control, away, control_changed_at, reconnect_deadline
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT (room_id, user_id) DO UPDATE SET
    seat = EXCLUDED.seat, ready = EXCLUDED.ready,
    opening_balance = EXCLUDED.opening_balance, raw_delta = EXCLUDED.raw_delta,
    account_delta = EXCLUDED.account_delta,
    control = EXCLUDED.control, away = EXCLUDED.away,
    control_changed_at = EXCLUDED.control_changed_at,
    reconnect_deadline = EXCLUDED.reconnect_deadline`;

const DELETE_ROOM_PLAYER_SQL = `DELETE FROM match_room_players WHERE room_id = $1 AND user_id = $2`;

/**
 * 每小局结算后把**大局累计**写回玩家行。
 *
 * 只更新 `raw_delta` 一列 —— 这是刻意用窄 UPDATE 而不是复用 `UPSERT_ROOM_PLAYER_SQL`：
 * 那条 upsert 会一次性覆盖 12 列，其中包含 `account_delta`（整场结算才该写）、
 * `opening_balance`、`seat`、`control`、`away`、`reconnect_deadline`。
 * 拿它来"顺手更新累计"会把尚未到结算时刻的 `account_delta` 写成 NULL，
 * 也会改写控制权字段 —— 范围太大，污染语义不同的字段。
 *
 * ⚠️ 写的是**绝对值**，不是 `raw_delta = raw_delta + delta`：
 * 域层 `recordCompletedRound()` 已经累加过一次，持久化层再做一次增量累加会双倍计分。
 */
const UPDATE_ROOM_PLAYER_RAW_DELTA_SQL = `UPDATE match_room_players
  SET raw_delta = $3
  WHERE room_id = $1 AND user_id = $2`;

// A finished round is immutable, so a repeated write must not overwrite it.
const INSERT_ROUND_SQL = `INSERT INTO match_rounds (
    round_id, room_id, round_number, finish_reason, winner_seats, next_dealer_seat,
    deltas, events, finished_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT DO NOTHING`;

/**
 * 各房间"已结算小场的积分之和"（只读，用于对账）。
 *
 * `match_room_players.raw_delta` 是**大局累计**，`match_rounds.deltas` 是**每小局**的分数；
 * 对一个还在进行中的房间，前者应当等于后者的按人求和。
 * 两者不一致 ⇒ 累计在某一环丢了（历史上就是因为只在内存累加、从不落库）。
 *
 * 这条查询只用来**告警**，不用来修复 —— 自动改写历史数据比丢分更危险。
 */
const ROUND_DELTA_TOTALS_SQL = `SELECT m.room_id,
       (d.value ->> 'playerId') AS player_id,
       SUM((d.value ->> 'delta')::bigint) AS total
  FROM match_rounds m, jsonb_array_elements(m.deltas) AS d(value)
 GROUP BY 1, 2`;

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

  /**
   * 控制权 / 暂离的每一次变更都要**立刻**落库，不等任何节流。
   *
   * 这几个字段是"服务器该不该替这个座位出牌"的唯一依据 —— 少写一次，
   * 进程重启后就会回到 `human`，而那个座位恰恰是没人在的，整局会卡在等人工操作上。
   * 落库走共享写队列，所以这里不需要 await，调用方也不会被磁盘拖慢。
   *
   * 四个方法都只在**确实发生变化**时写，避免重复点击把无意义的写排进队列。
   */
  override quitToTrustee(userId: string): boolean {
    const changed = super.quitToTrustee(userId);
    if (changed) this.flushPlayer(userId);
    return changed;
  }

  override resumeControl(userId: string): boolean {
    const changed = super.resumeControl(userId);
    if (changed) this.flushPlayer(userId);
    return changed;
  }

  override expireReconnectWindow(userId: string): boolean {
    const changed = super.expireReconnectWindow(userId);
    if (changed) this.flushPlayer(userId);
    return changed;
  }

  /** 暂离状态也要落库：重启后「他还在大厅」这件事必须还在，否则界面会显示成掉线。 */
  override markAway(userId: string, away: boolean): boolean {
    const changed = super.markAway(userId, away);
    if (changed) this.flushPlayer(userId);
    return changed;
  }

  /** `reconnect()` 在窗口已过时会就地转托管，那次转换同样要落库。 */
  override reconnect(userId: string): boolean {
    const changed = super.reconnect(userId);
    if (changed) this.flushPlayer(userId);
    return changed;
  }

  /**
   * 断线要落库 —— 落的就是那个**绝对截止时刻**。
   *
   * 没有这一步，"墙钟"就只是一句口号：deadline 只活在内存里，服务一重启就没了，
   * 重启后要么重新计时（白送 120 秒），要么没人管（这一座永久卡住）。
   */
  override disconnect(userId: string, reconnectWindowMs?: number): void {
    super.disconnect(userId, reconnectWindowMs);
    this.flushPlayer(userId);
  }

  /**
   * 整房按墙钟结算（服务重启后靠它补上"定时器没排上"的那些座位）。
   *
   * 域层幂等：只返回这次真正被转换的人，所以多个入口同时发现过期也只有一份写。
   */
  override expireOverdueControl(): string[] {
    const changed = super.expireOverdueControl();
    for (const userId of changed) this.flushPlayer(userId);
    return changed;
  }

  private flushPlayer(userId: string): void {
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
    // `super` 先把这一局的 delta 累加进 `rawDeltas`（内存），下面写的是累加**之后**的绝对值。
    const result = super.recordCompletedRound(round);
    const statements: SqlStatement[] = [
      { sql: INSERT_ROUND_SQL, parameters: roundParameters(this, roundNumber, round, this.clock()) },
      // ⚠️ 大局累计必须和这一小局的记录**在同一个事务里**提交：要么都成功，要么都回滚。
      // 少了这几条，`match_room_players.raw_delta` 会一直停在开局时的 0，
      // 服务重启后 `load()` 从那个 0 恢复 ⇒ 此前所有小场的账永久丢失。
      // （真实故障：房间 999832 前 6 局的 -57 / +50 / -14 / +21 全丢，最终只结算了第 8 局的 ±1。）
      ...this.rawDeltaStatements(),
    ];
    // `finalize` already recorded the finished room, including the round counter.
    if (!result) {
      statements.push({ sql: UPSERT_ROOM_SQL, parameters: roomParameters(this, null) });
    }
    this.queue.enqueueTransaction(statements);
    return result;
  }

  /**
   * 四位玩家的**当前累计**（绝对值，不是增量）。
   *
   * 与 `INSERT_ROUND_SQL` 同事务：不允许出现"记了这一局但累计没跟上"的半成功状态。
   */
  private rawDeltaStatements(): SqlStatement[] {
    return [...this.players.values()].map((player) => ({
      sql: UPDATE_ROOM_PLAYER_RAW_DELTA_SQL,
      parameters: [this.roomId, player.account.userId, this.rawDeltas.get(player.account.userId) ?? 0],
    }));
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
    // 防御性校验：打了若干小场之后，四位玩家的大局累计**全为 0** 是极不正常的信号
    // —— 真实故障 999832 就是这样：前 6 局的 -57/+50/-14/+21 在重启时丢失，
    //   最终账户只结算了第 8 局的 ±1，而零和校验根本抓不到（归零之后和仍然是 0）。
    //
    // 这里**只告警、不拦截**：同步阶段拿不到 `match_rounds` 做真正的对账，
    // 仅凭"全 0"就拒绝入账会把可能合法的结算也卡死（八局荒庄理论上存在）。
    // 真正的逐人对账在 `load()` 里做（那时能查库，且房间还没结算）。
    if (this.completedRounds > 1 && result.rawDeltas.every((entry) => entry.delta === 0)) {
      process.stderr.write(
        `[room-store] 可疑的整场结算：room=${this.roomNo} 已完成 ${this.completedRounds} 小场，`
        + " 但四位玩家的大局累计全为 0 —— 累计积分很可能在持久化环节丢失，"
        + " 即将写入的账户结算可能不完整（只告警，不拦截）\n",
      );
    }
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

    const [roomRows, playerRows, totalsRows] = await Promise.all([
      database.pool.query<RoomRow>(
        `SELECT room_id, room_no, status, owner_id, completed_rounds FROM match_rooms
          WHERE status IN ('waiting', 'playing') ORDER BY created_at ASC, room_id ASC`,
      ),
      database.pool.query<RoomPlayerRow>(
        `SELECT p.room_id, p.user_id, p.seat, p.joined_at, p.ready, p.opening_balance, p.raw_delta,
                p.control, p.away, p.control_changed_at, p.reconnect_deadline
           FROM match_room_players p
           JOIN match_rooms r ON r.room_id = p.room_id
          WHERE r.status IN ('waiting', 'playing') ORDER BY p.joined_at ASC, p.user_id ASC`,
      ),
      // 只读对账用；查不到（例如存储层 mock）时下面会跳过校验，不影响启动。
      database.pool.query<{ room_id: string; player_id: string; total: string | number }>(
        ROUND_DELTA_TOTALS_SQL,
      ),
    ]);

    // "roomId|userId" -> 已结算小场的积分之和
    const settledTotals = new Map<string, number>();
    for (const row of totalsRows.rows ?? []) {
      settledTotals.set(`${row.room_id}|${String(row.player_id).trim()}`, Number(row.total));
    }

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
          // ⚠️ 控制权与暂离**必须从数据库恢复**，不能默认成 human。
          // 一个"玩家已经退出、服务器正在代打"的座位如果被恢复成 human，
          // 而它又没人连接，整局就会卡在等人工操作上 —— 这正是这两个字段存在的理由。
          control: storedControl(player.control, roomId, userId),
          away: player.away,
          ...(player.control_changed_at === null ? {} : { controlChangedAt: player.control_changed_at }),
          // ⚠️ 保护期**照原样恢复，不重算**。这是墙钟语义的关键：
          // 断线发生在 20:00、deadline 是 20:02、服务 20:10 才起来 ——
          // 恢复出来的仍然是 20:02，于是下一次判定时直接认定"已过期"，
          // 而不是因为"刚刚重启过"再送一个 120 秒。
          ...(player.reconnect_deadline === null ? {} : { reconnectDeadline: player.reconnect_deadline }),
        });
      }

      if (row.status === "playing") {
        room.status = "playing";
        for (const player of seated) {
          const userId = player.user_id.trim();
          room.openingBalances.set(userId, storedInteger(player.opening_balance, roomId, "opening_balance"));
          const rawDelta = storedInteger(player.raw_delta, roomId, "raw_delta");
          room.rawDeltas.set(userId, rawDelta);
          // 只读一致性校验：大局累计应当等于已结算各小场之和。
          // 不一致 ⇒ 累计在某一环丢了（历史上正是"只在内存累加、从不落库"）。
          // **只告警，不自动修复** —— 擅自改写历史数据比丢分更危险。
          const settled = settledTotals.get(`${roomId}|${userId}`);
          if (settled !== undefined && settled !== rawDelta) {
            process.stderr.write(
              `[room-store] 大局累计与已结算小场不一致：room=${row.room_no} user=${userId}`
              + ` raw_delta=${rawDelta} 已结算之和=${settled}（只告警，不自动改写）\n`,
            );
          }
        }
      }

      room.recordRestoredState();
      rooms.set(roomId, room);
    }
    return store;
  }

  /** Factory for creating a room that records itself from the very first write. */
  createRoom(roomId: string, roomNo: string, owner: UserAccount, clock?: () => Date): MatchRoom {
    return PostgresMatchRoom.create(this.queue, this.createLedgerId, roomId, roomNo, owner, clock);
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
    player.control,
    player.away,
    player.controlChangedAt ?? null,
    // 保护期的绝对截止时刻。NULL 表示"没有保护期"——写库时**不**按当前时间重算，
    // 否则服务重启后一次 flush 就会把旧的 deadline 顶成一个新的 120 秒，
    // 恰好是这一列要防的那件事。
    player.reconnectDeadline ?? null,
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

/**
 * 控制权是个闭集，读到别的东西说明这一行被手工改过或迁移出错 —— 宁可启动失败也不要静默猜。
 *
 * 只有显式写进来的值才可信；不去"兼容"未知字符串，否则一个笔误可能让托管座位被当成人工，
 * 变成没人操作却一直等下去的死局。
 */
function storedControl(value: string, roomId: string, userId: string): SeatControl {
  if (value === "human" || value === "trustee") return value;
  throw new Error(`Room ${roomId} player ${userId} has an unknown control value: ${value}`);
}
