import { describe, expect, it } from "vitest";
import { MatchRoom, presenceOf, reserveAccountWrite, type RecordedRound, type UserAccount } from "./index.js";

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

function readyRoom(
  points = [600, 500, 500, 500],
  clock?: () => Date,
): { room: MatchRoom; users: UserAccount[] } {
  const users = [account("A", points[0]), account("B", points[1]), account("C", points[2]), account("D", points[3])];
  let joinedAt = 0;
  const room = new MatchRoom("room-1", "123456", users[0]!, clock ?? (() => new Date(joinedAt++)));
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

  it("大局结束后允许退出房间，且不会把 finished 房间降级成 dissolved", () => {
    // 修复的缺陷：打满 8 小场后 status = finished，旧判据 `status !== "waiting"`
    // 把它一并拦下 —— 玩家点「退出房间」报「开局之后不能退出房间」。
    // 禁止退出的核心条件是 `status === "playing"`，不是「不是 waiting」。
    const { room, users } = readyRoom();
    room.start("A");
    const round: RecordedRound = {
      reason: "three-winners",
      deltas: [
        { playerId: "A", delta: 12 },
        { playerId: "B", delta: -4 },
        { playerId: "C", delta: -4 },
        { playerId: "D", delta: -4 },
      ],
      winnerSeats: [0],
      nextDealerSeat: 1,
    };
    for (let index = 0; index < 8; index += 1) room.recordCompletedRound(round);
    expect(room.status).toBe("finished");
    expect(users.every((user) => user.activeMatchId === undefined)).toBe(true);

    expect(() => room.leave("D")).not.toThrow();
    expect(room.players.has("D")).toBe(false);

    // 人都走光也**保持 finished**：不能降级成 dissolved —— PostgresMatchRoom.leave
    // 只在 dissolved 时写 finished_at，降级等于把真实结算时刻顶掉。
    room.leave("A");
    room.leave("B");
    room.leave("C");
    expect(room.status).toBe("finished");
    expect(room.result?.reason).toBe("completed");
    expect(room.completedRounds).toBe(8);
  });

  it("解散后的房间也允许退出", () => {
    // 解散的等待房里人还在（requestDissolve 不清成员），
    // 房间已经不存在了，客户端必须能正常离开，不能被退出规则卡住。
    const { room } = readyRoom();
    room.requestDissolve("A");
    expect(room.status).toBe("dissolved");
    expect(() => room.leave("B")).not.toThrow();
    expect(room.players.has("B")).toBe(false);
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
    expect(room.reconnect("B")).toBe(false);
    expect(room.players.get("B")).toMatchObject({ connected: true, control: "human" });
  });

  it("窗口过期后把控制权交给服务器，但人依然能进来", () => {
    // 这是 2026-09-17 改过的语义：120 秒**不再是禁止重新进入的期限**。
    // 旧行为是抛 RECONNECT_WINDOW_EXPIRED，结果是"掉线超过 2 分钟的人再也回不到
    // 自己的座位，而座位会被继续代打到第 8 局" —— 与"座位保留到本场结束"直接冲突。
    let now = Date.parse("2026-09-15T00:00:00.000Z");
    const users = [account("A"), account("B"), account("C"), account("D")];
    const room = new MatchRoom("room-expire", "123456", users[0]!, () => new Date(now));
    for (const user of users.slice(1)) room.join(user);
    for (const user of users) room.setReady(user.userId, true);
    room.start("A");

    room.disconnect("B");
    now += 120_001;

    // 到期：控制权转给服务器（实时层负责落库与广播）
    expect(room.expireReconnectWindow("B")).toBe(true);
    expect(room.players.get("B")).toMatchObject({ control: "trustee", connected: false });
    // 幂等：再调一次没有变化
    expect(room.expireReconnectWindow("B")).toBe(false);

    // 第 4 局才回来也进得来：不再抛错，且**进来不等于接管**
    expect(room.reconnect("B")).toBe(false);
    expect(room.players.get("B")).toMatchObject({ connected: true, control: "trustee" });

    // 点「重新接管」才拿回人工控制权
    expect(room.resumeControl("B")).toBe(true);
    expect(room.players.get("B")).toMatchObject({ control: "human" });
    // 幂等：重复点不报错、返回 false
    expect(room.resumeControl("B")).toBe(false);
  });

  it("主动退出立刻托管，不删座位、不动手牌、不动积分", () => {
    const { room, users } = readyRoom();
    room.start("A");
    const before = {
      players: room.players.size,
      seats: [...room.players.values()].map((player) => player.seat),
      points: users.map((user) => user.points),
      activeMatchIds: users.map((user) => user.activeMatchId),
      opening: [...room.openingBalances.entries()],
    };

    expect(room.quitToTrustee("B")).toBe(true);

    expect(room.players.get("B")).toMatchObject({ control: "trustee" });
    expect(room.players.size).toBe(before.players);
    expect([...room.players.values()].map((player) => player.seat)).toEqual(before.seats);
    expect(users.map((user) => user.points)).toEqual(before.points);
    expect(users.map((user) => user.activeMatchId)).toEqual(before.activeMatchIds);
    expect([...room.openingBalances.entries()]).toEqual(before.opening);
    // 幂等
    expect(room.quitToTrustee("B")).toBe(false);
  });

  it("托管座位断了连接也不开 120 秒窗口（操作权本来就不在玩家手上）", () => {
    const { room } = readyRoom();
    room.start("A");
    room.quitToTrustee("B");
    room.disconnect("B");
    const player = room.players.get("B")!;
    expect(player.reconnectDeadline).toBeUndefined();
    expect(player.disconnectedAt).toBeUndefined();
  });

  it("暂离不等于断线：暂离免疫 120 秒窗口，不会被识别成托管", () => {
    // 需求三的禁止项：「返回大厅 → 被识别成托管」必须不成立。
    // 暂离的人**明确表示过**自己还在这一局，所以这一座永远不排保留期，
    // 只能由本人点「退出游戏」转托管。
    let now = Date.parse("2026-09-15T00:00:00.000Z");
    const { room } = readyRoom([600, 500, 500, 500], () => new Date(now));
    room.start("A");

    expect(room.markAway("B", true)).toBe(true);
    room.disconnect("B");
    const player = room.players.get("B")!;
    expect(player.away).toBe(true);
    // 暂离只是标签：控制权仍在玩家手上，回来不需要"重新接管"。
    expect(player.control).toBe("human");
    expect(presenceOf(player)).toBe("away");
    // **关键**：暂离不留 120 秒保留期
    expect(player.reconnectDeadline).toBeUndefined();
    expect(player.disconnectedAt).toBeUndefined();

    // 时间过去很久（远超 120 秒）也不会自动转托管
    now += 600_000;
    expect(room.expireReconnectWindow("B")).toBe(false);
    expect(player.control).toBe("human");
    expect(presenceOf(player)).toBe("away");

    // 回来：直接恢复人工操作，暂离标识消失
    expect(room.reconnect("B")).toBe(false);
    room.markAway("B", false);
    expect(presenceOf(room.players.get("B")!)).toBe("online");
    expect(room.players.get("B")).toMatchObject({ control: "human" });
  });

  it("markAway 幂等：重复标记同一状态返回 false（调用方据此决定要不要广播）", () => {
    const { room } = readyRoom();
    room.start("A");

    expect(room.markAway("B", true)).toBe(true);
    expect(room.markAway("B", true)).toBe(false);
    expect(room.markAway("B", false)).toBe(true);
    expect(room.markAway("B", false)).toBe(false);
  });

  it("整房按墙钟结算：只转真正过期的那一座，且幂等", () => {
    // 判据是**绝对时刻**，所以"停机期间"照样流逝：这里用推进时钟来模拟。
    let now = Date.parse("2026-09-15T00:00:00.000Z");
    const { room } = readyRoom([600, 500, 500, 500], () => new Date(now));
    room.start("A");

    room.disconnect("B"); // 保护期到 00:02:00
    room.quitToTrustee("C"); // 主动退出：没有保护期
    room.markAway("D", true);
    room.disconnect("D"); // 暂离：不排保护期

    // 还没到点 ⇒ 谁都不转
    expect(room.expireOverdueControl()).toEqual([]);
    expect(room.players.get("B")).toMatchObject({ control: "human" });

    // 到点了 ⇒ 只有 B
    now += 120_001;
    expect(room.expireOverdueControl()).toEqual(["B"]);
    expect(room.players.get("B")).toMatchObject({ control: "trustee" });
    expect(room.players.get("B")!.reconnectDeadline).toBeUndefined();
    // 已经托管的 C、暂离中的 D 都不受影响
    expect(room.players.get("C")).toMatchObject({ control: "trustee" });
    expect(room.players.get("D")).toMatchObject({ control: "human", away: true });

    // 幂等：再判一次什么都不发生（timer / auth / load 多入口不会重复动作）
    expect(room.expireOverdueControl()).toEqual([]);
  });

  it("在场状态是三个维度推出来的，不是单独存的字段", () => {
    const { room } = readyRoom();
    room.start("A");
    const player = room.players.get("B")!;

    expect(presenceOf(player)).toBe("online");
    player.connected = false;
    expect(presenceOf(player)).toBe("disconnected");
    player.away = true;
    expect(presenceOf(player)).toBe("away");
    // 托管优先于暂离与断线：座位上服务器在打，别人该看到的就是"托管"
    player.control = "trustee";
    expect(presenceOf(player)).toBe("trustee");
  });

  it("大局结算时把托管与暂离关系一并作废", () => {
    // 需求七：第 8 小局结束、大局结算之后，不能再"重新接管"一个已结束的大局。
    // 房间对象还在内存里，不清就会带着 trustee 残留。
    const { room } = readyRoom();
    room.start("A");
    room.quitToTrustee("B");
    room.markAway("C", true);
    const round: RecordedRound = {
      reason: "three-winners",
      deltas: [
        { playerId: "A", delta: -100 },
        { playerId: "B", delta: 100 },
      ],
      winnerSeats: [1],
      nextDealerSeat: 1,
    };
    for (let index = 0; index < 7; index += 1) room.recordCompletedRound(round);
    expect(room.recordCompletedRound(round)?.reason).toBe("completed");

    for (const player of room.players.values()) {
      expect(player.control).toBe("human");
      expect(player.away).toBe(false);
      expect(player.controlChangedAt).toBeUndefined();
    }
    // 已结束的房间不接受接管（幂等返回 false，不抛错）
    expect(room.resumeControl("B")).toBe(false);
    expect(() => room.quitToTrustee("B")).toThrow("not playing");
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
