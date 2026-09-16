import { describe, expect, it } from "vitest";
import { MahjongGame } from "@mianyang-mahjong/rules";
import type { MatchRoom } from "@mianyang-mahjong/domain";
import { playerSnapshot, roundSettlement } from "./ws-server.js";

const ids = ["p0", "p1", "p2", "p3"] as [string, string, string, string];
describe("round reveal", () => {
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
});
