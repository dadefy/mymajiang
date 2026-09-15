import { describe, expect, it } from "vitest";
import { FriendService, GroupService } from "@mianyang-mahjong/domain";
import { TokenService } from "./auth.js";
import { createApp, createInMemoryDependencies } from "./app.js";
import { CryptoInvitationKeyCodec } from "./invitation-key-codec.js";
import type { MatchHistoryReader, MatchRoundRecord, MatchSummary } from "./match-history.js";

let idCounter = 1234567890;

function fixture(overrides: {
  friendService?: FriendService;
  groupService?: GroupService;
  matchHistory?: MatchHistoryReader;
} = {}) {
  idCounter = 1234567890;
  const tokens = new TokenService("test-jwt-secret-that-is-longer-than-32-characters");
  const dependencies = createInMemoryDependencies({
    tokens,
    // 用真实实现：密钥的生成、归一化与哈希本身就是被测对象的一部分。
    invitationKeyCodec: new CryptoInvitationKeyCodec(),
    createKeyId: () => `key-${idCounter++}`,
    createUserId: () => String(idCounter++),
    createLedgerId: () => `ledger-${idCounter}`,
    createRoomId: () => `room-${idCounter}`,
    createGroupId: () => `group-${idCounter}`,
    createGroupNo: () => "12345678",
    createMessageId: () => `message-${idCounter++}`,
    createFriendRequestId: () => `friend-request-${idCounter++}`,
    createAdminAuditId: () => `audit-${idCounter++}`,
    ...(overrides.friendService ? { friendService: overrides.friendService } : {}),
    ...(overrides.groupService ? { groupService: overrides.groupService } : {}),
    ...(overrides.matchHistory ? { matchHistory: overrides.matchHistory } : {}),
  });
  return { app: createApp(dependencies), dependencies, tokens };
}

/** 用开发方签发的密钥激活一个账号：走的是真实的内测入口。 */
async function createBetaUser(
  app: ReturnType<typeof createApp>,
  dependencies: ReturnType<typeof fixture>["dependencies"],
  nickname: string,
): Promise<{ userId: string; token: string }> {
  const key = dependencies.invitationKeys.issue({ count: 1, note: nickname, actorId: "developer" })[0]!.key;
  const account = dependencies.accountService.activateWithKey({
    key,
    nickname,
    avatarUrl: "https://example.invalid/avatar.png",
  });
  const adminToken = await dependencies.tokens.issueAdminToken("developer", "super_admin");
  await app.inject({
    method: "POST",
    url: `/v1/admin/users/${account.userId}/points`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { delta: 1000, reason: "测试发放" },
  });
  return { userId: account.userId, token: await dependencies.tokens.issueUserToken(account.userId) };
}

