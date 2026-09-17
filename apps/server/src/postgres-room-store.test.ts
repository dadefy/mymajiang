import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountStore, presenceOf, type RecordedRound, type UserAccount } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresRoomStore } from "./postgres-room-store.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface RecordedQuery {
  channel: "pool" | "tx";
  sql: string;
  parameters: unknown[];
}

function fakeDatabase(options: { rooms?: unknown[]; players?: unknown[]; roundTotals?: unknown[]; failOn?: string } = {}) {
  const timeline: RecordedQuery[] = [];

  const client = {
    async query(sql: string, parameters: unknown[] = []) {
      timeline.push({ channel: "tx", sql, parameters });
      if (options.failOn && sql.includes(options.failOn)) throw new Error("database offline");
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };

  const pool = {
    async query(sql: string, parameters: unknown[] = []) {
      timeline.push({ channel: "pool", sql, parameters });
      if (sql.includes("FROM match_rooms")) return { rows: options.rooms ?? [], rowCount: 1 };
      if (sql.includes("FROM match_room_players")) return { rows: options.players ?? [], rowCount: 1 };
      if (sql.includes("jsonb_array_elements")) return { rows: options.roundTotals ?? [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    async connect() {
      return client;
    },
  };

  return { database: { pool } as unknown as PostgresDatabase, timeline };
}

/** Labels a statement so assertions read as a write list; SELECTs collapse to "other". */
function label(sql: string): string {
  const trimmed = sql.trim().replace(/\s+/g, " ");
  if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") return trimmed;
  const match = /^(INSERT INTO|DELETE FROM|UPDATE) (\w+)/.exec(trimmed);
  if (!match) return "other";
  const verb = match[1] === "INSERT INTO" ? "insert" : match[1] === "DELETE FROM" ? "delete" : "update";
  return `${verb}:${match[2]}`;
}

function writes(timeline: RecordedQuery[], since = 0): string[] {
  return timeline
    .slice(since)
    .map((entry) => label(entry.sql))
    .filter((name) => name !== "other");
}

function statements(timeline: RecordedQuery[], name: string, since = 0): unknown[][] {
  return timeline
    .slice(since)
    .filter((entry) => label(entry.sql) === name)
    .map((entry) => entry.parameters);
}

function indexesOf(timeline: RecordedQuery[], name: string): number[] {
  return timeline.reduce<number[]>(
    (found, entry, index) => (label(entry.sql) === name ? [...found, index] : found),
    [],
  );
}

/** The statements from the BEGIN that opened the transaction containing `name` to its terminator. */
function enclosingTransaction(timeline: RecordedQuery[], name: string): string[] {
  const targets = indexesOf(timeline, name);
  const first = targets[0];
  const last = targets.at(-1);
  if (first === undefined || last === undefined) return [];
  let start = -1;
  for (let index = first; index >= 0; index -= 1) {
    if (label(timeline[index]!.sql) === "BEGIN") {
      start = index;
      break;
    }
  }
  let end = -1;
  for (let index = last; index < timeline.length; index += 1) {
    const name = label(timeline[index]!.sql);
    if (name === "COMMIT" || name === "ROLLBACK") {
      end = index;
      break;
    }
  }
  return timeline.slice(start, end + 1).map((entry) => label(entry.sql));
}

function account(userId: string, points: number, activeMatchId?: string): UserAccount {
  return {
    userId,
    nickname: userId,
    avatarUrl: "avatar",
    status: "active",
    points,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    ...(activeMatchId ? { activeMatchId } : {}),
  };
}

function accountStore(users: readonly UserAccount[]): InMemoryAccountStore {
  const store = new InMemoryAccountStore();
  for (const user of users) store.saveAccount(user);
  return store;
}

/** A round where A loses `loss` and B wins it; C and D sit out. */
function round(loss: number): RecordedRound {
  return {
    reason: "three-winners",
    deltas: [
      { playerId: "A", delta: -loss },
      { playerId: "B", delta: loss },
    ],
    wins: [],
    winnerSeats: [1],
    nextDealerSeat: 1,
    events: [{ eventId: "event-1", type: "win", payer: "A", payee: "B", points: loss, note: "点炮" }],
  };
}

const FOUR_PLAYERS = ["A", "B", "C", "D"] as const;

function fourUsers(): UserAccount[] {
  return [account("A", 600), account("B", 500), account("C", 500), account("D", 500)];
}

let ledgerSequence = 0;

async function loadedStore(users: readonly UserAccount[], options: { rooms?: unknown[]; players?: unknown[]; failOn?: string } = {}) {
  const { database, timeline } = fakeDatabase(options);
  const store = await PostgresRoomStore.load(database, accountStore(users), {
    queue: new PostgresWriteQueue(database),
    createLedgerId: () => `ledger-${(ledgerSequence += 1)}`,
  });
  return { store, timeline, mark: () => timeline.length };
}

/** A room with four seated, ready players and the match already started. */
async function startedRoom(
  users: readonly UserAccount[],
  options: { failOn?: string; clock?: () => Date } = {},
) {
  const loaded = await loadedStore(users, options);
  const room = loaded.store.createRoom("room-1", "123456", users[0]!, options.clock);
  for (const user of users.slice(1)) room.join(user);
  for (const user of users) room.setReady(user.userId, true);
  room.start("A");
  await loaded.store.flush();
  return { ...loaded, room };
}

describe("PostgresMatchRoom", () => {
  it("writes the room and the owner's membership in one transaction", async () => {
    const { store, timeline, mark } = await loadedStore([account("A", 600)]);
    const since = mark();

    store.createRoom("room-1", "123456", account("A", 600));
    await store.flush();

    expect(writes(timeline, since)).toEqual(["BEGIN", "insert:match_rooms", "insert:match_room_players", "COMMIT"]);
    expect(statements(timeline, "insert:match_rooms", since)[0]).toEqual([
      "room-1",
      "123456",
      "MIANYANG_XZ_1_0",
      "waiting",
      "A",
      0,
      expect.any(Date),
      null,
      null,
    ]);
    expect(statements(timeline, "insert:match_room_players", since)[0]).toEqual([
      "room-1",
      "A",
      null,
      expect.any(Date),
      false,
      null,
      null,
      null,
      // 座位控制权与暂离（migration 010）：新座位一律 human / 未暂离。
      "human",
      false,
      // 主动退出标记（migration 012）：新座位一律 false。
      false,
      null,
      // 保护期截止时刻（migration 011）：正常在座的人没有保护期。
      null,
    ]);
  });

  it("records seats and opening balances when the match starts", async () => {
    const users = fourUsers();
    const { store, timeline, mark } = await loadedStore(users);
    const room = store.createRoom("room-1", "123456", users[0]!);
    for (const user of users.slice(1)) room.join(user);
    for (const user of users) room.setReady(user.userId, true);
    // Queued writes only run on `flush`, so the mark must be taken after they have landed.
    await store.flush();
    const since = mark();

    room.start("A");
    await store.flush();

    expect(writes(timeline, since)).toEqual([
      "BEGIN",
      "insert:match_rooms",
      ...FOUR_PLAYERS.map(() => "insert:match_room_players"),
      "COMMIT",
    ]);
    expect(statements(timeline, "insert:match_room_players", since).map((p) => p.slice(0, 6))).toEqual([
      ["room-1", "A", 0, expect.any(Date), true, 600],
      ["room-1", "B", 1, expect.any(Date), true, 500],
      ["room-1", "C", 2, expect.any(Date), true, 500],
      ["room-1", "D", 3, expect.any(Date), true, 500],
    ]);
    expect(statements(timeline, "insert:match_rooms", since)[0]![3]).toBe("playing");
  });

  it("records every round once, with its settlement events", async () => {
    const { store, room, timeline, mark } = await startedRoom(fourUsers());
    const since = mark();

    room.recordCompletedRound(round(100));
    room.recordCompletedRound(round(100));
    await store.flush();

    // 小局记录 + 房间局数 + **四位玩家的累计**，全部在同一个事务里。
    // 累计那条不能少：少了它，服务重启后 rawDeltas 会从恒为 0 的旧值恢复，之前的账就丢了。
    expect(writes(timeline, since)).toEqual([
      "BEGIN",
      "insert:match_rounds",
      "update:match_room_players",
      "update:match_room_players",
      "update:match_room_players",
      "update:match_room_players",
      "insert:match_rooms",
      "COMMIT",
      "BEGIN",
      "insert:match_rounds",
      "update:match_room_players",
      "update:match_room_players",
      "update:match_room_players",
      "update:match_room_players",
      "insert:match_rooms",
      "COMMIT",
    ]);
    const rounds = statements(timeline, "insert:match_rounds", since);
    expect(rounds[0]!.slice(1, 6)).toEqual(["room-1", 1, "three-winners", "[1]", 1]);
    expect(rounds[1]![2]).toBe(2);
    expect(rounds[0]![6]).toBe('[{"playerId":"A","delta":-100},{"playerId":"B","delta":100}]');
    expect(rounds[0]![7]).toContain('"type":"win"');
    expect(statements(timeline, "insert:match_rooms", since)[1]![5]).toBe(2);
  });

  it("settles the match, writing each balance with its ledger row in one transaction", async () => {
    const users = fourUsers();
    const { store, room, timeline, mark } = await startedRoom(users);
    const since = mark();

    for (let index = 0; index < 8; index += 1) room.recordCompletedRound(round(100));
    await store.flush();

    // A's loss is capped at the opening balance, and B's win is scaled to keep the round zero-sum.
    const ledgerRows = statements(timeline, "insert:point_ledger", since);
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows[0]!.slice(1, 11)).toEqual([
      "A",
      "match_settlement",
      -600,
      600,
      0,
      "打满 8 局结算",
      "match",
      "room-1",
      null,
      expect.any(Date),
    ]);
    expect(ledgerRows[1]!.slice(1, 6)).toEqual(["B", "match_settlement", 600, 500, 1100]);

    // Every account row and every ledger row commits together with the room row.
    expect(enclosingTransaction(timeline, "insert:point_ledger")).toEqual([
      "BEGIN",
      "insert:match_rooms",
      "insert:users",
      "insert:match_room_players",
      "insert:point_ledger",
      "insert:users",
      "insert:match_room_players",
      "insert:point_ledger",
      "insert:users",
      "insert:match_room_players",
      "insert:users",
      "insert:match_room_players",
      "COMMIT",
    ]);
    expect(statements(timeline, "insert:match_rooms", since).at(-1)!.slice(3, 9)).toEqual([
      "finished",
      "A",
      8,
      expect.any(Date),
      expect.any(Date),
      "completed",
    ]);
    expect(users.map((user) => user.points)).toEqual([0, 1100, 500, 500]);
    expect(users.every((user) => user.activeMatchId === undefined)).toBe(true);
  });

  it("rolls the whole settlement back when a ledger row cannot be written", async () => {
    const users = fourUsers();
    const { store, room, timeline } = await startedRoom(users, { failOn: "INSERT INTO point_ledger" });

    for (let index = 0; index < 8; index += 1) room.recordCompletedRound(round(100));
    await expect(store.flush()).rejects.toThrow("database offline");

    // Not one balance survives the failed settlement.
    expect(enclosingTransaction(timeline, "insert:point_ledger").at(-1)).toBe("ROLLBACK");
  });

  it("dissolves a waiting room without touching balances", async () => {
    const users = [account("A", 600), account("B", 500)];
    const { store, timeline, mark } = await loadedStore(users);
    const room = store.createRoom("room-1", "123456", users[0]!);
    room.join(users[1]!);
    await store.flush();
    const since = mark();

    expect(room.requestDissolve("A")).toBe(true);
    await store.flush();

    expect(writes(timeline, since)).toEqual(["insert:match_rooms"]);
    expect(statements(timeline, "insert:match_rooms", since)[0]!.slice(3, 9)).toEqual([
      "dissolved",
      "A",
      0,
      expect.any(Date),
      expect.any(Date),
      "dissolved",
    ]);
    expect(statements(timeline, "insert:point_ledger", since)).toHaveLength(0);
  });
});

describe("PostgresRoomStore.load", () => {
  it("restores a waiting room with every ready flag cleared", async () => {
    const users = [account("A", 600), account("B", 500)];
    const { store, timeline } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "123456", status: "waiting", owner_id: "A", completed_rounds: 0 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: null, joined_at: new Date(0), ready: true, opening_balance: null, raw_delta: null, control: "human", away: false, control_changed_at: null },
        { room_id: "room-1", user_id: "B", seat: null, joined_at: new Date(1), ready: true, opening_balance: null, raw_delta: null, control: "human", away: false, control_changed_at: null },
      ],
    });

    const room = store.rooms.get("room-1")!;
    expect(room.status).toBe("waiting");
    // CHAR(6) 读回来可能带补空格，房间号必须仍然是那 6 位数字。
    expect(room.roomNo).toBe("123456");
    expect([...room.players.keys()]).toEqual(["A", "B"]);
    expect([...room.players.values()].map((player) => player.ready)).toEqual([false, false]);
    expect([...room.players.values()].map((player) => player.connected)).toEqual([false, false]);

    // Nobody is connected after a restart, so the cleared flags are written back.
    await store.flush();
    expect(statements(timeline, "insert:match_room_players").map((p) => p[4])).toEqual([false, false]);
  });

  it("brings a room that was mid-match back as playing, keeping its seats and deltas", async () => {
    const users = [account("A", 600, "room-1"), account("B", 500, "room-1")];
    const { store, timeline } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 3 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "-300", control: "human", away: false, control_changed_at: null },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: true, opening_balance: "500", raw_delta: "300", control: "human", away: false, control_changed_at: null },
      ],
    });

    const room = store.rooms.get("room-1")!;
    expect(room.status).toBe("playing");
    expect(room.roomNo).toBe("654321");
    expect(room.completedRounds).toBe(3);
    expect([...room.players.values()].map((player) => player.seat)).toEqual([0, 1]);
    expect([...room.openingBalances.entries()]).toEqual([["A", 600], ["B", 500]]);
    expect([...room.rawDeltas.entries()]).toEqual([["A", -300], ["B", 300]]);

    await store.flush();
    // 对局还没结束：不许结算，也不许把玩家从 activeMatchId 上摘下来。
    expect(statements(timeline, "insert:point_ledger")).toHaveLength(0);
    expect(users.map((user) => user.activeMatchId)).toEqual(["room-1", "room-1"]);
    expect(statements(timeline, "insert:match_rooms")[0]!.slice(3, 5)).toEqual(["playing", "A"]);
  });

  it("closes a room that has nobody left in it", async () => {
    const users = [account("A", 600)];
    const { store, timeline } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "123456", status: "waiting", owner_id: "A", completed_rounds: 0 }],
      players: [],
    });

    expect(store.rooms.size).toBe(0);
    await store.flush();
    expect(writes(timeline)).toEqual(["update:match_rooms"]);
  });

  it("fails loudly when stored rows reference a user that does not exist", async () => {
    const { database } = fakeDatabase({
      rooms: [{ room_id: "room-1", room_no: "123456", status: "waiting", owner_id: "A", completed_rounds: 0 }],
      players: [
        { room_id: "room-1", user_id: "GHOST", seat: null, joined_at: new Date(0), ready: false, opening_balance: null, raw_delta: null, control: "human", away: false, control_changed_at: null },
      ],
    });

    await expect(PostgresRoomStore.load(database, accountStore([account("A", 600)]))).rejects.toThrow("unknown user");
  });
});

