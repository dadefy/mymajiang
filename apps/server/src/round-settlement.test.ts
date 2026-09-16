import { describe, expect, it } from "vitest";
import { MahjongGame } from "@mianyang-mahjong/rules";
import type { MatchRoom, RoomResult } from "@mianyang-mahjong/domain";
import { matchSettlement, playerSnapshot, roundSettlement } from "./ws-server.js";

const ids = ["p0", "p1", "p2", "p3"] as [string, string, string, string];
describe("round reveal", () => {
  it("头像用的是**整局累计**：房间已结算的小场 + 本小场的事件账本", () => {
    // 两个数都要下发，缺一个界面就会错：
    //   * 只看房间的 `rawDeltas`（一小场结算时才累加）—— 正打着的这一小场不进去，
    //     头像上的数字要等下一小场开始才动；
    //   * 只看本小场的账本 —— 换一小场就归零，那正是「头像记的是本小场不是一整局」这个缺陷。
    const game = new MahjongGame(1, ids, 1);
    game.events.push({ eventId: "a", type: "win", payer: "p1", payee: "p0", points: 4, note: "这一小场" });
    const room = {
      roomId: "r",
      // 前几小场已经结算、并进房间的累计。
      rawDeltas: new Map([["p0", 20], ["p1", -20]]),
      players: new Map(),
    } as unknown as MatchRoom;
    const view = playerSnapshot(game, 0, room, 4) as {
      totalRounds: number;
      players: Array<{ roundDelta: number; matchDelta: number }>;
    };
    expect(view.totalRounds).toBe(8);
    expect(view.players.map((player) => player.roundDelta)).toEqual([4, -4, 0, 0]);
    expect(view.players.map((player) => player.matchDelta)).toEqual([24, -24, 0, 0]);
  });

  it("publishes dealer, public avatars and current round net scores from the event ledger", () => {
    const game = new MahjongGame(1, ids, 2);
    game.events.push(
      { eventId: "a", type: "win", payer: "p1", payee: "p0", points: 6, note: "test" },
      { eventId: "b", type: "kong", payer: "p0", payee: "p2", points: 4, note: "test" },
      { eventId: "c", type: "tax_refund", payer: "p2", payee: "p0", points: 2, note: "test" },
    );
    const room = { roomId: "r", players: new Map(ids.map(id => [id, { account: { avatarUrl: `https://example.invalid/${id}.png` } }])) } as unknown as MatchRoom;
    const view = playerSnapshot(game, 0, room, 1) as { dealerSeat: number; players: Array<{ roundDelta: number; avatarUrl: string }> };
    expect(view.dealerSeat).toBe(2);
    expect(view.players.map(player => player.roundDelta)).toEqual([4, -6, 2, 0]);
    expect(view.players[0]!.avatarUrl).toBe("https://example.invalid/p0.png");
    const next = playerSnapshot(new MahjongGame(2, ids, 1), 0, room, 2) as typeof view;
    expect(next.dealerSeat).toBe(1);
    expect(next.players.map(player => player.roundDelta)).toEqual([0, 0, 0, 0]);
  });

  it("keeps the first two winners private, survives restore, and reveals all four only at settlement", () => {
    const observed = new Set<number>();
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) {
      let game = new MahjongGame(seed, ids);
      let previousWinners = 0;
      for (let step = 0; game.phase !== "finished" && step < 2000; step++) {
        const actor = ids.find((id) => game.allowedActions(id).length > 0);
        expect(actor).toBeDefined();
        game.autoAct(actor!);
        const winners = game.players.filter((player) => player.won).length;
        if (winners > previousWinners) {
          for (const winner of game.players.filter((player) => player.won)) {
            expect(winner.winningHand.length).toBeGreaterThan(0);
            expect(winner.canWinWith(winner.winningHand)).toBe(true);
          }
          const state = game.serialize();
          game = MahjongGame.restore(state);
          expect(game.serialize()).toEqual(state);
          observed.add(winners);
          if (winners < 3 && game.phase !== "finished") {
            expect(() => roundSettlement(game)).toThrow("Round has not finished");
            for (let seat = 0; seat < 4; seat++) {
              const view = playerSnapshot(game, seat, { roomId: "room" } as MatchRoom, 1) as { players: object[]; result?: unknown; hand: number[] };
              expect(view.result).toBeUndefined();
              for (const player of view.players) {
                expect(player).not.toHaveProperty("hand");
                expect(player).not.toHaveProperty("winningHand");
              }
              if (game.players[seat]!.won) expect(view.hand).toEqual(game.players[seat]!.winningHand);
            }
          }
          if (winners >= 3) {
            expect(game.phase).toBe("finished");
            expect(game.result?.reason).toBe("three-winners");
          }
          previousWinners = winners;
        }
      }
      expect(game.phase).toBe("finished");
      const result = roundSettlement(game);
      reasons.add(result.reason);
      expect(result.players).toHaveLength(4);
      expect(result.deltas).toHaveLength(4);
      expect(result.deltas.reduce((sum, entry) => sum + entry.delta, 0)).toBe(0);
      for (const player of result.players) {
        const source = game.players[player.seat]!;
        expect(player.hand).toEqual(source.won ? source.winningHand : source.hand);
        expect(player.melds).toEqual(source.melds);
        expect(result.deltas.find((entry) => entry.playerId === player.playerId)?.delta).toBe(game.result!.deltas.find((entry) => entry.playerId === player.playerId)?.delta ?? 0);
      }
    }
    expect([...observed].sort()).toEqual([1, 2, 3]);
    expect(reasons).toEqual(new Set(["three-winners", "wall-exhausted"]));
  });

  it("结算载荷带上「胡了什么牌型 / 谁给的牌」", () => {
    // 这两样只有结算那一刻算得出来（番型在 `finalizeWin` 里算完就不再重算），
    // 所以必须跟着结算一起下发，否则客户端界面上永远是空的。
    const kinds = new Set<string>();
    let sawSelfDraw = 0;
    let sawDiscard = 0;
    for (let seed = 1; seed <= 100; seed++) {
      let game = new MahjongGame(seed, ids);
      for (let step = 0; game.phase !== "finished" && step < 2000; step++) {
        const actor = ids.find((id) => game.allowedActions(id).length > 0);
        game.autoAct(actor!);
      }

      const settlement = roundSettlement(game, { room: { roomId: "r", rawDeltas: new Map(), players: new Map() } as unknown as MatchRoom, roundNumber: 3 });
      expect(settlement.roundNumber).toBe(3);
      expect(settlement.totalRounds).toBe(8);
      expect(settlement.wins).toHaveLength(game.result!.winnerSeats.length);
      // 房间那一截是空的（没有已结算的小场），所以整局累计应当就等于本小场。
      for (const player of settlement.players) {
        expect(player.matchDelta).toBe(settlement.deltas.find((entry) => entry.playerId === player.playerId)?.delta);
      }
      settlement.wins.forEach((win, index) => {
        // 与 winnerSeats 同序，客户端才能把「总览」与「明细」对上号。
        expect(win.seat).toBe(game.result!.winnerSeats[index]);
        // 番型明细非空（平胡也会有一项），且名字是中文，可以直接显示。
        expect(win.items.length).toBeGreaterThan(0);
        for (const item of win.items) kinds.add(item.name);
        if (win.method === "self-draw") {
          sawSelfDraw += 1;
          expect(win.fromSeat).toBeNull();
        } else {
          sawDiscard += 1;
          expect(win.fromSeat).not.toBeNull();
          expect(win.fromTile).not.toBeNull();
        }
      });
    }
    // 番型名字确实被带出来了（不是一串 code），而且自摸/点炮两种都出现过。
    expect(kinds.size).toBeGreaterThan(1);
    expect([...kinds].every((name) => /[\u4e00-\u9fa5]/.test(name))).toBe(true);
    expect(sawSelfDraw).toBeGreaterThan(0);
    expect(sawDiscard).toBeGreaterThan(0);
  });
});

