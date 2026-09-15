import { describe, expect, it } from "vitest";
import { InMemoryAccountStore, type RecordedRound, type UserAccount } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresRoomStore } from "./postgres-room-store.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface RecordedQuery {
  channel: "pool" | "tx";
  sql: string;
  parameters: unknown[];
}

function fakeDatabase(options: { rooms?: unknown[]; players?: unknown[]; failOn?: string } = {}) {
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
async function startedRoom(users: readonly UserAccount[], options: { failOn?: string } = {}) {
  const loaded = await loadedStore(users, options);
  const room = loaded.store.createRoom("room-1", users[0]!);
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

    store.createRoom("room-1", account("A", 600));
    await store.flush();

    expect(writes(timeline, since)).toEqual(["BEGIN", "insert:match_rooms", "insert:match_room_players", "COMMIT"]);
    expect(statements(timeline, "insert:match_rooms", since)[0]).toEqual([
      "room-1",
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
    ]);
  });

  it("records seats and opening balances when the match starts", async () => {
    const users = fourUsers();
    const { store, timeline, mark } = await loadedStore(users);
    const room = store.createRoom("room-1", users[0]!);
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
    expect(statements(timeline, "insert:match_rooms", since)[0]![2]).toBe("playing");
  });

  it("records every round once, with its settlement events", async () => {
    const { store, room, timeline, mark } = await startedRoom(fourUsers());
    const since = mark();

    room.recordCompletedRound(round(100));
    room.recordCompletedRound(round(100));
    await store.flush();

    // The round and the room's round counter travel together.
    expect(writes(timeline, since)).toEqual([
      "BEGIN",
      "insert:match_rounds",
      "insert:match_rooms",
      "COMMIT",
      "BEGIN",
      "insert:match_rounds",
      "insert:match_rooms",
      "COMMIT",
    ]);
    const rounds = statements(timeline, "insert:match_rounds", since);
    expect(rounds[0]!.slice(1, 6)).toEqual(["room-1", 1, "three-winners", "[1]", 1]);
    expect(rounds[1]![2]).toBe(2);
    expect(rounds[0]![6]).toBe('[{"playerId":"A","delta":-100},{"playerId":"B","delta":100}]');
    expect(rounds[0]![7]).toContain('"type":"win"');
    expect(statements(timeline, "insert:match_rooms", since)[1]![4]).toBe(2);
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
    expect(statements(timeline, "insert:match_rooms", since).at(-1)!.slice(2, 8)).toEqual([
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
    const room = store.createRoom("room-1", users[0]!);
    room.join(users[1]!);
    await store.flush();
    const since = mark();

    expect(room.requestDissolve("A")).toBe(true);
    await store.flush();

    expect(writes(timeline, since)).toEqual(["insert:match_rooms"]);
    expect(statements(timeline, "insert:match_rooms", since)[0]!.slice(2, 8)).toEqual([
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
      rooms: [{ room_id: "room-1", status: "waiting", owner_id: "A", completed_rounds: 0 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: null, joined_at: new Date(0), ready: true, opening_balance: null, raw_delta: null },
        { room_id: "room-1", user_id: "B", seat: null, joined_at: new Date(1), ready: true, opening_balance: null, raw_delta: null },
      ],
    });

    const room = store.rooms.get("room-1")!;
    expect(room.status).toBe("waiting");
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
      rooms: [{ room_id: "room-1", status: "playing", owner_id: "A", completed_rounds: 3 }],
      players: [
        { room_id: "room-1", user_id: "A", seat: 0, joined_at: new Date(0), ready: true, opening_balance: "600", raw_delta: "-300" },
        { room_id: "room-1", user_id: "B", seat: 1, joined_at: new Date(1), ready: true, opening_balance: "500", raw_delta: "300" },
      ],
    });

    const room = store.rooms.get("room-1")!;
    expect(room.status).toBe("playing");
    expect(room.completedRounds).toBe(3);
    expect([...room.players.values()].map((player) => player.seat)).toEqual([0, 1]);
    expect([...room.openingBalances.entries()]).toEqual([["A", 600], ["B", 500]]);
    expect([...room.rawDeltas.entries()]).toEqual([["A", -300], ["B", 300]]);

    await store.flush();
    // 对局还没结束：不许结算，也不许把玩家从 activeMatchId 上摘下来。
    expect(statements(timeline, "insert:point_ledger")).toHaveLength(0);
    expect(users.map((user) => user.activeMatchId)).toEqual(["room-1", "room-1"]);
    expect(statements(timeline, "insert:match_rooms")[0]!.slice(2, 4)).toEqual(["playing", "A"]);
  });

  it("closes a room that has nobody left in it", async () => {
    const users = [account("A", 600)];
    const { store, timeline } = await loadedStore(users, {
      rooms: [{ room_id: "room-1", status: "waiting", owner_id: "A", completed_rounds: 0 }],
      players: [],
    });

    expect(store.rooms.size).toBe(0);
    await store.flush();
    expect(writes(timeline)).toEqual(["update:match_rooms"]);
  });

  it("fails loudly when stored rows reference a user that does not exist", async () => {
    const { database } = fakeDatabase({
      rooms: [{ room_id: "room-1", status: "waiting", owner_id: "A", completed_rounds: 0 }],
      players: [
        { room_id: "room-1", user_id: "GHOST", seat: null, joined_at: new Date(0), ready: false, opening_balance: null, raw_delta: null },
      ],
    });

    await expect(PostgresRoomStore.load(database, accountStore([account("A", 600)]))).rejects.toThrow("unknown user");
  });
});
