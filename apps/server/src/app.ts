import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AccountService,
  AccountAdministrationService,
  FriendService,
  GroupService,
  InMemoryAccountStore,
  InMemoryInvitationKeyStore,
  InvitationKeyService,
  MatchRoom,
  PointService,
  type AccountStore,
  type ChatGroup,
  type InvitationKey,
  type InvitationKeyCodec,
  type InvitationKeyStore,
  type StoredGroupMessage,
  type UserAccount,
} from "@mianyang-mahjong/domain";
import { TokenService, bearerToken } from "./auth.js";
import { adminConsoleHtml } from "./admin-console.js";
import type { AdminStore } from "./admin-store.js";
import type { GameStateStore } from "./game-state-store.js";
import { InMemoryGroupEventBus, type GroupEventBus, type GroupMessageView } from "./group-events.js";
import type { MatchHistoryReader, MatchRoundRecord, MatchSummary } from "./match-history.js";

export interface AppDependencies {
  accountStore: AccountStore;
  accountService: AccountService;
  accountAdministration: AccountAdministrationService;
  pointService: PointService;
  /** 内测入口：开发方签发的一次性邀请密钥。 */
  invitationKeys: InvitationKeyService;
  tokens: TokenService;
  roomStore: Map<string, MatchRoom>;
  groupService: GroupService;
  friendService: FriendService;
  /** 把群聊变化推给实时层；路由层只管写成功之后广播一次。 */
  groupEvents: GroupEventBus;
  database?: { ping(): Promise<void> };
  /** When present, owns balance/status writes so they commit with their ledger or audit row. */
  adminStore?: AdminStore;
  createRoomId: () => string;
  /** When present, rooms record themselves as they are created and mutated. */
  createRoom?: (roomId: string, owner: UserAccount) => MatchRoom;
  /** Reads finished matches back. Only available when the server has a database. */
  matchHistory?: MatchHistoryReader;
  /** Stores the round in flight so a restart can carry on. Only with a database. */
  gameStateStore?: GameStateStore;
}

/** 一次激活成功的返回：与登录同一份会话信息，客户端两条路径可以共用解析逻辑。 */
function sessionView(account: UserAccount) {
  return {
    userId: account.userId,
    nickname: account.nickname,
    avatarUrl: account.avatarUrl,
    status: account.status,
    points: account.points,
  };
}

