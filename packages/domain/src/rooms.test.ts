import { describe, expect, it } from "vitest";
import { MatchRoom, type RecordedRound, type UserAccount } from "./index.js";

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
  const room = new MatchRoom("room-1", users[0]!, () => new Date(joinedAt++));
  room.join(users[1]!);
  room.join(users[2]!);
  room.join(users[3]!);
  for (const user of users) room.setReady(user.userId, true);
  return { room, users };
}

describe("match room", () => {
  it("requires an active account with at least 500 points", () => {
    expect(() => new MatchRoom("room-1", account("A", 499))).toThrow("at least 500 points");
    const banned = account("B", 500);
    banned.status = "temporarily_banned";
    expect(() => new MatchRoom("room-2", banned)).toThrow("Active account");
  });

  it("requires four ready players and only allows the owner to start", () => {
    const { room } = readyRoom();
    expect(() => room.start("B")).toThrow("Only the room owner");
    room.setReady("D", false);
    expect(() => room.start("A")).toThrow("All players must be ready");
    room.setReady("D", true);
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
    expect(() => new MatchRoom("room-1", player)).toThrow("Active account");
    expect(new MatchRoom("room-1", player, () => new Date(0), "restore").ownerId).toBe("B");
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
    const room = new MatchRoom("room-reconnect", users[0]!, () => new Date(now));
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
