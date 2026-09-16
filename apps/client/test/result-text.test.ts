import { describe, expect, it } from "vitest";
import type { MatchResult, RoomResult, RoomSnapshot, WinDetail } from "../src/protocol.js";
import { clockText, countdownText, durationText, fanListText, matchResultText, matchTimeText, roundResultText, winLines, winSummaryText } from "../src/browser/result-text.js";

function snapshot(nicknames: string[]): RoomSnapshot {
  return {
    roomId: "room-1",
    roomNo: "482913",
    ruleVersion: "MIANYANG_XZ_1_0",
    status: "playing",
    ownerId: "u0",
    completedRounds: 8,
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

const room = snapshot(["张三", "李四", "王五", "赵六"]);

const round: RoomResult = {
  reason: "three-winners",
  deltas: [
    { playerId: "u0", delta: 24 },
    { playerId: "u1", delta: -8 },
    { playerId: "u2", delta: -8 },
    { playerId: "u3", delta: -8 },
  ],
  winnerSeats: [0],
  nextDealerSeat: 1,
};

const match: MatchResult = {
  roomId: "room-1",
  completedRounds: 8,
  reason: "completed",
  rawDeltas: [
    { playerId: "u0", delta: 48 },
    { playerId: "u1", delta: 80 },
    { playerId: "u2", delta: -32 },
    { playerId: "u3", delta: -96 },
  ],
  accountDeltas: [
    { playerId: "u0", delta: 48 },
    { playerId: "u1", delta: 80 },
    { playerId: "u2", delta: -32 },
    { playerId: "u3", delta: -96 },
  ],
};

describe("单局结算摘要", () => {
  it("把 playerId 换成座位号，并带上每家得失分", () => {
    const text = roundResultText(round, room);
    expect(text).toContain("三家胡");
    expect(text).toContain("赢家座位 0");
    expect(text).toContain("0 号位 +24");
    expect(text).toContain("3 号位 -8");
  });

  it("流局时写「无人胡牌」，不写一个空清单", () => {
    expect(roundResultText({ ...round, reason: "wall-exhausted", winnerSeats: [] }, room))
      .toContain("无人胡牌");
  });

  it("快照还没到、或 playerId 不在里面时退化成 id 后四位而不是崩掉", () => {
    expect(roundResultText(round, null)).toContain("u0 +24");
    expect(roundResultText({ ...round, deltas: [{ playerId: "unknown-id-7788", delta: 4 }] }, room))
      .toContain("7788 +4");
  });

  it("deltas 缺失也不抛异常（协议是运行时的，类型挡不住线上的旧服务端）", () => {
    // 这正是那次崩溃的形态：整场结算被当成单局读，`deltas` 是 undefined。
    const broken = { ...round, deltas: undefined as unknown as RoomResult["deltas"] };
    expect(() => roundResultText(broken, room)).not.toThrow();
  });
});

describe("整场结算摘要", () => {
  it("用 rawDeltas 列出四家的净胜负", () => {
    const text = matchResultText(match, room);
    expect(text).toContain("打满 8 小场");
    expect(text).toContain("0 号位 +48");
    expect(text).toContain("3 号位 -96");
  });

  it("整场结算与单局结算**不是同一个形状** —— 这个函数不会去读 deltas", () => {
    // 回归保护：如果把单局的形状喂进来，这里既不该崩、也不该假装有数据。
    const wrongShape = { roomId: "r", completedRounds: 8, reason: "completed" } as MatchResult;
    expect(() => matchResultText(wrongShape, room)).not.toThrow();
    expect(matchResultText(wrongShape, room)).toContain("打满 8 小场");
  });

  it("触发封顶或禁止负分时，额外标出实际结算分", () => {
    // rawDeltas 是场上的净胜负，accountDeltas 才是写进账号的分；两者不同时要说清。
    const capped: MatchResult = {
      ...match,
      rawDeltas: [{ playerId: "u3", delta: -160 }],
      accountDeltas: [{ playerId: "u3", delta: -96 }],
    };
    expect(matchResultText(capped, room)).toContain("3 号位 -160（结算 -96）");
  });

  it("两者一致时不重复写一遍，免得看着像两笔账", () => {
    expect(matchResultText(match, room)).not.toContain("结算 +48");
  });

  it("中途解散也认", () => {
    expect(matchResultText({ ...match, reason: "dissolved", completedRounds: 3 }, room))
      .toContain("中途解散");
  });
});

const selfDraw: WinDetail = {
  seat: 2,
  method: "self-draw",
  fromSeat: null,
  fromTile: null,
  items: [
    { code: "ALL_PUNGS", name: "对对胡", fan: 1 },
    { code: "CLOSED", name: "门清", fan: 1 },
    { code: "SELF_DRAW", name: "自摸", fan: 1 },
  ],
  rawFan: 3,
  finalFan: 3,
  paymentPerOpponent: 8,
  payerCount: 3,
  points: 24,
};

const discardWin: WinDetail = {
  seat: 1,
  method: "discard",
  fromSeat: 3,
  fromTile: 15, // 7筒
  items: [
    { code: "CLEAN_SUIT", name: "清一色", fan: 2 },
    { code: "MIDDLE", name: "中张", fan: 1 },
  ],
  rawFan: 3,
  finalFan: 3,
  paymentPerOpponent: 8,
  payerCount: 1,
  points: 8,
};

describe("番型明细文案", () => {
  it("逐项列出番数，不是只给一个总数", () => {
    // 只写「3 番」玩家看不出这 3 番怎么来的，而那是他要对照规则表确认的东西。
    expect(fanListText(selfDraw)).toBe("对对胡1 + 门清1 + 自摸1 = 3 番");
  });

  it("0 番的项（平胡）不写数字", () => {
    const plain: WinDetail = { ...selfDraw, items: [{ code: "PLAIN", name: "平胡", fan: 0 }], rawFan: 0, finalFan: 0 };
    expect(fanListText(plain)).toBe("平胡 = 0 番");
  });

  it("封顶时把原始番数留住并标出封顶", () => {
    const capped: WinDetail = { ...selfDraw, rawFan: 6, finalFan: 4, items: [{ code: "ROOTS", name: "根", fan: 6 }] };
    expect(fanListText(capped)).toBe("根6 = 6 番（封顶 4 番）");
  });

  it("一项都没有时兜底写「平胡」，不留空白", () => {
    expect(fanListText({ ...selfDraw, items: [], rawFan: 0, finalFan: 0 })).toBe("平胡 = 0 番");
  });
});

describe("一位赢家的结算说明", () => {
  it("自摸：写明自摸、番型、几家各付、实收", () => {
    expect(winSummaryText(selfDraw, room)).toBe("自摸 · 对对胡1 + 门清1 + 自摸1 = 3 番 · 3 家各付 8 · 实收 24 分");
  });

  it("点炮：写明是哪一家打的、哪张牌", () => {
    // 「谁给的牌」是玩家最想知道的 —— 牌桌上要盯的就是放炮那一家。
    expect(winSummaryText(discardWin, room)).toBe("胡 赵六 打出的 7筒 · 清一色2 + 中张1 = 3 番 · 实收 8 分");
  });

  it("抢杠胡不写成「打出的牌」—— 那张牌是被抢的补杠", () => {
    const robber: WinDetail = {
      ...discardWin,
      fromTile: 4,
      items: [{ code: "ROB_KONG", name: "抢杠胡", fan: 1 }],
      rawFan: 1,
      finalFan: 1,
    };
    expect(winSummaryText(robber, room)).toBe("抢杠 赵六 的 5万 · 抢杠胡1 = 1 番 · 实收 8 分");
  });

  it("自摸只剩两家付时写实际家数，不写死三家", () => {
    // 血战到底里已胡的人不再付，后期常常只剩两家。
    const late: WinDetail = { ...selfDraw, payerCount: 2, points: 16 };
    expect(winSummaryText(late, room)).toContain("2 家各付 8");
  });

  it("只有一家付时不写「1 家各付」这种别扭话", () => {
    expect(winSummaryText({ ...selfDraw, payerCount: 1 }, room)).not.toContain("1 家各付");
  });

  it("快照没到、昵称对不上时退化成号位而不是崩掉", () => {
    expect(winSummaryText(discardWin, null)).toBe("胡 3 号位 打出的 7筒 · 清一色2 + 中张1 = 3 番 · 实收 8 分");
  });

  it("没给牌值时（老服务端）也能成句", () => {
    expect(winSummaryText({ ...discardWin, fromTile: null }, room)).toContain("胡 赵六 打出的牌");
  });
});

describe("一局的所有赢家", () => {
  const result = { reason: "three-winners", deltas: [], winnerSeats: [1, 2], nextDealerSeat: 0, wins: [discardWin, selfDraw] } as unknown as RoomResult;

  it("按胡牌先后逐条列出，带座位号与昵称", () => {
    const lines = winLines(result, room);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("1 号位（李四）");
    expect(lines[0]).toContain("胡 赵六");
    expect(lines[1]).toContain("2 号位（王五）");
    expect(lines[1]).toContain("自摸");
  });

  it("流局（没有赢家）返回空数组，而不是一行「（无）」", () => {
    expect(winLines({ ...result, wins: [] } as RoomResult, room)).toEqual([]);
  });

  it("老服务端没有 wins 字段时也不抛异常", () => {
    const old = { reason: "wall-exhausted", deltas: [], winnerSeats: [], nextDealerSeat: 0 } as RoomResult;
    expect(winLines(old, room)).toEqual([]);
    expect(old.wins).toBeUndefined();
  });
});

describe("局间倒计时", () => {
  const now = 1_000_000;

  it("按剩余时间向上取整 —— 还剩 1ms 也说「1 秒」而不是「0 秒」", () => {
    expect(countdownText(now + 5_000, now)).toBe("5 秒后开始下一小场");
    expect(countdownText(now + 4_001, now)).toBe("5 秒后开始下一小场");
    expect(countdownText(now + 1, now)).toBe("1 秒后开始下一小场");
  });

  it("同一秒内多次调用文案不变（渲染层 250ms 刷一次，不该跳数字）", () => {
    const target = now + 3_000;
    expect(countdownText(target, now + 100)).toBe(countdownText(target, now + 900));
  });

  it("到点后改成「正在开始下一局…」—— 新局帧还在路上，别说「0 秒」让人干等", () => {
    expect(countdownText(now, now)).toBe("正在开始下一小场…");
    expect(countdownText(now - 500, now)).toBe("正在开始下一小场…");
  });

  it("不停留（或老服务端不下发）时返回 null，调用方整块不显示", () => {
    // 返回 null 而不是「0 秒后开始下一局」—— 后者会让人以为卡住了。
    expect(countdownText(null, now)).toBeNull();
  });
});

describe("整局结算记录顶部的时间行", () => {
  it("时长按「读到哪一位才有意义」分档：秒 / 分秒 / 小时分", () => {
    expect(durationText(59_000)).toBe("59 秒");
    expect(durationText(2_538_000)).toBe("42 分 18 秒");
    expect(durationText(3_600_000)).toBe("1 小时");
    expect(durationText(3_900_000)).toBe("1 小时 5 分");
  });

  it("整分钟不拖一个「0 秒」", () => {
    expect(durationText(60_000)).toBe("1 分");
  });

  it("认不出的时长返回 null，而不是「0 秒」或 NaN", () => {
    expect(durationText(undefined)).toBeNull();
    expect(durationText(Number.NaN)).toBeNull();
    // 结算早于开局（时钟回拨）时不该写出一个负数时长。
    expect(durationText(-1)).toBeNull();
  });

  it("时刻写成 `YYYY-MM-DD HH:mm`（本地时间，各端同一串字）", () => {
    // 用本地构造的 Date 反推期望值，避开时区差异 —— 断言的是**格式**而不是某个绝对时刻。
    const at = new Date(2026, 8, 17, 1, 3, 45); // 2026-09-17 01:03:45 本地
    expect(clockText(at.getTime())).toBe("2026-09-17 01:03");
    expect(clockText(undefined)).toBeNull();
    expect(clockText(Number.NaN)).toBeNull();
  });

  it("两个时间戳齐了才给「开始 … 耗时 …」，缺一个就整行不显示", () => {
    const start = new Date(2026, 8, 17, 1, 3).getTime();
    expect(matchTimeText(start, start + 2_538_000)).toBe("开始 2026-09-17 01:03　耗时 42 分 18 秒");
    // 只报得出一个数的「耗时」是错的，不是不完整的 —— 宁可不显示。
    expect(matchTimeText(start, undefined)).toBeNull();
    expect(matchTimeText(undefined, start)).toBeNull();
  });
});