function invitationKeyView(key: InvitationKey, activated: boolean) {
  return {
    keyId: key.keyId,
    keyHint: key.keyHint,
    note: key.note,
    createdBy: key.createdBy,
    createdAt: key.createdAt,
    activated,
    revokedAt: key.revokedAt ?? null,
  };
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && reply.statusCode < 400) {
      await dependencies.accountStore.flush?.();
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ code: "INVALID_INPUT", issues: error.issues });
    const code = error instanceof Error ? error.message : String(error);
    if (code === "AUTH_REQUIRED" || code.startsWith("INVALID_ADMIN_TOKEN") || code.startsWith("INVALID_USER_TOKEN")) {
      return reply.status(401).send({ code });
    }
    // 密钥格式不对是客户端问题；密钥不存在或已撤销等同于认证失败。
    if (code === "KEY_MALFORMED") return reply.status(400).send({ code });
    if (code === "KEY_INVALID" || code === "KEY_REVOKED") return reply.status(401).send({ code });
    if (code.endsWith("_NOT_FOUND") || code === "User not found") {
      return reply.status(404).send({ code: "NOT_FOUND", message: code });
    }
    if (code.includes("Only super administrators")) return reply.status(403).send({ code: "FORBIDDEN" });
    if (code === "ACCOUNT_NOT_ACTIVE") return reply.status(403).send({ code });
    if (code === "MATCH_HISTORY_FORBIDDEN") return reply.status(403).send({ code });
    // History is a persistence feature; without a database there is nothing to read.
    if (code === "MATCH_HISTORY_UNAVAILABLE") return reply.status(501).send({ code });
    // 密钥有效但还没建过账号：客户端要据此决定下一步是收昵称头像。
    if (code === "KEY_ACTIVATION_REQUIRED") return reply.status(409).send({ code });
    return reply.status(409).send({ code: "DOMAIN_CONFLICT", message: code });
  });

  app.get("/health", async (_request, reply) => {
    if (!dependencies.database) return { status: "ok" };
    try {
      await dependencies.database.ping();
      return { status: "ok", database: "connected" };
    } catch {
      return reply.status(503).send({ status: "degraded", database: "unavailable" });
    }
  });

  app.get("/admin", async (_request, reply) => reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
    .header("X-Frame-Options", "DENY")
    .type("text/html; charset=utf-8")
    .send(adminConsoleHtml()));

  app.post("/v1/auth/activate", async (request, reply) => {
    const body = z.object({
      key: z.string().min(1),
      nickname: z.string().trim().min(1).max(24),
      avatarUrl: z.string().trim().min(1).max(500),
    }).parse(request.body);
    const account = dependencies.accountService.activateWithKey(body);
    return reply.status(201).send({
      ...sessionView(account),
      token: await dependencies.tokens.issueUserToken(account.userId),
    });
  });

  app.post("/v1/auth/login", async (request) => {
    const body = z.object({ key: z.string().min(1) }).parse(request.body);
    const record = dependencies.invitationKeys.resolve(body.key);
    const account = dependencies.accountStore.findAccountByInvitationKeyHash(record.keyHash);
    // 密钥有效但还没建过账号：客户端应该先收昵称头像，再来激活。
    if (!account) throw new Error("KEY_ACTIVATION_REQUIRED");
    if (account.status !== "active") throw new Error("ACCOUNT_NOT_ACTIVE");
    return {
      ...sessionView(account),
      token: await dependencies.tokens.issueUserToken(account.userId),
    };
  });

  app.get("/v1/admin/invitation-keys", async (request) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    requireSuperAdmin(admin);
    const keys = dependencies.invitationKeys.list().map((key) =>
      invitationKeyView(key, Boolean(dependencies.accountStore.findAccountByInvitationKeyHash(key.keyHash))),
    );
    return { keys };
  });

  app.post("/v1/admin/invitation-keys", async (request, reply) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    requireSuperAdmin(admin);
    const body = z.object({
      count: z.number().int().min(1).max(100).default(1),
      note: z.string().trim().max(100).default(""),
    }).parse(request.body ?? {});
    const issued = dependencies.invitationKeys.issue({ ...body, actorId: admin.adminId });
    // 明文只在这里返回一次，之后系统里只剩哈希。
    return reply.status(201).send({ keys: issued.map((key) => ({ keyId: key.keyId, key: key.key, note: key.note })) });
  });

  app.post("/v1/admin/invitation-keys/:keyId/revoke", async (request, reply) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    requireSuperAdmin(admin);
    const params = z.object({ keyId: z.string().min(1) }).parse(request.params);
    const key = dependencies.invitationKeys.list().find((candidate) => candidate.keyId === params.keyId);
    if (!key) throw new Error("KEY_NOT_FOUND");
    const activated = Boolean(dependencies.accountStore.findAccountByInvitationKeyHash(key.keyHash));
    dependencies.invitationKeys.revoke(params.keyId, admin.adminId, activated);
    return reply.status(204).send();
  });

  app.get("/v1/admin/users", async (request) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    requireSuperAdmin(admin);
    const query = z.object({
      status: z.enum(["active", "temporarily_banned", "permanently_banned"]).optional(),
      query: z.string().trim().max(24).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    const normalizedQuery = query.query?.toLocaleLowerCase();
    const users = dependencies.accountStore.listAccounts()
      .filter((account) => !query.status || account.status === query.status)
      .filter((account) => !normalizedQuery || account.userId === normalizedQuery || account.nickname.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, query.limit)
      .map(adminAccountView);
    return { users };
  });

  app.patch("/v1/admin/users/:userId/status", async (request) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    const params = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const body = z.object({
      status: z.enum(["active", "temporarily_banned", "permanently_banned"]),
      reason: z.string().trim().min(1).max(200),
    }).parse(request.body);
    const account = dependencies.accountStore.findAccountById(params.userId);
    if (!account) throw new Error("USER_NOT_FOUND");
    const audit = dependencies.accountAdministration.changeStatus(account, admin, body.status, body.reason);
    commitAdminMutation(dependencies, account, (store) => store.commitAccountStatusChange(account, audit));
    return { user: adminAccountView(account), audit };
  });

  app.get("/v1/admin/audit-log", async (request) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    requireSuperAdmin(admin);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return { entries: dependencies.accountAdministration.auditLog.slice(-query.limit).reverse() };
  });

  app.post("/v1/admin/users/:userId/points", async (request, reply) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    const params = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const body = z.object({ delta: z.number().int().safe().refine((value) => value !== 0), reason: z.string().trim().min(1).max(200) })
      .parse(request.body);
    const account = dependencies.accountStore.findAccountById(params.userId);
    if (!account) throw new Error("User not found");
    const ledger = dependencies.pointService.adjustByAdmin(account, admin, body.delta, body.reason);
    commitAdminMutation(dependencies, account, (store) => store.commitPointAdjustment(account, ledger));
    return reply.status(201).send(ledger);
  });

  app.get("/v1/admin/users/:userId/points", async (request) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    requireSuperAdmin(admin);
    const params = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const account = dependencies.accountStore.findAccountById(params.userId);
    if (!account) throw new Error("USER_NOT_FOUND");
    return { userId: account.userId, balance: account.points, entries: dependencies.pointService.entriesFor(account.userId) };
  });

  app.post("/v1/admin/users/:userId/points/:ledgerId/reverse", async (request, reply) => {
    const admin = await requireAdmin(request.headers.authorization, dependencies.tokens);
    const params = z.object({ userId: z.string().regex(/^\d{10}$/), ledgerId: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(1).max(200) }).parse(request.body);
    const account = dependencies.accountStore.findAccountById(params.userId);
    if (!account) throw new Error("USER_NOT_FOUND");
    const reversal = dependencies.pointService.reverseAdminAdjustment(account, admin, params.ledgerId, body.reason);
    commitAdminMutation(dependencies, account, (store) => store.commitPointAdjustment(account, reversal));
    return reply.status(201).send(reversal);
  });

  app.get("/v1/users/:userId", async (request) => {
    const params = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const actor = await requireUser(request.headers.authorization, dependencies);
    const account = dependencies.accountStore.findAccountById(params.userId);
    if (!account || account.status !== "active") throw new Error("USER_NOT_FOUND");
    return {
      userId: account.userId,
      nickname: account.nickname,
      avatarUrl: account.avatarUrl,
      relationship: dependencies.friendService.relationship(actor.userId, account.userId),
    };
  });

  app.post("/v1/friends/requests", async (request, reply) => {
    const body = z.object({ targetUserId: z.string().regex(/^\d{10}$/) }).parse(request.body);
    const actor = await requireUser(request.headers.authorization, dependencies);
    const target = dependencies.accountStore.findAccountById(body.targetUserId);
    if (!target || target.status !== "active") throw new Error("USER_NOT_FOUND");
    const friendRequest = dependencies.friendService.sendRequest(actor, target);
    return reply.status(201).send(friendRequestView(friendRequest, dependencies));
  });

  app.get("/v1/friends/requests", async (request) => {
    const actor = await requireUser(request.headers.authorization, dependencies);
    return {
      requests: dependencies.friendService.pendingFor(actor.userId)
        .map((friendRequest) => friendRequestView(friendRequest, dependencies)),
    };
  });

  app.post("/v1/friends/requests/:requestId/respond", async (request) => {
    const params = z.object({ requestId: z.string().min(1) }).parse(request.params);
    const body = z.object({ accept: z.boolean() }).parse(request.body);
    const actor = await requireUser(request.headers.authorization, dependencies);
    const friendRequest = dependencies.friendService.respond(params.requestId, actor.userId, body.accept);
    return friendRequestView(friendRequest, dependencies);
  });

  app.get("/v1/friends", async (request) => {
    const actor = await requireUser(request.headers.authorization, dependencies);
    const friends = dependencies.friendService.friendIds(actor.userId)
      .map((userId) => dependencies.accountStore.findAccountById(userId))
      .filter((account): account is UserAccount => account?.status === "active")
      .map(publicAccountView);
    return { friends };
  });

  app.delete("/v1/friends/:friendId", async (request, reply) => {
    const params = z.object({ friendId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const actor = await requireUser(request.headers.authorization, dependencies);
    dependencies.friendService.removeFriend(actor.userId, params.friendId);
    return reply.status(204).send();
  });

  app.post("/v1/rooms", async (request, reply) => {
    const user = await requireUser(request.headers.authorization, dependencies);
    const roomId = dependencies.createRoomId();
    const room = dependencies.createRoom ? dependencies.createRoom(roomId, user) : new MatchRoom(roomId, user);
    dependencies.roomStore.set(roomId, room);
    return reply.status(201).send({ roomId, status: room.status });
  });

  app.get("/v1/rooms/:roomId", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    requireRoomPlayer(room, user.userId);
    return roomSnapshot(room);
  });

  app.post("/v1/rooms/:roomId/join", async (request, reply) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.join(user);
    return reply.status(201).send({ roomId: room.roomId, status: room.status, playerCount: room.players.size });
  });

  app.post("/v1/rooms/:roomId/leave", async (request, reply) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.leave(user.userId);
    return reply.status(204).send();
  });

  app.post("/v1/rooms/:roomId/ready", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const body = z.object({ ready: z.boolean() }).parse(request.body ?? {});
    const user = await requireUser(request.headers.authorization, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.setReady(user.userId, body.ready);
    return { userId: user.userId, ready: body.ready };
  });

  app.post("/v1/rooms/:roomId/start", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.start(user.userId);
    for (const player of room.players.values()) dependencies.accountStore.saveAccount(player.account);
    return { roomId: room.roomId, status: room.status, completedRounds: room.completedRounds };
  });

  app.post("/v1/rooms/:roomId/dissolve", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    const finished = room.requestDissolve(user.userId);
    return finished
      ? { status: room.status, result: room.result ?? null }
      : { status: room.status, votes: room.dissolveVotes.size, requiredVotes: 3 };
  });

  app.post("/v1/rooms/:roomId/dissolve/vote", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const body = z.object({ agree: z.boolean() }).parse(request.body ?? {});
    const user = await requireUser(request.headers.authorization, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    const result = room.voteDissolve(user.userId, body.agree);
    if (result) {
      for (const player of room.players.values()) dependencies.accountStore.saveAccount(player.account);
      return { status: room.status, result };
    }
    return { status: room.status, votes: room.dissolveVotes.size, requiredVotes: 3 };
  });

  app.get("/v1/matches", async (request) => {
    const user = await requireUser(request.headers.authorization, dependencies);
    const history = requireMatchHistory(dependencies);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    const matches = await history.listMatchesFor(user.userId, query.limit);
    return { matches: matches.map((match) => matchSummaryView(match, dependencies, user.userId)) };
  });

  app.get("/v1/rooms/:roomId/history", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const history = requireMatchHistory(dependencies);
    const match = await history.findMatch(params.roomId);
    if (!match) throw new Error("MATCH_NOT_FOUND");
    // Only the players of a match may read its round-by-round detail.
    if (!match.players.some((player) => player.userId === user.userId)) {
      throw new Error("MATCH_HISTORY_FORBIDDEN");
    }
    return {
      match: matchSummaryView(match, dependencies, user.userId),
      rounds: (await history.listRounds(match.roomId)).map(roundView),
    };
  });

  app.post("/v1/groups", async (request, reply) => {
    const body = z.object({ name: z.string().trim().max(30) }).parse(request.body ?? {});
    const user = await requireUser(request.headers.authorization, dependencies);
    const group = dependencies.groupService.createGroup(user, body.name);
    return reply.status(201).send({
      groupId: group.groupId,
      groupNo: group.groupNo,
      name: group.name,
      ownerId: group.ownerId,
      memberCount: group.members.size,
    });
  });

  app.post("/v1/groups/join", async (request) => {
    const body = z.object({ groupNo: z.string().regex(/^\d{8}$/) }).parse(request.body);
    const user = await requireUser(request.headers.authorization, dependencies);
    const group = dependencies.groupService.joinByGroupNo(user, body.groupNo);
    return { groupId: group.groupId, groupNo: group.groupNo, name: group.name, memberCount: group.members.size };
  });

  app.get("/v1/groups", async (request) => {
    const user = await requireUser(request.headers.authorization, dependencies);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const groups = dependencies.groupService.listFor(user.userId).slice(0, query.limit)
      .map((group) => groupSummaryView(group, user.userId));
    return { groups };
  });

  app.get("/v1/groups/:groupId", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const group = requireGroupMember(dependencies.groupService, params.groupId, user.userId);
    return {
      groupId: group.groupId,
      groupNo: group.groupNo,
      name: group.name,
      ownerId: group.ownerId,
      notice: group.notice,
      allMuted: group.allMuted,
      memberCount: group.members.size,
      members: [...group.members.values()]
        .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime())
        .map((member) => ({ userId: member.userId, role: member.role })),
    };
  });

  app.post("/v1/groups/:groupId/messages", async (request, reply) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({
      type: z.enum(["text", "image", "voice", "emoji", "room_invite"]),
      content: z.string().max(2000),
      voiceSeconds: z.number().int().min(1).max(60).optional(),
    }).parse(request.body);
    const user = await requireUser(request.headers.authorization, dependencies);
    const message = dependencies.groupService.sendMessage({
      groupId: params.groupId,
      sender: user,
      type: body.type,
      content: body.content,
      ...(body.voiceSeconds === undefined ? {} : { voiceSeconds: body.voiceSeconds }),
    });
    const view = groupMessageView(message);
    dependencies.groupEvents.publish({ type: "message", groupId: params.groupId, message: view });
    return reply.status(201).send(view);
  });

  app.get("/v1/groups/:groupId/messages", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    const user = await requireUser(request.headers.authorization, dependencies);
    const group = requireGroupMember(dependencies.groupService, params.groupId, user.userId);
    const messages = group.messages.slice(-(query.limit ?? 100));
    return { groupId: group.groupId, messages: messages.map(groupMessageView) };
  });

  app.post("/v1/groups/:groupId/messages/:messageId/recall", async (request) => {
    const params = z.object({ groupId: z.string().min(1), messageId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const message = dependencies.groupService.recall(params.groupId, user.userId, params.messageId);
    const view = groupMessageView(message);
    dependencies.groupEvents.publish({ type: "recalled", groupId: params.groupId, message: view });
    return view;
  });

  app.post("/v1/groups/:groupId/notice", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ notice: z.string().max(500) }).parse(request.body ?? {});
    const user = await requireUser(request.headers.authorization, dependencies);
    dependencies.groupService.updateNotice(params.groupId, user.userId, body.notice);
    const notice = body.notice.trim();
    dependencies.groupEvents.publish({ type: "updated", groupId: params.groupId, notice });
    return { notice };
  });

  app.post("/v1/groups/:groupId/all-mute", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    const user = await requireUser(request.headers.authorization, dependencies);
    dependencies.groupService.setAllMuted(params.groupId, user.userId, body.enabled);
    dependencies.groupEvents.publish({ type: "updated", groupId: params.groupId, allMuted: body.enabled });
    return { allMuted: body.enabled };
  });

  app.post("/v1/groups/:groupId/mute", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({
      userId: z.string().regex(/^\d{10}$/),
      minutes: z.number().int().min(1).max(60 * 24 * 30),
    }).parse(request.body);
    const actor = await requireUser(request.headers.authorization, dependencies);
    const until = new Date(Date.now() + body.minutes * 60_000);
    dependencies.groupService.muteMember(params.groupId, actor.userId, body.userId, until);
    return { userId: body.userId, mutedUntil: until };
  });

  app.post("/v1/groups/:groupId/members/:memberId/remove", async (request, reply) => {
    const params = z.object({ groupId: z.string().min(1), memberId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const actor = await requireUser(request.headers.authorization, dependencies);
    dependencies.groupService.removeMember(params.groupId, actor.userId, params.memberId);
    // 被移出的成员必须立刻停止收消息，所以这里也要广播。
    dependencies.groupEvents.publish({ type: "member-removed", groupId: params.groupId, userId: params.memberId });
    return reply.status(204).send();
  });

  app.post("/v1/groups/:groupId/members/:memberId/admin", async (request) => {
    const params = z.object({ groupId: z.string().min(1), memberId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const body = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    const actor = await requireUser(request.headers.authorization, dependencies);
    dependencies.groupService.setAdministrator(params.groupId, actor.userId, params.memberId, body.enabled);
    return { userId: params.memberId, role: body.enabled ? "admin" : "member" };
  });

  app.post("/v1/groups/:groupId/transfer", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.body);
    const actor = await requireUser(request.headers.authorization, dependencies);
    dependencies.groupService.transferOwnership(params.groupId, actor.userId, body.userId);
    return { ownerId: body.userId };
  });

  app.post("/v1/groups/:groupId/invite", async (request, reply) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.body);
    const actor = await requireUser(request.headers.authorization, dependencies);
    const invitee = dependencies.accountStore.findAccountById(body.userId);
    if (!invitee || invitee.status !== "active") throw new Error("USER_NOT_FOUND");
    dependencies.groupService.inviteMember({
      groupId: params.groupId,
      actorId: actor.userId,
      invitee,
      // 好友关系在另一个聚合里，这里把它查出来交给群服务判断。
      friendIds: new Set(dependencies.friendService.friendIds(actor.userId)),
    });
    const group = dependencies.groupService.groups.get(params.groupId)!;
    return reply.status(201).send({
      groupId: group.groupId,
      userId: body.userId,
      role: group.members.get(body.userId)?.role ?? "member",
      memberCount: group.members.size,
    });
  });

  app.post("/v1/groups/:groupId/leave", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    const group = dependencies.groupService.leaveGroup(params.groupId, user.userId);
    if (!group) {
      // 最后一个人退出，群就不存在了。
      dependencies.groupEvents.publish({ type: "dissolved", groupId: params.groupId });
      return { groupId: params.groupId, dissolved: true };
    }
    return { groupId: group.groupId, dissolved: false, ownerId: group.ownerId, memberCount: group.members.size };
  });

  app.post("/v1/groups/:groupId/dissolve", async (request, reply) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers.authorization, dependencies);
    dependencies.groupService.dissolveGroup(params.groupId, user.userId);
    dependencies.groupEvents.publish({ type: "dissolved", groupId: params.groupId });
    return reply.status(204).send();
  });

  return app;
}

