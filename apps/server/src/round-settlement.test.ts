import { describe, expect, it } from "vitest";
import { MahjongGame } from "@mianyang-mahjong/rules";
import type { MatchRoom } from "@mianyang-mahjong/domain";
import { playerSnapshot, roundSettlement } from "./ws-server.js";

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
