import { describe, expect, it } from "vitest";
import { MatchRoom, reserveAccountWrite, type RecordedRound, type UserAccount } from "./index.js";

function account(userId: string, points = 500): UserAccount {
  return {
    userId,
    nickname: userId,
    avatarUrl: `avatar-${userId}`,
    status: "active",
    points,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
  };
}

function readyRoom(points = [600, 500, 500, 500]): { room: MatchRoom; users: UserAccount[] } {
  const users = [account("A", points[0]), account("B", points[1]), account("C", points[2]), account("D", points[3])];
  let joinedAt = 0;
  const room = new MatchRoom("room-1", "123456", users[0]!, () => new Date(joinedAt++));
  room.join(users[1]!);
  room.join(users[2]!);
  room.join(users[3]!);
  for (const user of users) room.setReady(user.userId, true);
  return { room, users };
}

describe("match room", () => {
  it("requires an active account with at least 500 points", () => {
    expect(() => new MatchRoom("room-1", "123456", account("A", 499))).toThrow("at least 500 points");
    const banned = account("B", 500);
    banned.status = "temporarily_banned";
    expect(() => new MatchRoom("room-2", "123456", banned)).toThrow("Active account");
  });

  it("房间号必须是 6 位数字", () => {
    // 这串是给人念、给人输的，格式不对就等于没法进房 —— 所以在域层就挡住。
    for (const bad of ["12345", "1234567", "abcdef", "12345a", ""]) {
      expect(() => new MatchRoom("room-1", bad, account("A"))).toThrow("exactly 6 digits");
    }
    expect(new MatchRoom("room-1", "012345", account("A")).roomNo).toBe("012345");
  });

  it("requires four players without ready and only allows the owner to start", () => {
    const { room } = readyRoom();
    expect(() => room.start("B")).toThrow("Only the room owner");
    room.setReady("D", false);
    for (const id of ["A", "B", "C"]) room.setReady(id, false);
    room.start("A");
    expect(room.status).toBe("playing");
    expect(() => room.leave("D")).toThrow("cannot leave");
  });

  it("transfers ownership to the earliest remaining player before start", () => {
    const { room } = readyRoom();
    room.leave("A");
    expect(room.ownerId).toBe("B");
  });

  it("rebuilding a room from storage skips the entry checks", () => {
    const player = account("B", 500);
    player.activeMatchId = "room-1";
    // 入场校验只属于「入场」那一刻；重建的是已经在房间里、正在打的人。
    expect(() => new MatchRoom("room-1", "123456", player)).toThrow("Active account");
    expect(new MatchRoom("room-1", "123456", player, () => new Date(0), "restore").ownerId).toBe("B");
  });

  it("fixes seats densely from join order when the match starts", () => {
    const { room, users } = readyRoom();
    expect(users.map((user) => room.players.get(user.userId)?.seat)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    room.start("A");

    expect(users.map((user) => room.players.get(user.userId)?.seat)).toEqual([0, 1, 2, 3]);
  });

  it("finishes after eight rounds and caps a loss at the opening balance", () => {
    const { room, users } = readyRoom();
    room.start("A");
    const round: RecordedRound = {
      reason: "three-winners",
      deltas: [
        { playerId: "A", delta: -100 },
        { playerId: "B", delta: 100 },
      ],
      winnerSeats: [1],
      nextDealerSeat: 1,
    };
    for (let index = 0; index < 7; index += 1) {
      expect(room.recordCompletedRound(round)).toBeUndefined();
    }
    const result = room.recordCompletedRound(round);
    expect(result).toMatchObject({ reason: "completed", completedRounds: 8 });
    expect(result?.rawDeltas).toEqual([
      { playerId: "A", delta: -800 },
      { playerId: "B", delta: 800 },
    ]);
    expect(result?.accountDeltas).toEqual([
      { playerId: "A", delta: -600 },
      { playerId: "B", delta: 600 },
    ]);
    expect(users.map((user) => user.points)).toEqual([0, 1100, 500, 500]);
    expect(users.every((user) => user.activeMatchId === undefined)).toBe(true);
  });

  it("记下本场的开始与结算时刻（结算界面靠这两个点算耗时）", () => {
    // 时钟可控：`start()` 与 `finalize()` 各取一次，两个时刻的差就是「本局耗时」。
    // 这两个值事后补不出来 —— `completedRounds` 只说明打了几个小场，不带任何时长信息。
    let now = Date.parse("2026-09-17T00:00:00.000Z");
    const users = [account("A", 600), account("B"), account("C"), account("D")];
    const room = new MatchRoom("room-time", "123456", users[0]!, () => new Date(now));
    for (const user of users.slice(1)) room.join(user);
    for (const user of users) room.setReady(user.userId, true);

    // 还没开局就没有开始时刻：房间可以先建着等人，等人的时间不该算进「本局耗时」。
    expect(room.startedAt).toBeUndefined();
    expect(room.finishedAt).toBeUndefined();

    room.start("A");
    expect(room.startedAt?.toISOString()).toBe("2026-09-17T00:00:00.000Z");
    // 开局**不等于**结算：整局还没打完，结算时刻要等 finalize。
    expect(room.finishedAt).toBeUndefined();

    now += 2_538_000; // 42 分 18 秒
    const round: RecordedRound = {
      reason: "three-winners",
      deltas: [
        { playerId: "A", delta: 60 },
        { playerId: "B", delta: -20 },
        { playerId: "C", delta: -20 },
        { playerId: "D", delta: -20 },
      ],
      winnerSeats: [0],
      nextDealerSeat: 1,
    };
    for (let index = 0; index < 7; index += 1) room.recordCompletedRound(round);
    const result = room.recordCompletedRound(round);

    expect(result?.reason).toBe("completed");
    expect(room.finishedAt?.toISOString()).toBe("2026-09-17T00:42:18.000Z");
    expect((room.finishedAt!.getTime() - room.startedAt!.getTime()) / 1000).toBe(2538);
  });

  it("requires three votes to dissolve a playing room", () => {
    const { room } = readyRoom();
    room.start("A");
    expect(room.requestDissolve("A")).toBe(false);
    expect(room.voteDissolve("B", true)).toBeUndefined();
    const result = room.voteDissolve("C", true);
    expect(result?.reason).toBe("dissolved");
    expect(room.status).toBe("dissolved");
  });

  it("allows reconnection for 120 seconds after a playing-room disconnect", () => {
    let now = Date.parse("2026-09-15T00:00:00.000Z");
    const users = [account("A"), account("B"), account("C"), account("D")];
    const room = new MatchRoom("room-reconnect", "123456", users[0]!, () => new Date(now));
    for (const user of users.slice(1)) room.join(user);
    for (const user of users) room.setReady(user.userId, true);
    room.start("A");

    room.disconnect("B");
    now += 120_000;
    room.reconnect("B");
    expect(room.players.get("B")).toMatchObject({ connected: true });

    room.disconnect("B");
    now += 120_001;
    expect(() => room.reconnect("B")).toThrow("RECONNECT_WINDOW_EXPIRED");
    expect(room.players.get("B")).toMatchObject({ connected: false });
  });
});


it("does not partially start a room while a later player's points are being saved", () => {
  const { room, users } = readyRoom();
  const release = reserveAccountWrite(users[3]!);
  expect(() => room.start("A")).toThrow("ACCOUNT_WRITE_PENDING");
  expect(room.status).toBe("waiting");
  expect(room.openingBalances.size).toBe(0);
  expect(users.every(user => user.activeMatchId === undefined)).toBe(true);
  expect([...room.players.values()].every(player => player.seat === undefined)).toBe(true);
  release();
  room.start("A");
  expect(room.status).toBe("playing");
});