async function requireAdmin(authorization: string | undefined, tokens: TokenService) {
  return tokens.verifyAdminToken(bearerToken(authorization));
}

function requireSuperAdmin(admin: { role: "super_admin" | "review_admin" }): void {
  if (admin.role !== "super_admin") throw new Error("Only super administrators can access this resource");
}

/**
 * Persists an administrator mutation.
 *
 * A durable admin store writes the account row together with its ledger or audit row in one
 * transaction. Without one, the in-memory account store simply refreshes its map entry: the domain
 * service already mutated the very object the store holds, so the new balance or status is visible
 * either way.
 */
function commitAdminMutation(
  dependencies: AppDependencies,
  account: UserAccount,
  commit: (store: AdminStore) => void,
): void {
  if (dependencies.adminStore) commit(dependencies.adminStore);
  else dependencies.accountStore.saveAccount(account);
}

async function requireUser(authorization: string | undefined, dependencies: AppDependencies): Promise<UserAccount> {
  const userId = await dependencies.tokens.verifyUserToken(bearerToken(authorization));
  const account = dependencies.accountStore.findAccountById(userId);
  if (!account) throw new Error("ACCOUNT_NOT_FOUND");
  if (account.status !== "active") throw new Error("ACCOUNT_NOT_ACTIVE");
  return account;
}

