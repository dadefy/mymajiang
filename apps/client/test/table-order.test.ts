import { describe, expect, it } from "vitest";
import type { MatchState, RoomSnapshot } from "../src/protocol.js";
import {
  activeRing,
  nextActiveSeat,
  nicknameOf,
  relationLabel,
  resolveSeat,
  sortedHand,
  turnOrder,
} from "../src/browser/table-order.js";
import { tileLabel } from "../src/browser/tile-label.js";

/** 造一局牌。默认「开局刚坐下」：四人都在轮转里。 */
function match(options: {
  seat: number;
  won?: number[];
  currentPlayerSeat?: number | null;
}): MatchState {
  const won = new Set(options.won ?? []);
  return {
    roomId: "room-1",
    roundNumber: 1,
    seat: options.seat,
    phase: "playing",
    currentPlayerSeat: options.currentPlayerSeat ?? options.seat,
    tilesLeft: 40,
    hand: [],
    melds: [],
    missingSuit: null,
    discards: [],
    won: false,
    players: [0, 1, 2, 3].map((seat) => ({
      seat,
      handSize: 13,
      melds: [],
      discards: [],
      won: won.has(seat),
      missingSuit: null,
    })),
  };
}

function snapshot(nicknames: string[]): RoomSnapshot {
  return {
    roomId: "room-1",
    roomNo: "482913",
    ruleVersion: "MIANYANG_XZ_1_0",
    status: "playing",
    ownerId: "u0",
    completedRounds: 1,
    result: null,
    players: nicknames.map((nickname, index) => ({
      userId: `u${index}`,
      nickname,
      points: 2000,
      ready: true,
      connected: true,
      disconnectedAt: null,
      reconnectDeadline: null,
    })),
  };
}

describe("出牌顺序", () => {
  it("四人都在轮转里时，从我往下依次是下一号位", () => {
    expect(activeRing(match({ seat: 0 }))).toEqual([1, 2, 3]);
    expect(activeRing(match({ seat: 1 }))).toEqual([2, 3, 0]);
    expect(activeRing(match({ seat: 2 }))).toEqual([3, 0, 1]);
  });

  it("我坐 3 号位时下家是 0 号位（座位号递增，要绕回）", () => {
    // 递增与递减在这里才分得开：递减的话下家会是 2。
    expect(activeRing(match({ seat: 3 }))).toEqual([0, 1, 2]);
    expect(nextActiveSeat(match({ seat: 3 }), 3)).toBe(0);
  });

  it("跳过已经胡牌的人 —— 血战后期方位靠这条才对", () => {
    // 1 号位已胡：0 号位的下家应该是 2，不是 1。
    const withWinner = match({ seat: 0, won: [1] });
    expect(activeRing(withWinner)).toEqual([2, 3]);
    expect(nextActiveSeat(withWinner, 0)).toBe(2);
  });

  it("只剩两个人在打时，环里只有一个人", () => {
    // 1、2 已胡，只剩 0 与 3 —— 3 既是上家也是下家，这里只留一个座位。
    expect(activeRing(match({ seat: 0, won: [1, 2] }))).toEqual([3]);
    expect(activeRing(match({ seat: 3, won: [1, 2] }))).toEqual([0]);
  });

  it("只剩我一个在打时环是空的（不会再指向自己）", () => {
    expect(activeRing(match({ seat: 0, won: [1, 2, 3] }))).toEqual([]);
    expect(nextActiveSeat(match({ seat: 0, won: [1, 2, 3] }), 3)).toBe(0);
  });

  it("turnOrder 是「我打头的一整圈」", () => {
    expect(turnOrder(match({ seat: 2 }))).toEqual([2, 3, 0, 1]);
    expect(turnOrder(match({ seat: 2, won: [3] }))).toEqual([2, 0, 1]);
  });
});