describe("座位控制权与暂离的持久化", () => {
  /** 参数顺序与 `UPSERT_ROOM_PLAYER_SQL` 一一对应。 */
  const CONTROL = 8;
  const AWAY = 9;
  /** 「当前仍处于主动退出状态」（migration 012）。 */
  const RENOUNCED = 10;
  const CONTROL_CHANGED_AT = 11;
  /** 保护期的**绝对**截止时刻（migration 011）。NULL = 没有保护期。 */
  const RECONNECT_DEADLINE = 12;

  it("主动退出立刻把 control=trustee 与 renounced=true 写进数据库", async () => {
    const users = fourUsers();
    const { room, mark, timeline, store } = await startedRoom(users);
    const since = mark();

    expect(room.quitToTrustee("B")).toBe(true);
    await store.flush();

    expect(writes(timeline, since)).toEqual(["insert:match_room_players"]);
    const [row] = statements(timeline, "insert:match_room_players", since);
    expect(row![CONTROL]).toBe("trustee");
    expect(row![AWAY]).toBe(false);
    // renounced=true 是「全员放弃提前终局」的判据，重启后必须照原样恢复
    expect(row![RENOUNCED]).toBe(true);
    expect(row![CONTROL_CHANGED_AT]).toBeInstanceOf(Date);
  });

  it("重复点退出只写一次，不往队列里塞无意义的写", async () => {
    const users = fourUsers();
    const { room, mark, timeline, store } = await startedRoom(users);
    room.quitToTrustee("B");
    await store.flush();
    const since = mark();

    expect(room.quitToTrustee("B")).toBe(false);
    await store.flush();

    expect(writes(timeline, since)).toEqual([]);
  });

  it("重新接管把 control=human 写回数据库", async () => {
    const users = fourUsers();
    const { room, mark, timeline, store } = await startedRoom(users);
    room.quitToTrustee("B");
    await store.flush();
    const since = mark();

    expect(room.resumeControl("B")).toBe(true);
    await store.flush();

    const [row] = statements(timeline, "insert:match_room_players", since);
    expect(row![CONTROL]).toBe("human");
  });

  it("暂离与回到牌桌都落库，且只在真的变化时写", async () => {
    const users = fourUsers();
    const { room, mark, timeline, store } = await startedRoom(users);
    const since = mark();

    room.markAway("C", true);
    room.markAway("C", true);
    await store.flush();

    const rows = statements(timeline, "insert:match_room_players", since);
    expect(rows).toHaveLength(1);
    expect(rows[0]![AWAY]).toBe(true);
    // 暂离**不碰**控制权：返回大厅的人随时回来就能直接操作。
    expect(rows[0]![CONTROL]).toBe("human");

    const back = mark();
    room.markAway("C", false);
    await store.flush();
    expect(statements(timeline, "insert:match_room_players", back)[0]![AWAY]).toBe(false);
  });

  it("异常断线：保护期的绝对截止时刻写进库里，到期转托管再写一次", async () => {
    // 墙钟语义的两个落点都要落到库上：
    //   1) 断线那一刻写下**绝对时刻**（不是"还剩多少秒"）；
    //   2) 到点转托管那一刻写下 trustee，并把那个时刻清掉。
    const users = fourUsers();
    let now = Date.parse("2026-09-15T00:00:00.000Z");
    const { store, timeline, room, mark } = await startedRoom(users, { clock: () => new Date(now) });

    const since = mark();
    room.disconnect("B");
    await store.flush();

    const [withDeadline] = statements(timeline, "insert:match_room_players", since);
    expect(withDeadline![CONTROL]).toBe("human");
    // 关键：写的是 00:02:00 这个**时刻本身**，服务重启后读出来还是它。
    expect(withDeadline![RECONNECT_DEADLINE]).toEqual(new Date(now + 120_000));

    const expiredAt = mark();
    now += 120_001;
    expect(room.expireReconnectWindow("B")).toBe(true);
    await store.flush();

    const rows = statements(timeline, "insert:match_room_players", expiredAt);
    expect(rows).toHaveLength(1);
    expect(rows[0]![CONTROL]).toBe("trustee");
    // 转托管之后不该残留一个旧时刻
    expect(rows[0]![RECONNECT_DEADLINE]).toBeNull();
    // 掉线到点转托管 ≠ 主动退出：renounced 必须写回 false，
    // 否则重启后一次纯掉线会被误判成"放弃比赛"触发提前终局。
    expect(rows[0]![RENOUNCED]).toBe(false);
  });

  it("重连时才发现窗口已过，那一次转换同样落库", async () => {
    // 兜底路径：窗口到期本该由实时层的定时器触发，但服务刚重启、定时器还没排上时，
    // 玩家先进来了 —— 转换发生在 reconnect() 里，也必须写进数据库。
    const users = fourUsers();
    let now = Date.parse("2026-09-15T00:00:00.000Z");
    const { store, timeline, room, mark } = await startedRoom(users, { clock: () => new Date(now) });

    room.disconnect("B");
    now += 120_001;
    // 先把"断线写下 deadline"那一次排掉，下面断言的才是 reconnect 那一次。
    await store.flush();
    const since = mark();

    expect(room.reconnect("B")).toBe(true);
    await store.flush();

    const rows = statements(timeline, "insert:match_room_players", since);
    expect(rows).toHaveLength(1);
    expect(rows[0]![CONTROL]).toBe("trustee");
    expect(rows[0]![RECONNECT_DEADLINE]).toBeNull();
  });

  it("退出后真人重新进入：renounced 写回 false，哪怕控制权没变也要落库", async () => {
    // 这条是 renounced 专属的坑：quit 之后真人回来（reconnect），control 仍是 trustee、
    // 也没有控制权转换 —— 旧的 flush 条件只看 `changed`，这个标记就会留在库里，
    // 重启后"全员放弃"判定会把一个真人在线的座位错误地算成主动放弃。
    const users = fourUsers();
    const { store, timeline, room, mark } = await startedRoom(users);

    room.quitToTrustee("B");
    await store.flush();
    const since = mark();

    expect(room.reconnect("B")).toBe(false); // 没有控制权转换
    await store.flush();

    const rows = statements(timeline, "insert:match_room_players", since);
    expect(rows).toHaveLength(1);
    expect(rows[0]![RENOUNCED]).toBe(false);
    expect(rows[0]![CONTROL]).toBe("trustee"); // 进来 ≠ 接管
  });

  it("重启后从数据库恢复 renounced —— quit 过的座位仍是主动放弃状态", async () => {
    const users = [account("A", 600, "room-1"), account("B", 500, "room-1")];
    const { store } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 3 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "0", control: "human", away: false, renounced: false, control_changed_at: null },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: true, opening_balance: "500", raw_delta: "0", control: "trustee", away: false, renounced: true, control_changed_at: new Date(2) },
      ],
    });

    const room = store.rooms.get("room-1")!;
    expect(room.players.get("A")!.renounced).toBe(false);
    expect(room.players.get("B")!.renounced).toBe(true);
    // 恢复出的状态足以支撑"全员放弃"判定：4 座全这样恢复时，实时层必须能判出终局
    expect(room.players.get("B")).toMatchObject({ control: "trustee", renounced: true });
  });

  it("重启后从数据库恢复托管座位 —— 不能一律当 human", async () => {
    // 这是这一整块改动的核心：重启后如果托管座位被恢复成 human，而它又没人连接，
    // 整局就会卡在等人工操作上。所以 load() 必须读 control 而不是默认 human。
    const users = [account("A", 600, "room-1"), account("B", 500, "room-1")];
    const { store } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 3 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "0", control: "human", away: false, control_changed_at: null },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: true, opening_balance: "500", raw_delta: "0", control: "trustee", away: false, control_changed_at: new Date(2) },
      ],
    });

    const room = store.rooms.get("room-1")!;
    expect(room.players.get("A")).toMatchObject({ control: "human", away: false, connected: false });
    expect(room.players.get("B")).toMatchObject({ control: "trustee", connected: false });
    expect(room.players.get("B")!.controlChangedAt).toEqual(new Date(2));
    // 暂停离随 control 一起恢复
    expect(presenceOf(room.players.get("B")!)).toBe("trustee");
  });

  it("恢复出的暂离座位仍然是 away", async () => {
    const users = [account("A", 600, "room-1")];
    const { store } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 1 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "0", control: "human", away: true, control_changed_at: null },
      ],
    });

    const player = store.rooms.get("room-1")!.players.get("A")!;
    expect(player.away).toBe(true);
    expect(presenceOf(player)).toBe("away");
  });

  it("墙钟：恢复出的还是原来那个截止时刻 —— 重启不重送 120 秒", async () => {
    // 用户给的例子：20:00 断线 → deadline = 20:02 → 20:10 才恢复 ⇒ 认定 20:02 已过期。
    // 这里用"1 分钟前"构造同一件事（真实时钟），关键是**读出来的必须是库里那个旧时刻**，
    // 不能变成"重启时刻 + 120 秒" —— 后者正是这一列要防的白送。
    const users = [account("A", 600, "room-1"), account("B", 500, "room-1")];
    const deadline = new Date(Date.now() - 60_000);
    const { store, timeline, mark } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 2 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: true, opening_balance: "500", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: deadline },
      ],
    });

    const room = store.rooms.get("room-1")!;
    const player = room.players.get("B")!;
    expect(player.reconnectDeadline).toEqual(deadline);
    expect(player.control).toBe("human");

    // load 期间排进队列的写还没执行，先排空，下面断言的才是"到期那一次"。
    await store.flush();
    const since = mark();
    expect(room.expireOverdueControl()).toEqual(["B"]);
    await store.flush();
    expect(player.control).toBe("trustee");
    expect(player.reconnectDeadline).toBeUndefined();
    const written = statements(timeline, "insert:match_room_players", since);
    expect(written.map((row) => [row![1], row![CONTROL]])).toEqual([["B", "trustee"]]);

    // 幂等：再判一次什么都不发生 —— timer / load / auth 多入口同时发现过期
    // 也只有一个会真正执行，不会重复产生游戏动作。
    expect(room.expireOverdueControl()).toEqual([]);
  });

  it("墙钟的另一面：截止时刻还没到 ⇒ 仍在人工控制权保护期", async () => {
    // 服务**短暂**重启（停机 < 120 秒）不该把人踢成托管 —— 判据是时刻，不是"重启过"。
    const users = [account("A", 600, "room-1")];
    const deadline = new Date(Date.now() + 60_000);
    const { store } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 2 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: deadline },
      ],
    });

    const room = store.rooms.get("room-1")!;
    expect(room.expireOverdueControl()).toEqual([]);
    expect(room.players.get("A")).toMatchObject({ control: "human" });
    expect(room.players.get("A")!.reconnectDeadline).toEqual(deadline);
  });

  it("数据库里出现未知的 control 值时启动就报错，不静默猜成 human", async () => {
    // 静默猜错的代价很具体：一个本该托管的座位被当成人工，没人操作却一直等下去。
    const users = [account("A", 600, "room-1")];
    const { database } = fakeDatabase({
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 1 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "0", control: "TRUSTEE", away: false, control_changed_at: null },
      ],
    });

    await expect(PostgresRoomStore.load(database, accountStore(users))).rejects.toThrow("unknown control value");
  });
});