function requireRoom(roomStore: Map<string, MatchRoom>, roomId: string): MatchRoom {
  const room = roomStore.get(roomId);
  if (!room) throw new Error("ROOM_NOT_FOUND");
  return room;
}

function requireGroupMember(groupService: GroupService, groupId: string, userId: string) {
  const group = groupService.groups.get(groupId);
  if (!group) throw new Error("GROUP_NOT_FOUND");
  if (!group.members.has(userId)) throw new Error("User is not a group member");
  return group;
}

function requireRoomPlayer(room: MatchRoom, userId: string) {
  return room.players.get(userId) ?? (() => { throw new Error("Player is not in the room"); })();
}

function requireMatchHistory(dependencies: AppDependencies): MatchHistoryReader {
  if (!dependencies.matchHistory) throw new Error("MATCH_HISTORY_UNAVAILABLE");
  return dependencies.matchHistory;
}

function matchSummaryView(match: MatchSummary, dependencies: AppDependencies, viewerId: string) {
  return {
    roomId: match.roomId,
    ruleVersion: match.ruleVersion,
    status: match.status,
    completedRounds: match.completedRounds,
    finalReason: match.finalReason,
    createdAt: match.createdAt,
    finalizedAt: match.finalizedAt,
    me: match.players.find((player) => player.userId === viewerId) ?? null,
    players: match.players.map((player) => ({
      userId: player.userId,
      nickname: dependencies.accountStore.findAccountById(player.userId)?.nickname ?? null,
      seat: player.seat,
      rawDelta: player.rawDelta,
      accountDelta: player.accountDelta,
    })),
  };
}

