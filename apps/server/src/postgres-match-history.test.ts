import { describe, expect, it } from "vitest";
import type { PostgresDatabase } from "./database.js";
import { PostgresMatchHistory } from "./postgres-match-history.js";

interface RecordedQuery {
  sql: string;
  parameters: unknown[];
}

function fakeDatabase(options: {
  matches?: unknown[];
  players?: unknown[];
  rounds?: unknown[];
  /** 当 listMatchesFor 带上游标（翻第二页）时返回的比赛；缺省复用 matches。 */
  nextMatches?: unknown[];
} = {}) {
  const queries: RecordedQuery[] = [];
  const database = {
    pool: {
      async query(sql: string, parameters: unknown[] = []) {
        queries.push({ sql, parameters });
        if (sql.includes("JOIN match_room_players mine")) {
          // 带了游标的查询参数更长（userId + finalizedAt + roomId + limit+1），据此区分页。
          const rows = parameters.length > 2 ? (options.nextMatches ?? options.matches ?? []) : (options.matches ?? []);
          return { rows, rowCount: 1 };
        }
        if (sql.includes("FROM match_rooms")) return { rows: options.matches ?? [], rowCount: 1 };
        if (sql.includes("FROM match_room_players")) return { rows: options.players ?? [], rowCount: 1 };
        if (sql.includes("FROM match_rounds")) return { rows: options.rounds ?? [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    },
  } as unknown as PostgresDatabase;
  return { database, queries };
}

const MATCH_ROW = {
  room_id: "room-1",
  rule_version: "MIANYANG_XZ_1_0",
  status: "finished",
  completed_rounds: 8,
  final_reason: "completed",
  created_at: new Date("2026-09-15T00:00:00.000Z"),
  finalized_at: new Date("2026-09-15T01:00:00.000Z"),
};

const PLAYER_ROWS = [
  { room_id: "room-1", user_id: "A", seat: 0, raw_delta: "-800", account_delta: "-600" },
  { room_id: "room-1", user_id: "B", seat: 1, raw_delta: "800", account_delta: "600" },
];

const ROUND_ROW = {
  round_id: "round-1",
  round_number: 1,
  finish_reason: "three-winners",
  winner_seats: [1],
  next_dealer_seat: 1,
  deltas: [{ playerId: "A", delta: -100 }, { playerId: "B", delta: 100 }],
  events: [{ eventId: "event-1", type: "win", payer: "A", payee: "B", points: 100, note: "点炮" }],
  finished_at: new Date("2026-09-15T00:30:00.000Z"),
};

describe("PostgresMatchHistory", () => {
  it("lists the caller's matches with every player of each match", async () => {
    const { database, queries } = fakeDatabase({ matches: [MATCH_ROW], players: PLAYER_ROWS });
    const history = new PostgresMatchHistory(database);

    const page = await history.listMatchesFor("A", 5);

    expect(queries[0]!.parameters).toEqual(["A", 6]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.matches).toEqual([
      {
        roomId: "room-1",
        ruleVersion: "MIANYANG_XZ_1_0",
        status: "finished",
        completedRounds: 8,
        finalReason: "completed",
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
        finalizedAt: new Date("2026-09-15T01:00:00.000Z"),
        players: [
          { userId: "A", seat: 0, rawDelta: -800, accountDelta: -600 },
          { userId: "B", seat: 1, rawDelta: 800, accountDelta: 600 },
        ],
      },
    ]);
  });

  it("pages with a keyset cursor over finalized_at and room_id", async () => {
    const older = { ...MATCH_ROW, room_id: "room-0", finalized_at: new Date("2026-09-14T01:00:00.000Z") };
    // 第一页 limit=1 却取回 2 行，说明还有下一页；游标指向最后一行的键，翻页时返回它之后（更早）的数据。
    const { database, queries } = fakeDatabase({
      matches: [MATCH_ROW, older],
      nextMatches: [],
      players: PLAYER_ROWS,
    });
    const history = new PostgresMatchHistory(database);

    const first = await history.listMatchesFor("A", 1);
    expect(first.matches).toHaveLength(1);
    expect(first.matches[0]!.roomId).toBe("room-1");
    expect(first.nextCursor).toBeDefined();

    const second = await history.listMatchesFor("A", 1, first.nextCursor);
    expect(second.matches).toHaveLength(0);
    expect(second.nextCursor).toBeUndefined();

    // 翻页查询必须带上游标的时间戳与房间号两个键。
    const followUp = queries.at(-1)!;
    expect(followUp.parameters.length).toBe(4); // userId, finalizedAt, roomId, limit+1
    expect(followUp.sql).toContain("(r.finalized_at, r.room_id) <");
  });

  it("rejects a cursor it did not issue", async () => {
    const { database } = fakeDatabase({ matches: [MATCH_ROW], players: PLAYER_ROWS });
    const history = new PostgresMatchHistory(database);

    await expect(history.listMatchesFor("A", 5, "m1:garbage")).rejects.toThrow("INVALID_CURSOR");
    await expect(history.listMatchesFor("A", 5, "not-a-marker")).rejects.toThrow("INVALID_CURSOR");
  });

  it("only asks for matches that actually played a round", async () => {
    const { database, queries } = fakeDatabase();
    const history = new PostgresMatchHistory(database);

    await history.listMatchesFor("A", 20);
    await history.findMatch("room-1");

    // A room that dissolved before the first deal is not a result, so it must never be selected.
    for (const query of queries) {
      expect(query.sql).toContain("completed_rounds > 0");
      expect(query.sql).toContain("'finished', 'dissolved'");
    }
  });

  it("returns one match or nothing when the room has no recorded result", async () => {
    const withMatch = new PostgresMatchHistory(fakeDatabase({ matches: [MATCH_ROW], players: PLAYER_ROWS }).database);
    expect(await withMatch.findMatch("room-1")).toMatchObject({ roomId: "room-1", completedRounds: 8 });

    const withoutMatch = new PostgresMatchHistory(fakeDatabase().database);
    expect(await withoutMatch.findMatch("room-1")).toBeUndefined();
  });

  it("falls back to the status when an old row has no final_reason", async () => {
    const { database } = fakeDatabase({
      matches: [{ ...MATCH_ROW, status: "dissolved", final_reason: null }],
      players: PLAYER_ROWS,
    });

    expect(await new PostgresMatchHistory(database).findMatch("room-1")).toMatchObject({ finalReason: "dissolved" });
  });

  it("reads a match's rounds in order, with their events", async () => {
    const { database, queries } = fakeDatabase({ rounds: [ROUND_ROW] });
    const history = new PostgresMatchHistory(database);

    const rounds = await history.listRounds("room-1");

    expect(queries[0]!.parameters).toEqual(["room-1"]);
    expect(rounds[0]).toEqual({
      roundId: "round-1",
      roundNumber: 1,
      finishReason: "three-winners",
      winnerSeats: [1],
      nextDealerSeat: 1,
      deltas: [
        { playerId: "A", delta: -100 },
        { playerId: "B", delta: 100 },
      ],
      events: [{ eventId: "event-1", type: "win", payer: "A", payee: "B", points: 100, note: "点炮" }],
      finishedAt: new Date("2026-09-15T00:30:00.000Z"),
    });
  });

  it("rejects a settled match whose deltas are missing", async () => {
    const { database } = fakeDatabase({
      matches: [MATCH_ROW],
      players: [{ ...PLAYER_ROWS[0]!, account_delta: null }],
    });

    await expect(new PostgresMatchHistory(database).findMatch("room-1")).rejects.toThrow("no usable account_delta");
  });

  it("rejects a round whose columns are not JSON arrays", async () => {
    const { database } = fakeDatabase({ rounds: [{ ...ROUND_ROW, deltas: "not json" }] });

    await expect(new PostgresMatchHistory(database).listRounds("room-1")).rejects.toThrow("not a JSON array");
  });
});