describe("大局累计的持久化与恢复", () => {
  /** 四人各异的局，方便断言累计是按人的。入参必须零和。 */
  function fourWayRound(a: number, b: number, c: number, d: number): RecordedRound {
    return {
      reason: "three-winners",
      deltas: [
        { playerId: "A", delta: a },
        { playerId: "B", delta: b },
        { playerId: "C", delta: c },
        { playerId: "D", delta: d },
      ],
      wins: [],
      winnerSeats: [],
      nextDealerSeat: 0,
      events: [{ eventId: `event-${ledgerSequence++}`, type: "win", payer: "A", payee: "B", points: 1, note: "点炮" }],
    };
  }

  /** 取累计 UPDATE 的 (userId, rawDelta) —— 写的必须是**绝对值**，不是增量。 */
  function rawDeltaWrites(timeline: RecordedQuery[], since: number): Array<[string, number]> {
    return statements(timeline, "update:match_room_players", since).map(
      (row) => [row[1] as string, row[2] as number],
    );
  }

  it("每小局结算立即落库累计（绝对值，不是增量）", async () => {
    const { store, room, timeline } = await startedRoom(fourUsers());

    // 第 1 局：A +10, B -5, C -3, D -2（零和）
    room.recordCompletedRound(fourWayRound(10, -5, -3, -2));
    await store.flush();
    expect(rawDeltaWrites(timeline, 0)).toEqual([
      ["A", 10], ["B", -5], ["C", -3], ["D", -2],
    ]);

    // 第 2 局：累计 +8 / +1 / -5 / -4 —— 落库的是**累计**，不是本局增量
    const since = timeline.length;
    room.recordCompletedRound(fourWayRound(-2, 6, -2, -2));
    await store.flush();
    expect(rawDeltaWrites(timeline, since)).toEqual([
      ["A", 8], ["B", 1], ["C", -5], ["D", -4],
    ]);
  });

  it("重启后从 raw_delta 恢复累计（不归零），继续结算在旧账上累加", async () => {
    // 模拟"前 2 局结算后服务重启"：库里 raw_delta = +8 / +1 / -5 / -4
    const users = fourUsers();
    const { store, timeline } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 2 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: false, opening_balance: "600", raw_delta: "8", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: false, opening_balance: "500", raw_delta: "1", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "C", seat: 2, joined_at: new Date(2), ready: false, opening_balance: "500", raw_delta: "-5", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "D", seat: 3, joined_at: new Date(3), ready: false, opening_balance: "500", raw_delta: "-4", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
      ],
    });
    const room = store.rooms.get("room-1")!;

    // 1) 恢复出来的必须是库里那份累计，不能是 0
    expect([...room.rawDeltas.entries()]).toEqual([
      ["A", 8], ["B", 1], ["C", -5], ["D", -4],
    ]);

    // 2) 重启后继续第 3 局：在旧账上累加，**不能覆盖**
    await store.flush();
    const since = timeline.length;
    room.recordCompletedRound(fourWayRound(4, -2, -1, -1));
    await store.flush();
    expect(rawDeltaWrites(timeline, since)).toEqual([
      ["A", 12], ["B", -1], ["C", -6], ["D", -5],
    ]);
  });

  it("0 分荒庄：累计保持上一局的值，不归零", async () => {
    const { store, room, timeline } = await startedRoom(fourUsers());
    room.recordCompletedRound(fourWayRound(10, -5, -3, -2));
    await store.flush();
    const since = timeline.length;

    room.recordCompletedRound(fourWayRound(0, 0, 0, 0));
    await store.flush();
    expect(rawDeltaWrites(timeline, since)).toEqual([
      ["A", 10], ["B", -5], ["C", -3], ["D", -2],
    ]);
  });

  it("托管座位（TRUSTEE）与人工座位走同一个结算入口，同样落库累计", async () => {
    // 控制权只决定"谁在操作这一座"；结算入口是同一条
    // broadcastState → recordCompletedRound，与 control 无关。
    const users = fourUsers();
    const { store, timeline } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 0 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: false, opening_balance: "600", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: false, opening_balance: "500", raw_delta: "0", control: "trustee", away: false, control_changed_at: new Date(9), reconnect_deadline: null },
        { room_id: "room-1", user_id: "C", seat: 2, joined_at: new Date(2), ready: false, opening_balance: "500", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "D", seat: 3, joined_at: new Date(3), ready: false, opening_balance: "500", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
      ],
    });
    const room = store.rooms.get("room-1")!;
    await store.flush();
    const since = timeline.length;

    room.recordCompletedRound(fourWayRound(10, -5, -3, -2));
    await store.flush();
    // B 是托管座位，账一样记了 —— 托管不丢分
    expect(rawDeltaWrites(timeline, since)).toEqual([
      ["A", 10], ["B", -5], ["C", -3], ["D", -2],
    ]);
  });

  it("整场结算基于**完整**8 局累计（重启前后的账都算），account_delta 不被中途污染", async () => {
    // 模拟：前 2 局在重启前（库里 raw_delta=+8/+1/-5/-4），重启后继续打满 8 局
    const users = fourUsers();
    const { store, timeline } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 2 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: false, opening_balance: "600", raw_delta: "8", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: false, opening_balance: "500", raw_delta: "1", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "C", seat: 2, joined_at: new Date(2), ready: false, opening_balance: "500", raw_delta: "-5", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        { room_id: "room-1", user_id: "D", seat: 3, joined_at: new Date(3), ready: false, opening_balance: "500", raw_delta: "-4", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
      ],
    });
    const room = store.rooms.get("room-1")!;
    await store.flush();
    const since = timeline.length;

    // 第 3~8 局，每局 +4 / -2 / -1 / -1
    for (let index = 0; index < 6; index += 1) room.recordCompletedRound(fourWayRound(4, -2, -1, -1));
    await store.flush();

    // 最终累计：8+24=32、1-12=-11、-5-6=-11、-4-6=-10
    const expected = [["A", 32], ["B", -11], ["C", -11], ["D", -10]];
    const finalUpserts = statements(timeline, "insert:match_room_players", since);
    expect(finalUpserts).toHaveLength(4);
    for (const [userId, delta] of expected) {
      const row = finalUpserts.find((entry) => entry[1] === userId)!;
      // raw_delta 是完整累计（不是只有重启后那 6 局）
      expect(row![6]).toBe(delta);
      // account_delta 有真实入账（opening 500/600 都够扣，不会被 cap 清零）
      expect(row![7]).toBe(delta);
    }
    // 每个非零入账都有一条流水
    expect(statements(timeline, "insert:point_ledger", since)).toHaveLength(4);
  });

  it("load 对账：raw_delta 与已结算小场之和不一致时告警，但不自动改写", async () => {
    const users = fourUsers();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { store } = await loadedStore(users, {
        rooms: [{ room_id: "room-1", room_no: "654321", status: "playing", owner_id: "A", completed_rounds: 2 }],
        players: [
          { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: false, opening_balance: "600", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
          { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: false, opening_balance: "500", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
          { room_id: "room-1", user_id: "C", seat: 2, joined_at: new Date(2), ready: false, opening_balance: "500", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
          { room_id: "room-1", user_id: "D", seat: 3, joined_at: new Date(3), ready: false, opening_balance: "500", raw_delta: "0", control: "human", away: false, control_changed_at: null, reconnect_deadline: null },
        ],
        // 库里已结算的小场之和：A +8 / B +1 / C -5 / D -4
        roundTotals: [
          { room_id: "room-1", player_id: "A", total: 8 },
          { room_id: "room-1", player_id: "B", total: 1 },
          { room_id: "room-1", player_id: "C", total: -5 },
          { room_id: "room-1", player_id: "D", total: -4 },
        ],
      });

      const room = store.rooms.get("room-1")!;
      // 恢复值仍是 raw_delta（0），**没有被偷偷改成对账值**
      expect([...room.rawDeltas.entries()]).toEqual([
        ["A", 0], ["B", 0], ["C", 0], ["D", 0],
      ]);
      // 但不一致被明确说了出来
      const output = warn.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("大局累计与已结算小场不一致");
      expect(output).toContain("raw_delta=0");
      expect(output).toContain("已结算之和=8");
    } finally {
      warn.mockRestore();
    }
  });

  it("事务原子性：累计写失败 ⇒ 整个小局事务回滚，不能'记了小局但没记累计'", async () => {
    // fakeDatabase 的 failOn 会让 UPDATE 匹配时抛错 —— 相当于累计那条写失败
    const { store, room, timeline } = await startedRoom(fourUsers(), { failOn: "UPDATE match_room_players" });
    const since = timeline.length;

    room.recordCompletedRound(fourWayRound(10, -5, -3, -2));
    await expect(store.flush()).rejects.toThrow("database offline");

    // 事务回滚：这一局**整个**没落盘（BEGIN...ROLLBACK，没有 COMMIT）
    const flow = writes(timeline, since);
    expect(flow).toContain("ROLLBACK");
    expect(flow).not.toContain("COMMIT");
  });
});