function roundView(round: MatchRoundRecord) {
  return {
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    finishReason: round.finishReason,
    winnerSeats: [...round.winnerSeats],
    nextDealerSeat: round.nextDealerSeat,
    deltas: [...round.deltas],
    events: [...round.events],
    finishedAt: round.finishedAt,
  };
}

function roomSnapshot(room: MatchRoom) {
  return {
    roomId: room.roomId,
    ruleVersion: room.ruleVersion,
    status: room.status,
    ownerId: room.ownerId,
    completedRounds: room.completedRounds,
    players: [...room.players.values()]
      .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime())
      .map((player) => ({
        userId: player.account.userId,
        nickname: player.account.nickname,
        points: player.account.points,
        ready: player.ready,
        connected: player.connected,
        disconnectedAt: player.disconnectedAt ?? null,
        reconnectDeadline: player.reconnectDeadline ?? null,
      })),
    result: room.result ?? null,
  };
}

function groupSummaryView(group: ChatGroup, viewerId: string) {
  return {
    groupId: group.groupId,
    groupNo: group.groupNo,
    name: group.name,
    ownerId: group.ownerId,
    notice: group.notice,
    allMuted: group.allMuted,
    memberCount: group.members.size,
    role: group.members.get(viewerId)?.role ?? "member",
    createdAt: group.createdAt,
    // 群列表按「最近有消息」排序，客户端也据此显示最后活跃时间。
    lastMessageAt: group.messages.at(-1)?.sentAt ?? null,
  };
}

