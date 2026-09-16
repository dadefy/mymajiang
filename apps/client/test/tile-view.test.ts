import { describe, expect, it } from "vitest";
import type { MatchState } from "../src/protocol.js";
import {
  discardGroups,
  freshDiscardSeat,
  meldKindLabel,
  meldTiles,
} from "../src/browser/tile-view.js";
import { tileLabel } from "../src/browser/tile-label.js";

type Meld = MatchState["melds"][number];

/** 造一局牌。只填这一组用例关心的字段，其余给最小可用值。 */
function match(options: {
  phase?: MatchState["phase"];
  currentPlayerSeat?: number | null;
  discards?: number[][];
  melds?: Meld[][];
}): MatchState {
  const discards = options.discards ?? [[], [], [], []];
  const melds = options.melds ?? [[], [], [], []];
  return {
    roomId: "room-1",
    roundNumber: 1,
    seat: 0,
    phase: options.phase ?? "playing",
    currentPlayerSeat: options.currentPlayerSeat ?? 0,
    tilesLeft: 40,
    hand: [0, 1, 2],
    melds: [],
    missingSuit: null,
    discards: [],
    won: false,
    players: [0, 1, 2, 3].map((seat) => ({
      seat,
      handSize: 13,
      melds: melds[seat] ?? [],
      discards: discards[seat] ?? [],
      won: false,
      missingSuit: null,
    })),
  };
}

describe("副露摆几张牌", () => {
  it("碰是 3 张、杠是 4 张", () => {
    expect(meldTiles({ kind: "pong", tile: 0 })).toEqual([0, 0, 0]);
    expect(meldTiles({ kind: "kong", tile: 0 })).toEqual([0, 0, 0, 0]);
  });

  it("暗杠也是 4 张 —— 张数不因看不见而变", () => {
    expect(meldTiles({ kind: "kong", tile: 20, concealed: true })).toEqual([20, 20, 20, 20]);
  });

  it("杠比碰多摆的那一张就是杠的价值所在", () => {
    // 少摆一张的话牌桌上少一张牌，而肉眼几乎看不出来。
    expect(meldTiles({ kind: "kong", tile: 5 }).length
      - meldTiles({ kind: "pong", tile: 5 }).length).toBe(1);
  });

  it("同一副牌里都是同一个牌值", () => {
    const tiles = meldTiles({ kind: "kong", tile: 13 });
    expect(new Set(tiles).size).toBe(1);
    expect(tileLabel(tiles[0]!)).toBe("5筒");
  });
});

describe("副露的名字", () => {
  it("碰、明杠、暗杠三种名字分得开", () => {
    expect(meldKindLabel({ kind: "pong", tile: 0 })).toBe("碰");
    expect(meldKindLabel({ kind: "kong", tile: 0 })).toBe("杠");
    expect(meldKindLabel({ kind: "kong", tile: 0, concealed: true })).toBe("暗杠");
  });

  it("暗杠不写成「杠」—— 它不破门清，牌桌上必须能一眼分开", () => {
    expect(meldKindLabel({ kind: "kong", tile: 7, concealed: true }))
      .not.toBe(meldKindLabel({ kind: "kong", tile: 7 }));
  });
});

describe("中央弃牌区取哪一份", () => {
  it("四家的弃牌都在 —— 弃牌是公开信息，不只有自己的", () => {
    const view = match({ discards: [[1], [2, 3], [], [4]] });
    expect(discardGroups(view).map((group) => group.tiles)).toEqual([[1], [2, 3], [], [4]]);
  });

  it("按座位号排好，顺序不受服务端下发次序影响", () => {
    const view = match({ discards: [[1], [2], [3], [4]] });
    // 造一份乱序的 players，模拟「服务端数组次序变了」。
    view.players = [...view.players].reverse();
    expect(discardGroups(view).map((group) => group.seat)).toEqual([0, 1, 2, 3]);
  });

  it("保持打出的先后，不做排序 —— 这是弃牌堆不是手牌", () => {
    const view = match({ discards: [[20, 3, 11], [], [], []] });
    expect(discardGroups(view)[0]!.tiles).toEqual([20, 3, 11]);
  });

  it("不改动传入的状态（match 是服务端视图的一部分）", () => {
    const view = match({ discards: [[1, 2], [], [], []] });
    const before = [...view.players];
    discardGroups(view);
    expect(view.players).toEqual(before);
    expect(view.players[0]!.discards).toEqual([1, 2]);
  });
});

describe("刚打出的那一张框给谁", () => {
  it("waiting 别人响应时（claiming）框给刚出牌的座位", () => {
    // claiming 阶段 currentPlayerSeat 仍是刚出牌的人 —— 全场都在看他打的这张。
    expect(freshDiscardSeat(match({ phase: "claiming", currentPlayerSeat: 2 }))).toBe(2);
  });

  it("行牌阶段不框任何人的弃牌", () => {
    // 那时 currentPlayerSeat 指的是**下一个**要出牌的人，
    // 拿它去高亮弃牌会框到别人的牌堆上。
    expect(freshDiscardSeat(match({ phase: "playing", currentPlayerSeat: 2 }))).toBeNull();
  });

  it("换三张 / 定缺 / 本局结束都不框", () => {
    for (const phase of ["swapping", "missing", "finished"] as const) {
      expect(freshDiscardSeat(match({ phase, currentPlayerSeat: 1 }))).toBeNull();
    }
  });

  it("座位号 0 是合法值，不能被当成「没有」", () => {
    expect(freshDiscardSeat(match({ phase: "claiming", currentPlayerSeat: 0 }))).toBe(0);
  });
});