describe("整局结算帧的载荷", () => {
  /** 四位玩家：`seat` 是开局时按加入顺序定死的，昵称/头像/余额都挂在 account 上。 */
  const seated = [
    { userId: "1000000004", nickname: "赵六", avatarUrl: "avatar-4", points: 994, seat: 3 },
    { userId: "1000000001", nickname: "张三", avatarUrl: "avatar-1", points: 1022, seat: 0 },
    { userId: "1000000003", nickname: "王五", avatarUrl: "avatar-3", points: 992, seat: 2 },
    { userId: "1000000002", nickname: "李四", avatarUrl: "avatar-2", points: 992, seat: 1 },
  ];
  const result: RoomResult = {
    roomId: "r",
    completedRounds: 8,
    reason: "completed",
    rawDeltas: [
      { playerId: "1000000001", delta: 28 },
      { playerId: "1000000002", delta: -8 },
      { playerId: "1000000003", delta: -14 },
      { playerId: "1000000004", delta: -6 },
    ],
    accountDeltas: [
      { playerId: "1000000001", delta: 22 },
      { playerId: "1000000002", delta: -8 },
      { playerId: "1000000003", delta: -8 },
      { playerId: "1000000004", delta: -6 },
    ],
  };

  it("补上开始/结算两个时间戳，并把四行明细按座位排好", () => {
    // 这份载荷长在 `broadcastState` 深处，只有**真打完一整局 8 小场**才会走到 ——
    // 那一局要跑十几分钟，所以这里直接对着函数断言。
    const room = {
      roomId: "r",
      startedAt: new Date("2026-09-17T00:00:00.000Z"),
      finishedAt: new Date("2026-09-17T00:42:18.000Z"),
      // 故意打乱插入顺序：输出必须是按 `seat` 排的，不能跟着 Map 的插入顺序走。
      players: new Map(seated.map((entry) => [
        entry.userId,
        { account: { userId: entry.userId, nickname: entry.nickname, avatarUrl: entry.avatarUrl, points: entry.points }, seat: entry.seat },
      ])),
    } as unknown as MatchRoom;

    const frame = matchSettlement(room, result);

    // 两个毫秒时间戳（不是 Date）—— 结算记录顶部「开始 … 耗时 …」的唯一来源。
    expect(frame.startedAt).toBe(Date.parse("2026-09-17T00:00:00.000Z"));
    expect(frame.finishedAt).toBe(Date.parse("2026-09-17T00:42:18.000Z"));
    expect(frame.finishedAt! - frame.startedAt!).toBe(2_538_000); // 42 分 18 秒

    // 四行明细：顺序按座位，每行的 id / 昵称 / 头像 / 得失分 / 入账分 / 余额都对上人。
    expect(frame.players.map((player) => player.seat)).toEqual([0, 1, 2, 3]);
    expect(frame.players.map((player) => player.playerId))
      .toEqual(["1000000001", "1000000002", "1000000003", "1000000004"]);
    expect(frame.players.map((player) => player.nickname)).toEqual(["张三", "李四", "王五", "赵六"]);
    expect(frame.players.map((player) => player.avatarUrl))
      .toEqual(["avatar-1", "avatar-2", "avatar-3", "avatar-4"]);
    expect(frame.players.map((player) => player.delta)).toEqual([28, -8, -14, -6]);
    // 0 号位与 2 号位被处理过（+28→+22、-14→-8）—— 入账分与场上净胜负必须分开给。
    expect(frame.players.map((player) => player.accountDelta)).toEqual([22, -8, -8, -6]);
    expect(frame.players.map((player) => player.balance)).toEqual([1022, 992, 992, 994]);
    // 零和：帧里那四行也得零和，玩家就是拿它来对账的。
    expect(frame.players.reduce((sum, player) => sum + player.delta, 0)).toBe(0);

    // 域层原有的字段一个都不能丢 —— 客户端还读 `rawDeltas` / `accountDeltas` / `reason`。
    expect(frame.reason).toBe("completed");
    expect(frame.completedRounds).toBe(8);
    expect(frame.rawDeltas).toEqual(result.rawDeltas);
    expect(frame.accountDeltas).toEqual(result.accountDeltas);
    // 早先多下发过一个顶层 `balances`（与 `players[].balance` 是同一份数据）—— 已合并，别再回来。
    expect(frame).not.toHaveProperty("balances");
  });

  it("房间没有时间戳时：startedAt 不给，finishedAt 兜底当前时刻（绝不写 NaN）", () => {
    // 「缺开始时刻就整行不显示」是客户端的约定，前提是这里给的是 undefined 而不是 0/NaN。
    const room = { roomId: "r", players: new Map() } as unknown as MatchRoom;
    const before = Date.now();
    const frame = matchSettlement(room, { ...result, reason: "dissolved", rawDeltas: [], accountDeltas: [] });
    expect(frame.startedAt).toBeUndefined();
    expect(frame.finishedAt).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite(frame.finishedAt)).toBe(true);
    expect(frame.players).toEqual([]);
  });
});