function groupMessageView(message: StoredGroupMessage): GroupMessageView {
  return {
    messageId: message.messageId,
    senderId: message.senderId,
    sentAt: message.sentAt,
    type: message.type,
    content: message.recalledAt ? "[消息已撤回]" : message.content,
    ...(message.voiceSeconds === undefined ? {} : { voiceSeconds: message.voiceSeconds }),
    recalledAt: message.recalledAt ?? null,
  };
}

function publicAccountView(account: UserAccount) {
  return { userId: account.userId, nickname: account.nickname, avatarUrl: account.avatarUrl };
}

function adminAccountView(account: UserAccount) {
  return {
    userId: account.userId,
    nickname: account.nickname,
    avatarUrl: account.avatarUrl,
    status: account.status,
    points: account.points,
    activeMatchId: account.activeMatchId ?? null,
    createdAt: account.createdAt,
  };
}

function friendRequestView(friendRequest: import("@mianyang-mahjong/domain").FriendRequest, dependencies: AppDependencies) {
  const requester = dependencies.accountStore.findAccountById(friendRequest.requesterId);
  return {
    requestId: friendRequest.requestId,
    requester: requester ? publicAccountView(requester) : { userId: friendRequest.requesterId },
    targetId: friendRequest.targetId,
    status: friendRequest.status,
    createdAt: friendRequest.createdAt,
    respondedAt: friendRequest.respondedAt ?? null,
  };
}