describe("方位标签", () => {
  it("三个对手是下家 / 对家 / 上家", () => {
    expect([0, 1, 2].map((index) => relationLabel([1, 2, 3], index)))
      .toEqual(["下家", "对家", "上家"]);
  });

  it("只剩两个对手时只标下家 / 上家 —— 再叫「对家」就名不副实", () => {
    expect([0, 1].map((index) => relationLabel([2, 3], index))).toEqual(["下家", "上家"]);
  });

  it("只剩一个对手时叫「对手」", () => {
    expect(relationLabel([3], 0)).toBe("对手");
  });

  it("下标越界也回退成「对手」，不返回 undefined", () => {
    expect(relationLabel([1, 2, 3], 9)).toBe("对手");
    expect(relationLabel([], 0)).toBe("对手");
  });
});

describe("座位号换昵称", () => {
  it("房间快照的 players 下标就是座位号", () => {
    const room = snapshot(["张三", "李四", "王五", "赵六"]);
    expect(nicknameOf(room, 0)).toBe("张三");
    expect(nicknameOf(room, 3)).toBe("赵六");
  });

  it("快照还没到、或座位超出快照时，退化成带号位的文字而不是崩掉", () => {
    // 进房的一瞬间 match 帧可能先于房间快照到达。
    expect(nicknameOf(null, 2)).toBe("2 号位");
    expect(nicknameOf(snapshot(["张三"]), 3)).toBe("3 号位");
  });
});

describe("四家同屏：把一条连接对回座位号", () => {
  const players = snapshot(["张三", "李四", "王五", "赵六"]).players;

  it("有对局视图时以服务端给的座位为准", () => {
    // 开局之后 match.seat 是权威值，比任何推断都可靠。
    expect(resolveSeat({ matchSeat: 2, userId: "u0", players, fallback: 0 })).toBe(2);
  });

  it("座位 0 是合法值，不能被当成「还没有座位」", () => {
    // 写成真值判断（`if (matchSeat)`）会让坐 0 号位的那家掉进回退分支，
    // 表现是四个方位随机错位、且只在部分账号上复现 —— 很难查。
    expect(resolveSeat({ matchSeat: 0, userId: "u3", players, fallback: 3 })).toBe(0);
  });

  it("等待期没有对局视图，靠 userId 在成员列表里的下标反查", () => {
    expect(resolveSeat({ matchSeat: null, userId: "u1", players, fallback: 0 })).toBe(1);
    expect(resolveSeat({ matchSeat: null, userId: "u3", players, fallback: 1 })).toBe(3);
  });

  it("还没登录、或快照还没到时退回连接序号，保证四家各占一个方位", () => {
    expect(resolveSeat({ matchSeat: null, userId: null, players, fallback: 2 })).toBe(2);
    expect(resolveSeat({ matchSeat: null, userId: "u0", players: null, fallback: 1 })).toBe(1);
  });

  it("userId 不在成员列表里时也退回连接序号，而不是 -1", () => {
    // 四个账号可能不同批（有人换过密钥、或房间里还有上一局留下的人），
    // 对不上号时宁可方位暂时不准，也不能把卡片画到不存在的座位上去。
    expect(resolveSeat({ matchSeat: null, userId: "u9", players, fallback: 3 })).toBe(3);
  });
});

describe("手牌排序", () => {
  it("按牌面排：万 → 筒 → 条，每种 1–9", () => {
    // 牌的编号本身就是这个顺序（0–8 万、9–17 筒、18–26 条），所以升序排即可。
    const messy = [20, 8, 9, 0, 26, 17]; // 3条、9万、1筒、1万、9条、9筒
    expect(sortedHand(messy).map(tileLabel)).toEqual(["1万", "9万", "1筒", "9筒", "3条", "9条"]);
  });

  it("不改动传入的数组 —— match.hand 是服务端视图的一部分", () => {
    const original = [5, 1, 3];
    const sorted = sortedHand(original);
    expect(original).toEqual([5, 1, 3]);
    expect(sorted).toEqual([1, 3, 5]);
  });

  it("空手牌与单张都不出错", () => {
    expect(sortedHand([])).toEqual([]);
    expect(sortedHand([7])).toEqual([7]);
  });

  it("相同的牌排在一起（手上有对子时不会散开）", () => {
    const withPair = [4, 13, 4, 13, 4];
    expect(sortedHand(withPair)).toEqual([4, 4, 4, 13, 13]);
  });
});