describe("server API", () => {
  it("reports health", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("serves the administrator console with restrictive browser headers", async () => {
    const { app } = fixture();
    const response = await app.inject({ method: "GET", url: "/admin" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.body).toContain("绵阳麻将管理后台");
    expect(response.body).toContain("/v1/admin/invitation-keys");
    expect(response.body).toContain("/v1/admin/audit-log");
  });

  it("reports database health when persistence is configured", async () => {
    const healthy = fixture();
    healthy.dependencies.database = { async ping() {} };
    const connected = await healthy.app.inject({ method: "GET", url: "/health" });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toEqual({ status: "ok", database: "connected" });

    const unhealthy = fixture();
    unhealthy.dependencies.database = { async ping() { throw new Error("offline"); } };
    const unavailable = await unhealthy.app.inject({ method: "GET", url: "/health" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: "degraded", database: "unavailable" });
  });

  it("签发密钥 → 首次激活建号 → 之后凭同一把密钥登录", async () => {
    const { app, tokens } = fixture();
    const adminToken = await tokens.issueAdminToken("developer", "super_admin");

    const issued = await app.inject({
      method: "POST",
      url: "/v1/admin/invitation-keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { count: 1, note: "给张三" },
    });
    expect(issued.statusCode).toBe(201);
    const key = issued.json().keys[0].key as string;
    expect(key.startsWith("MYMJ-")).toBe(true);

    // 第一次用：还没建号，登录会要求先补资料。
    const early = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { key } });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ code: "KEY_ACTIVATION_REQUIRED" });

    const activated = await app.inject({
      method: "POST",
      url: "/v1/auth/activate",
      payload: { key, nickname: "张三", avatarUrl: "https://example.invalid/a.png" },
    });
    expect(activated.statusCode).toBe(201);
    const session = activated.json();
    expect(session).toMatchObject({ nickname: "张三", status: "active", points: 0 });
    expect(session.token).toBeTruthy();

    // 之后再登录：同一把密钥就是凭据。
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { key } });
    expect(login.statusCode).toBe(200);
    expect(login.json().userId).toBe(session.userId);

    // 管理员能查到密钥状态，但明文不出网。
    const adminKeys = await app.inject({
      method: "GET",
      url: "/v1/admin/invitation-keys",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminKeys.json().keys).toHaveLength(1);
    expect(adminKeys.json().keys[0]).toMatchObject({
      keyHint: key.replace(/-/g, "").slice(0, 8),
      activated: true,
      note: "给张三",
    });
    expect(JSON.stringify(adminKeys.json())).not.toContain(key);
  });

  it("已用过的密钥不能激活第二个账号，撤销的密钥不能登录", async () => {
    const { app, tokens } = fixture();
    const adminToken = await tokens.issueAdminToken("developer", "super_admin");
    const issued = await app.inject({
      method: "POST",
      url: "/v1/admin/invitation-keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { count: 2, note: "" },
    });
    const used = issued.json().keys[0] as { keyId: string; key: string };
    const fresh = issued.json().keys[1] as { keyId: string; key: string };

    await app.inject({
      method: "POST",
      url: "/v1/auth/activate",
      payload: { key: used.key, nickname: "张三", avatarUrl: "a" },
    });
    const reuse = await app.inject({
      method: "POST",
      url: "/v1/auth/activate",
      payload: { key: used.key, nickname: "李四", avatarUrl: "b" },
    });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().message).toBe("KEY_ALREADY_ACTIVATED");

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/admin/invitation-keys/${fresh.keyId}/revoke`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revoked.statusCode).toBe(204);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { key: fresh.key } });
    expect(login.statusCode).toBe(401);
    expect(login.json()).toEqual({ code: "KEY_REVOKED" });

    // 已绑定的密钥不能再撤销：那是该账号唯一的凭据。
    const locked = await app.inject({
      method: "POST",
      url: `/v1/admin/invitation-keys/${used.keyId}/revoke`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().message).toBe("KEY_ALREADY_ACTIVATED");
  });

  it("密钥不存在或格式不对时给出明确错误", async () => {
    const { app, tokens } = fixture();
    const adminToken = await tokens.issueAdminToken("developer", "super_admin");
    await app.inject({
      method: "POST",
      url: "/v1/admin/invitation-keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { count: 1, note: "" },
    });

    const malformed = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { key: "不是密钥" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "KEY_MALFORMED" });

    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { key: "MYMJ-0000-0000-0000-0000" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ code: "KEY_INVALID" });
  });

  it("只有超级管理员能签发与查看密钥", async () => {
    const { app, tokens } = fixture();
    const reviewerToken = await tokens.issueAdminToken("reviewer", "review_admin");
    const refused = await app.inject({
      method: "POST",
      url: "/v1/admin/invitation-keys",
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { count: 1, note: "" },
    });
    expect(refused.statusCode).toBe(403);
  });

  it("allows only a super administrator to grant points", async () => {
    const { app, dependencies, tokens } = fixture();
    const account = dependencies.accountService.createAccount({ nickname: "用户", avatarUrl: "avatar" });
    const reviewerToken = await tokens.issueAdminToken("reviewer", "review_admin");
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${account.userId}/points`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { delta: 500, reason: "发放" },
    });
    expect(forbidden.statusCode).toBe(403);

    const adminToken = await tokens.issueAdminToken("developer", "super_admin");
    const granted = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${account.userId}/points`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { delta: 500, reason: "审核后发放" },
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json()).toMatchObject({ delta: 500, balanceBefore: 0, balanceAfter: 500 });
  });

  it("supports administrator user moderation, audit and point reversal", async () => {
    const { app, dependencies, tokens } = fixture();
    const user = await createBetaUser(app, dependencies, "受管用户");
    const adminToken = await tokens.issueAdminToken("developer", "super_admin");

    const users = await app.inject({
      method: "GET",
      url: `/v1/admin/users?query=${user.userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(users.statusCode).toBe(200);
    expect(users.json().users).toHaveLength(1);

    const banned = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${user.userId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "temporarily_banned", reason: "测试封禁" },
    });
    expect(banned.json()).toMatchObject({
      user: { status: "temporarily_banned" },
      audit: { before: "active", after: "temporarily_banned", reason: "测试封禁" },
    });

    const audit = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(audit.json().entries).toHaveLength(1);

    const points = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${user.userId}/points`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(points.json()).toMatchObject({ userId: user.userId, balance: 1000 });
    const ledgerId = points.json().entries[0].ledgerId as string;

    const reversed = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${user.userId}/points/${ledgerId}/reverse`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: "撤销测试发放" },
    });
    expect(reversed.statusCode).toBe(201);
    expect(reversed.json()).toMatchObject({ delta: -1000, balanceAfter: 0, reversalOf: ledgerId });
  });

  it("routes administrator mutations through the durable admin store", async () => {
    const { app, dependencies, tokens } = fixture();
    const user = await createBetaUser(app, dependencies, "持久化用户");
    const adminToken = await tokens.issueAdminToken("developer", "super_admin");

    const ledgerCommits: Array<{ userId: string; delta: number; balanceAfter: number }> = [];
    const auditCommits: Array<{ userId: string; after: string }> = [];
    dependencies.adminStore = {
      ledgerEntries: [],
      auditEntries: [],
      commitPointAdjustment: (commitAccount, entry) => {
        ledgerCommits.push({ userId: commitAccount.userId, delta: entry.delta, balanceAfter: entry.balanceAfter });
      },
      commitAccountStatusChange: (commitAccount, entry) => {
        auditCommits.push({ userId: commitAccount.userId, after: entry.after });
      },
      flush: async () => {},
    };

    const granted = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${user.userId}/points`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { delta: 500, reason: "持久化发放" },
    });
    expect(granted.statusCode).toBe(201);
    expect(ledgerCommits).toEqual([{ userId: user.userId, delta: 500, balanceAfter: 1500 }]);

    const banned = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${user.userId}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "temporarily_banned", reason: "持久化封禁" },
    });
    expect(banned.statusCode).toBe(200);
    expect(auditCommits).toEqual([{ userId: user.userId, after: "temporarily_banned" }]);

    // The admin store owns the account row, yet the live account still reports the new balance.
    const points = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${user.userId}/points`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(points.json()).toMatchObject({ balance: 1500 });
  });

  it("drives friends and groups through the injected social services", async () => {
    let friendSequence = 0;
    let groupSequence = 0;
    const friendService = new FriendService(() => `friend-${++friendSequence}`);
    const groupService = new GroupService(
      () => `group-${++groupSequence}`,
      () => "87654321",
      () => `message-${++groupSequence}`,
    );
    const { app, dependencies, tokens } = fixture({ friendService, groupService });

    // The API must reach whichever service the composition root installed, durable or not.
    expect(dependencies.friendService).toBe(friendService);
    expect(dependencies.groupService).toBe(groupService);

    const first = await createBetaUser(app, dependencies, "社交甲");
    const second = await createBetaUser(app, dependencies, "社交乙");

    const sent = await app.inject({
      method: "POST",
      url: "/v1/friends/requests",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { targetUserId: second.userId },
    });
    expect(sent.statusCode).toBe(201);
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/friends/requests/${sent.json().requestId}/respond`,
      headers: { authorization: `Bearer ${second.token}` },
      payload: { accept: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(friendService.friendIds(first.userId)).toEqual([second.userId]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { name: "持久化群" },
    });
    expect(created.statusCode).toBe(201);
    expect(groupService.groups.get(created.json().groupId)).toMatchObject({
      name: "持久化群",
      ownerId: first.userId,
    });
  });

  it("says match history needs a database instead of pretending it is empty", async () => {
    const { app, dependencies, tokens } = fixture();
    const user = await createBetaUser(app, dependencies, "无库用户");

    const listed = await app.inject({
      method: "GET",
      url: "/v1/matches",
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(listed.statusCode).toBe(501);
    expect(listed.json()).toEqual({ code: "MATCH_HISTORY_UNAVAILABLE" });
  });

  it("serves a player's match history and a match's round detail", async () => {
    const state: { matches: MatchSummary[] } = { matches: [] };
    const requested: Array<{ userId: string; limit: number }> = [];
    const rounds: MatchRoundRecord[] = [
      {
        roundId: "round-1",
        roundNumber: 1,
        finishReason: "three-winners",
        winnerSeats: [1],
        nextDealerSeat: 1,
        deltas: [
          { playerId: "player-a", delta: -100 },
          { playerId: "player-b", delta: 100 },
        ],
        events: [{ eventId: "event-1", type: "win", payer: "player-a", payee: "player-b", points: 100, note: "点炮" }],
        finishedAt: new Date("2026-09-15T00:30:00.000Z"),
      },
    ];
    const history: MatchHistoryReader = {
      async listMatchesFor(userId, limit) {
        requested.push({ userId, limit });
        return state.matches;
      },
      async findMatch(roomId) {
        return state.matches.find((match) => match.roomId === roomId);
      },
      async listRounds() {
        return rounds;
      },
    };
    const { app, dependencies, tokens } = fixture({ matchHistory: history });
    const first = await createBetaUser(app, dependencies, "战绩甲");
    const second = await createBetaUser(app, dependencies, "战绩乙");
    const outsider = await createBetaUser(app, dependencies, "旁观者");
    state.matches = [
      {
        roomId: "room-1",
        ruleVersion: "MIANYANG_XZ_1_0",
        status: "finished",
        completedRounds: 8,
        finalReason: "completed",
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
        finalizedAt: new Date("2026-09-15T01:00:00.000Z"),
        players: [
          { userId: first.userId, seat: 0, rawDelta: -800, accountDelta: -600 },
          { userId: second.userId, seat: 1, rawDelta: 800, accountDelta: 600 },
        ],
      },
    ];

    const listed = await app.inject({
      method: "GET",
      url: "/v1/matches?limit=5",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(requested).toEqual([{ userId: first.userId, limit: 5 }]);
    expect(listed.json().matches).toHaveLength(1);
    expect(listed.json().matches[0]).toMatchObject({
      roomId: "room-1",
      status: "finished",
      completedRounds: 8,
      finalReason: "completed",
      me: { userId: first.userId, seat: 0, rawDelta: -800, accountDelta: -600 },
    });
    // Nicknames come from the account store, so the client does not have to resolve user IDs.
    expect(listed.json().matches[0].players).toEqual([
      { userId: first.userId, nickname: "战绩甲", seat: 0, rawDelta: -800, accountDelta: -600 },
      { userId: second.userId, nickname: "战绩乙", seat: 1, rawDelta: 800, accountDelta: 600 },
    ]);

    const detail = await app.inject({
      method: "GET",
      url: "/v1/rooms/room-1/history",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().match.me).toMatchObject({ userId: second.userId, accountDelta: 600 });
    expect(detail.json().rounds).toEqual([
      {
        roundId: "round-1",
        roundNumber: 1,
        finishReason: "three-winners",
        winnerSeats: [1],
        nextDealerSeat: 1,
        deltas: [
          { playerId: "player-a", delta: -100 },
          { playerId: "player-b", delta: 100 },
        ],
        events: [
          { eventId: "event-1", type: "win", payer: "player-a", payee: "player-b", points: 100, note: "点炮" },
        ],
        finishedAt: "2026-09-15T00:30:00.000Z",
      },
    ]);

    const forbidden = await app.inject({
      method: "GET",
      url: "/v1/rooms/room-1/history",
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ code: "MATCH_HISTORY_FORBIDDEN" });

    const missing = await app.inject({
      method: "GET",
      url: "/v1/rooms/room-missing/history",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("bans an account out of login but not out of activation", async () => {
    const { app, dependencies } = fixture();
    const key = dependencies.invitationKeys.issue({ count: 1, note: "", actorId: "developer" })[0]!.key;
    const account = dependencies.accountService.activateWithKey({
      key,
      nickname: "手机用户",
      avatarUrl: "avatar",
    });

    // 被封号的账号不能凭密钥登录。
    account.status = "temporarily_banned";
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { key } });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toEqual({ code: "ACCOUNT_NOT_ACTIVE" });

    // 解封之后同一把密钥又能登录了。
    account.status = "active";
    const back = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { key } });
    expect(back.statusCode).toBe(200);
    expect(back.json().userId).toBe(account.userId);
  });

  it("rejects API access and login for a banned account", async () => {
    const { app, dependencies, tokens } = fixture();
    const user = await createBetaUser(app, dependencies, "封禁用户");
    const account = dependencies.accountStore.findAccountById(user.userId)!;
    account.status = "temporarily_banned";

    const protectedResponse = await app.inject({
      method: "POST",
      url: "/v1/rooms",
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(protectedResponse.statusCode).toBe(403);
    expect(protectedResponse.json()).toEqual({ code: "ACCOUNT_NOT_ACTIVE" });
  });

  it("runs the room lifecycle from creation to start", async () => {
    const { app, dependencies, tokens } = fixture();
    const players = [];
    for (const nickname of ["甲", "乙", "丙", "丁"]) {
      players.push(await createBetaUser(app, dependencies, nickname));
    }

    const created = await app.inject({
      method: "POST",
      url: "/v1/rooms",
      headers: { authorization: `Bearer ${players[0]!.token}` },
    });
    expect(created.statusCode).toBe(201);
    const roomId = created.json().roomId as string;

    for (const player of players.slice(1)) {
      const joined = await app.inject({
        method: "POST",
        url: `/v1/rooms/${roomId}/join`,
        headers: { authorization: `Bearer ${player.token}` },
      });
      expect(joined.statusCode).toBe(201);
    }

    const outsider = await createBetaUser(app, dependencies, "外人");
    const joinByOutsider = await app.inject({
      method: "POST",
      url: `/v1/rooms/${roomId}/join`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(joinByOutsider.statusCode).toBe(409);

    const outsiderView = await app.inject({
      method: "GET",
      url: `/v1/rooms/${roomId}`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(outsiderView.statusCode).toBe(409);

    for (const player of players) {
      const ready = await app.inject({
        method: "POST",
        url: `/v1/rooms/${roomId}/ready`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { ready: true },
      });
      expect(ready.statusCode).toBe(200);
    }

    const notOwner = await app.inject({
      method: "POST",
      url: `/v1/rooms/${roomId}/start`,
      headers: { authorization: `Bearer ${players[1]!.token}` },
    });
    expect(notOwner.statusCode).toBe(409);

    const started = await app.inject({
      method: "POST",
      url: `/v1/rooms/${roomId}/start`,
      headers: { authorization: `Bearer ${players[0]!.token}` },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: "playing", completedRounds: 0 });

    const snapshot = await app.inject({
      method: "GET",
      url: `/v1/rooms/${roomId}`,
      headers: { authorization: `Bearer ${players[0]!.token}` },
    });
    expect(snapshot.statusCode).toBe(200);
    const body = snapshot.json();
    expect(body.players).toHaveLength(4);
    expect(body.players.map((entry: { nickname: string }) => entry.nickname)).toEqual(["甲", "乙", "丙", "丁"]);
  });

  it("finds users by exact ID and completes the friend workflow", async () => {
    const { app, dependencies, tokens } = fixture();
    const first = await createBetaUser(app, dependencies, "好友甲");
    const second = await createBetaUser(app, dependencies, "好友乙");

    const search = await app.inject({
      method: "GET",
      url: `/v1/users/${second.userId}`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({ userId: second.userId, nickname: "好友乙", relationship: "none" });
    expect(search.json()).not.toHaveProperty("invitationKeyHash");
    expect(search.json()).not.toHaveProperty("points");

    const sent = await app.inject({
      method: "POST",
      url: "/v1/friends/requests",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { targetUserId: second.userId },
    });
    expect(sent.statusCode).toBe(201);
    const requestId = sent.json().requestId as string;

    const incoming = await app.inject({
      method: "GET",
      url: "/v1/friends/requests",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(incoming.json().requests).toHaveLength(1);
    expect(incoming.json().requests[0]).toMatchObject({ requester: { userId: first.userId, nickname: "好友甲" } });

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/friends/requests/${requestId}/respond`,
      headers: { authorization: `Bearer ${second.token}` },
      payload: { accept: true },
    });
    expect(accepted.json()).toMatchObject({ status: "accepted" });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/friends",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(listed.json().friends).toEqual([
      { userId: second.userId, nickname: "好友乙", avatarUrl: "https://example.invalid/avatar.png" },
    ]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/friends/${second.userId}`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(removed.statusCode).toBe(204);
  });

  it("supports group creation, messaging and recall", async () => {
    const { app, dependencies, tokens } = fixture();
    const owner = await createBetaUser(app, dependencies, "群主");
    const member = await createBetaUser(app, dependencies, "群员");

    const created = await app.inject({
      method: "POST",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: "牌友群" },
    });
    expect(created.statusCode).toBe(201);
    const group = created.json();
    expect(group.groupNo).toBe("12345678");

    const joined = await app.inject({
      method: "POST",
      url: "/v1/groups/join",
      headers: { authorization: `Bearer ${member.token}` },
      payload: { groupNo: group.groupNo },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ memberCount: 2 });

    const sent = await app.inject({
      method: "POST",
      url: `/v1/groups/${group.groupId}/messages`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: { type: "text", content: "晚上开一桌？" },
    });
    expect(sent.statusCode).toBe(201);
    const messageId = sent.json().messageId as string;

    const listed = await app.inject({
      method: "GET",
      url: `/v1/groups/${group.groupId}/messages`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().messages).toHaveLength(1);

    const recalled = await app.inject({
      method: "POST",
      url: `/v1/groups/${group.groupId}/messages/${messageId}/recall`,
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(recalled.statusCode).toBe(200);
    expect(recalled.json().content).toBe("[消息已撤回]");

    const outsider = await createBetaUser(app, dependencies, "路人");
    const forbidden = await app.inject({
      method: "GET",
      url: `/v1/groups/${group.groupId}/messages`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(forbidden.statusCode).toBe(409);
  });

  it("supports group listing, inviting friends, leaving and dissolving", async () => {
    const { app, dependencies, tokens } = fixture();
    const owner = await createBetaUser(app, dependencies, "群主甲");
    const friend = await createBetaUser(app, dependencies, "好友乙");
    const stranger = await createBetaUser(app, dependencies, "路人丙");

    // 先成为好友：好友发起申请，群主接受。
    const request = await app.inject({
      method: "POST",
      url: "/v1/friends/requests",
      headers: { authorization: `Bearer ${friend.token}` },
      payload: { targetUserId: owner.userId },
    });
    await app.inject({
      method: "POST",
      url: `/v1/friends/requests/${request.json().requestId}/respond`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { accept: true },
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: "牌友群" },
    });
    const groupId = created.json().groupId as string;

    // 不是好友不能邀请。
    const refused = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/invite`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { userId: stranger.userId },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe("Only friends can be invited");

    const invited = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/invite`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { userId: friend.userId },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json()).toMatchObject({ userId: friend.userId, role: "member", memberCount: 2 });

    // 群列表只返回自己加入的群，并带上自己的角色。
    const mine = await app.inject({
      method: "GET",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${friend.token}` },
    });
    expect(mine.json().groups).toEqual([
      expect.objectContaining({ groupId, memberCount: 2, role: "member", ownerId: owner.userId, lastMessageAt: null }),
    ]);
    const theirs = await app.inject({
      method: "GET",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(theirs.json().groups).toEqual([]);

    // 只有群主能解散。
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/dissolve`,
      headers: { authorization: `Bearer ${friend.token}` },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().message).toBe("Only the group owner can dissolve a group");

    // 成员主动退群：群还在，群主不变。
    const left = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/leave`,
      headers: { authorization: `Bearer ${friend.token}` },
    });
    expect(left.json()).toMatchObject({ dissolved: false, ownerId: owner.userId, memberCount: 1 });

    const dissolved = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/dissolve`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(dissolved.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(after.json().groups).toEqual([]);
  });

  it("dissolves a group once its last member leaves", async () => {
    const { app, dependencies, tokens } = fixture();
    const owner = await createBetaUser(app, dependencies, "独守群主");

    const created = await app.inject({
      method: "POST",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: "空群" },
    });
    const groupId = created.json().groupId as string;

    const left = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/leave`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(left.statusCode).toBe(200);
    expect(left.json()).toEqual({ groupId, dissolved: true });
  });
});