/**
 * Builds the default dependency graph.
 *
 * Passing `adminStore` wires durable point-ledger/audit persistence and warms both domain services
 * with the history read from it, so reversal checks and audit queries keep working after a restart.
 * `friendService` and `groupService` are injected when they are PostgreSQL-backed; nothing else in
 * this file needs to know whether social data is durable.
 */
export function createInMemoryDependencies(input: {
  tokens: TokenService;
  /** 邀请密钥明文的生成与哈希；服务端用 `CryptoInvitationKeyCodec`。 */
  invitationKeyCodec: InvitationKeyCodec;
  createKeyId: () => string;
  createUserId: () => string;
  createLedgerId: () => string;
  createRoomId: () => string;
  createGroupId: () => string;
  createGroupNo: () => string;
  createMessageId: () => string;
  createFriendRequestId: () => string;
  createAdminAuditId: () => string;
  database?: { ping(): Promise<void> };
  accountStore?: AccountStore;
  invitationKeyStore?: InvitationKeyStore;
  adminStore?: AdminStore;
  friendService?: FriendService;
  groupService?: GroupService;
  roomStore?: Map<string, MatchRoom>;
  createRoom?: (roomId: string, owner: UserAccount) => MatchRoom;
  matchHistory?: MatchHistoryReader;
  gameStateStore?: GameStateStore;
}): AppDependencies & { accountStore: AccountStore } {
  const accountStore = input.accountStore ?? new InMemoryAccountStore();
  const accountAdministration = new AccountAdministrationService(input.createAdminAuditId);
  const pointService = new PointService(input.createLedgerId);
  const invitationKeys = new InvitationKeyService(
    input.invitationKeyStore ?? new InMemoryInvitationKeyStore(),
    input.invitationKeyCodec,
    input.createKeyId,
  );
  if (input.adminStore) {
    accountAdministration.restore(input.adminStore.auditEntries);
    pointService.restore(input.adminStore.ledgerEntries);
  }
  return {
    accountStore,
    accountService: new AccountService(accountStore, invitationKeys, input.createUserId),
    accountAdministration,
    pointService,
    invitationKeys,
    tokens: input.tokens,
    roomStore: input.roomStore ?? new Map<string, MatchRoom>(),
    groupService: input.groupService
      ?? new GroupService(input.createGroupId, input.createGroupNo, input.createMessageId),
    friendService: input.friendService ?? new FriendService(input.createFriendRequestId),
    groupEvents: new InMemoryGroupEventBus(),
    createRoomId: input.createRoomId,
    ...(input.database ? { database: input.database } : {}),
    ...(input.adminStore ? { adminStore: input.adminStore } : {}),
    ...(input.createRoom ? { createRoom: input.createRoom } : {}),
    ...(input.matchHistory ? { matchHistory: input.matchHistory } : {}),
    ...(input.gameStateStore ? { gameStateStore: input.gameStateStore } : {}),
  };
}
