import { describe, expect, it } from "vitest";
import { MahjongGame, type WinDetail } from "@mianyang-mahjong/rules";

/**
 * 结算明细：胡牌类型、谁给的牌、实收多少。
 *
 * 这三样以前只有服务端的账本知道，客户端只拿到一个总数 —— 玩家看不到自己是
 * 清一色还是对对胡，也看不到是谁放炮给的。所以钉在数据出口测：
 * 明细必须与账本一致，且「自摸」不能让放炮者为空以外的值。
 */
const ids = ["p0", "p1", "p2", "p3"] as [string, string, string, string];

function playToFinished(seed: number): MahjongGame {
  const game = new MahjongGame(seed, ids);
  for (let step = 0; game.phase !== "finished" && step < 2000; step += 1) {
    const actor = ids.find((id) => game.allowedActions(id).length > 0);
    expect(actor).toBeDefined();
    game.autoAct(actor!);
  }
  expect(game.phase).toBe("finished");
  return game;
}

describe("结算明细", () => {
  it("每位赢家都有明细，且番型非空（平胡也要有一项）", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const game = playToFinished(seed);
      const result = game.result!;
      expect(result.wins).toHaveLength(result.winnerSeats.length);
      result.wins.forEach((win, index) => {
        // 按胡牌先后 —— 与 winnerSeats 同序，客户端才能直接把两块对上。
        expect(win.seat).toBe(result.winnerSeats[index]);
        expect(win.items.length).toBeGreaterThan(0);
        // 番数为 0 的项（平胡）也要在场，否则结算界面会显示成空白。
        expect(win.items.every((item) => item.name.length > 0)).toBe(true);
      });
    }
  });

  it("自摸没有放炮者；点炮必须指出是哪一家给的牌", () => {
    let sawSelfDraw = 0;
    let sawDiscard = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      for (const win of playToFinished(seed).result!.wins) {
        if (win.method === "self-draw") {
          sawSelfDraw += 1;
          expect(win.fromSeat).toBeNull();
          expect(win.fromTile).toBeNull();
          // 自摸必须有「自摸」这一项，界面才看得出是自摸胡的 ——
          // 例外是天胡/地胡：番型是互斥分支，天胡地胡本身就是自摸胡，
          // 只记一项 4 番、不再叠「自摸」（叠了也会被 4 番封顶吃掉）。
          const labelled = win.items.some((item) => item.code === "SELF_DRAW")
            || win.items.some((item) => item.code === "HEAVENLY" || item.code === "EARTHLY");
          expect(labelled).toBe(true);
        } else {
          sawDiscard += 1;
          expect(win.fromSeat).not.toBeNull();
          expect(win.fromSeat).not.toBe(win.seat);
          // 给牌的那一张要能说出来（「胡 3 号位打出的 7万」）。
          expect(win.fromTile).not.toBeNull();
        }
      }
    }
    // 两种都要覆盖到，否则这条测试可能在只出现一种的情况下空过。
    expect(sawSelfDraw).toBeGreaterThan(0);
    expect(sawDiscard).toBeGreaterThan(0);
  });

  it("实收分数与账本一致，付款家数也对得上", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const game = playToFinished(seed);
      for (const win of game.result!.wins) {
        const payer = game.players[win.seat]!.id;
        const payments = game.events.filter((event) => event.type === "win" && event.payee === payer);
        expect(win.payerCount).toBe(payments.length);
        expect(win.points).toBe(payments.reduce((total, event) => total + event.points, 0));
        // 点炮只有放炮者付；自摸按实际在打的家数付（已胡的人不再付，所以可能少于三家）。
        if (win.method === "discard") expect(win.payerCount).toBe(1);
        else expect(win.payerCount).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("封顶之后番数与实收都要按封顶算，但明细保留原始番数", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      for (const win of playToFinished(seed).result!.wins) {
        expect(win.finalFan).toBeLessThanOrEqual(4);
        expect(win.rawFan).toBeGreaterThanOrEqual(win.finalFan);
        // 实收 = 封顶后的番数对应的分 × 付款家数（封顶才会出现两者不等）。
        expect(win.points).toBe(win.paymentPerOpponent * win.payerCount);
      }
    }
  });

  it("明细能跟着快照往返（进程重启后结算界面照样有内容）", () => {
    let checked = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const game = playToFinished(seed);
      const restored = MahjongGame.restore(game.serialize());
      expect(restored.result?.wins).toEqual(game.result!.wins);
      // 流局那一局没有赢家，跳过 —— 这条用例要验的是「明细能往返」。
      if (game.result!.wins.length === 0) continue;
      checked += 1;
      // 深拷贝：改快照里的番型不该动到内部状态。
      restored.result!.wins[0]!.items = [];
      expect(game.result!.wins[0]!.items.length).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("流局时没有赢家明细（不是空对象占位）", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const game = playToFinished(seed);
      if (game.result!.reason === "wall-exhausted") {
        expect(game.result!.wins).toEqual([]);
        return;
      }
    }
    // 60 个种子里没出现流局说明前提变了，直接失败比空过好。
    expect.unreachable("60 个种子里应当至少出现一次流局");
  });

  it("明细的类型契约：赢家座位一定在 0..3", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const win of playToFinished(seed).result!.wins as WinDetail[]) {
        expect(win.seat).toBeGreaterThanOrEqual(0);
        expect(win.seat).toBeLessThanOrEqual(3);
        seen.add(win.seat);
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
