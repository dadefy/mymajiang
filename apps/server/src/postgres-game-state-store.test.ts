import { describe, expect, it } from "vitest";
import { MahjongGame } from "@mianyang-mahjong/rules";
import type { PostgresDatabase } from "./database.js";
import { PostgresGameStateStore } from "./postgres-game-state-store.js";

const IDS = ["p0", "p1", "p2", "p3"] as const;

interface RecordedQuery {
  sql: string;
  parameters: unknown[];
}

function fakeDatabase(row?: { round_number: number; state: unknown }) {
  const queries: RecordedQuery[] = [];
  const database = {
    pool: {
      async query(sql: string, parameters: unknown[] = []) {
        queries.push({ sql, parameters });
        if (sql.includes("FROM match_round_states")) {
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      },
    },
  } as unknown as PostgresDatabase;
  return { database, queries };
}

/** 推进到行牌阶段，状态比刚发完牌更有代表性。 */
function midRoundGame(): MahjongGame {
  const game = new MahjongGame(9, [...IDS]);
  for (const id of IDS) game.autoSwap(id);
  for (const id of IDS) game.autoMissing(id);
  game.discard(IDS[game.currentPlayerSeat!]!, game.viewFor(IDS[game.currentPlayerSeat!]!).hand[0]!);
  return game;
}

describe("PostgresGameStateStore", () => {
  it("把进行中的那一局存成一份 JSON 文档", async () => {
    const { database, queries } = fakeDatabase();
    const store = PostgresGameStateStore.create(database);
    const game = midRoundGame();

    store.save("room-1", 2, game.serialize());
    await store.flush();

    const write = queries.find((query) => query.sql.includes("INSERT INTO match_round_states"))!;
    expect(write.parameters[0]).toBe("room-1");
    expect(write.parameters[1]).toBe(2);
    expect(JSON.parse(write.parameters[2] as string)).toEqual(game.serialize());
  });

  it("读回来的状态可以原样恢复成牌局", async () => {
    const game = midRoundGame();
    const { database } = fakeDatabase({ round_number: 4, state: game.serialize() });
    const store = PostgresGameStateStore.create(database);

    const loaded = await store.load("room-1");

    expect(loaded?.roundNumber).toBe(4);
    expect(MahjongGame.restore(loaded!.state).serialize()).toEqual(game.serialize());
  });

  it("没有存档时返回空", async () => {
    const store = PostgresGameStateStore.create(fakeDatabase().database);
    expect(await store.load("room-1")).toBeUndefined();
  });

  it("也接受被当成文本返回的 JSON 列", async () => {
    const game = midRoundGame();
    const { database } = fakeDatabase({ round_number: 1, state: JSON.stringify(game.serialize()) });
    const store = PostgresGameStateStore.create(database);

    expect((await store.load("room-1"))?.state.phase).toBe(game.phase);
  });

  it("拒绝不是对象的存档", async () => {
    const store = PostgresGameStateStore.create(fakeDatabase({ round_number: 1, state: "[1,2]" }).database);
    await expect(store.load("room-1")).rejects.toThrow("not an object");
  });

  it("对局结束后删除存档", async () => {
    const { database, queries } = fakeDatabase();
    const store = PostgresGameStateStore.create(database);

    store.clear("room-1");
    await store.flush();

    const write = queries.find((query) => query.sql.includes("DELETE FROM match_round_states"))!;
    expect(write.parameters).toEqual(["room-1"]);
  });
});
