import { describe, expect, it } from "vitest";
import type { MatchResult, RoomResult, RoomSnapshot } from "../src/protocol.js";
import { matchResultText, roundResultText } from "../src/browser/result-text.js";

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
    // 这正是本次崩溃的形态：整场结算被当成单局读，`deltas` 是 undefined。
    const broken = { ...round, deltas: undefined as unknown as RoomResult["deltas"] };
    expect(() => roundResultText(broken, room)).not.toThrow();
  });
});

describe("整场结算摘要", () => {
  it("用 rawDeltas 列出四家的净胜负", () => {
    const text = matchResultText(match, room);
    expect(text).toContain("打满 8 局");
    expect(text).toContain("共 8 局");
    expect(text).toContain("0 号位 +48");
    expect(text).toContain("3 号位 -96");
  });

  it("整场结算与单局结算**不是同一个形状** —— 这个函数不会去读 deltas", () => {
    // 回归保护：如果把单局的形状喂进来，这里既不该崩、也不该假装有数据。
    const wrongShape = { roomId: "r", completedRounds: 8, reason: "completed" } as MatchResult;
    expect(() => matchResultText(wrongShape, room)).not.toThrow();
    expect(matchResultText(wrongShape, room)).toContain("共 8 局");
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
