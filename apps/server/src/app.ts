import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AccountService,
  AccountAdministrationService,
  AdminAuthService,
  FriendService,
  GroupService,
  InMemoryAccountStore,
  InMemoryAdminAccountStore,
  InMemoryInvitationKeyStore,
  InvitationKeyService,
  MatchRoom,
  PointService,
  type AccountStore,
  type AdminAccountStore,
  type ChatGroup,
  type InvitationKey,
  type PasswordHasher,
  type InvitationKeyCodec,
  type InvitationKeyStore,
  type StoredGroupMessage,
  type UserAccount,
} from "@mianyang-mahjong/domain";
import { TokenService, authToken } from "./auth.js";
import { adminConsoleHtml } from "./admin-console.js";
import type { AdminStore } from "./admin-store.js";
import type { GameStateStore } from "./game-state-store.js";
import { InMemoryGroupEventBus, type GroupEventBus, type GroupMessageView } from "./group-events.js";
import type { MatchHistoryReader, MatchRoundRecord, MatchSummary } from "./match-history.js";
import { ScryptPasswordHasher } from "./password-hasher.js";
import {
  buildObjectKey,
  isOwnedKey,
  kindOfKey,
  UPLOAD_LIMITS,
  UPLOAD_URL_TTL_SECONDS,
  type BlobStorage,
  type UploadKind,
} from "./blob-storage.js";
import { LocalDiskBlobStorage } from "./local-blob-storage.js";
import { RATE_LIMITS, RateLimiter, type RateLimitRule, type RateLimitRules } from "./rate-limit.js";
import { registerDebugClient } from "./debug-client.js";

export interface AppDependencies {
  accountStore: AccountStore;
  accountService: AccountService;
  accountAdministration: AccountAdministrationService;
  pointService: PointService;
  /** 内测入口：开发方签发的一次性邀请密钥。 */
  invitationKeys: InvitationKeyService;
  /** 管理员账号的登录与改密。没配时后台无法登录 —— 见 main.ts 的引导逻辑。 */
  adminAuth: AdminAuthService;
  tokens: TokenService;
  roomStore: Map<string, MatchRoom>;
  groupService: GroupService;
  friendService: FriendService;
  /** 把群聊变化推给实时层；路由层只管写成功之后广播一次。 */
  groupEvents: GroupEventBus;
  database?: { ping(): Promise<void> };
  /** When present, owns balance/status writes so they commit with their ledger or audit row. */
  adminStore?: AdminStore;
  /** 有它时改密码会等落盘再返回；内存模式省略。 */
  adminAccountStore?: AdminAccountStore & { flush?(): Promise<void> };
  createRoomId: () => string;
  /** When present, rooms record themselves as they are created and mutated. */
  createRoom?: (roomId: string, owner: UserAccount) => MatchRoom;
  /** Reads finished matches back. Only available when the server has a database. */
  matchHistory?: MatchHistoryReader;
  /** Stores the round in flight so a restart can carry on. Only with a database. */
  gameStateStore?: GameStateStore;
  /**
   * 图片与语音的对象存储。没配时上传接口返回 501，群聊仍然可用（只是发不了图）。
   *
   * 本地驱动额外挂在 `/v1/blobs/*` 上，所以调试时也把它传进来；
   * 换成云驱动后这两个路由不再被注册。
   */
  blobStorage?: BlobStorage;
  /** 本地驱动实例，用来签发与校验 `/v1/blobs/*` 的签名 URL。 */
  localBlobStorage?: LocalDiskBlobStorage;
  createBlobId?: () => string;
  /** 接口限流。与 `tokens` 一样是核心依赖，`createInMemoryDependencies` 一定会给。 */
  rateLimiter: RateLimiter;
  /** 各处额度。做成依赖而不是直接引用常量，测试才能用很小的额度验证接线。 */
  rateLimitRules: RateLimitRules;
  /**
   * 是否挂载浏览器调试客户端。
   *
   * 单端口部署下页面与接口同源，`socketUrl` 留空即可 —— 前端会用
   * `location.origin` 推出 `ws://` 或 `wss://`，隧道与反向代理下都自动正确。
   * 只有在实时通道确实在另一个入口时才需要显式给地址。
   */
  debugClient?: boolean;
  websocketUrl?: string;
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

  // 图片与语音是二进制，不能让 Fastify 按 JSON 解析。声明之后 `request.body` 就是 Buffer。
  app.addContentTypeParser(/^(image|audio)\/.+/, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && reply.statusCode < 400) {
      await dependencies.accountStore.flush?.();
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ code: "INVALID_INPUT", issues: error.issues });
    if (error instanceof RateLimitedError) {
      return reply
        .status(429)
        .header("Retry-After", String(error.retryAfterSeconds))
        .send({ code: "RATE_LIMITED", retryAfterSeconds: error.retryAfterSeconds });
    }
    const code = error instanceof Error ? error.message : String(error);
    if (code === "AUTH_REQUIRED" || code.startsWith("INVALID_ADMIN_TOKEN") || code.startsWith("INVALID_USER_TOKEN")) {
      return reply.status(401).send({ code });
    }
    // 密钥格式不对是客户端问题；密钥不存在或已撤销等同于认证失败。
    if (code === "KEY_MALFORMED") return reply.status(400).send({ code });
    if (code === "KEY_INVALID" || code === "KEY_REVOKED") return reply.status(401).send({ code });
    // 管理员登录：凭据不对与用户侧一样按认证失败处理，不区分「账号不存在」和「密码错」。
    if (code === "INVALID_ADMIN_CREDENTIALS") return reply.status(401).send({ code });
    if (code === "TOO_MANY_ATTEMPTS") return reply.status(429).send({ code });
    // 密码强度不足属于输入问题，不是业务冲突。
    if (code.startsWith("Admin password must")) {
      return reply.status(400).send({ code: "INVALID_INPUT", message: code });
    }
    if (code.endsWith("_NOT_FOUND") || code === "User not found") {
      return reply.status(404).send({ code: "NOT_FOUND", message: code });
    }
    if (code.includes("Only super administrators")) return reply.status(403).send({ code: "FORBIDDEN" });
    if (code === "ACCOUNT_NOT_ACTIVE") return reply.status(403).send({ code });
    if (code === "MATCH_HISTORY_FORBIDDEN") return reply.status(403).send({ code });
    // History is a persistence feature; without a database there is nothing to read.
    if (code === "MATCH_HISTORY_UNAVAILABLE") return reply.status(501).send({ code });
    // 没配对象存储时不假装上传成功，也不让群聊整体崩掉：只有发图片/语音不可用。
    if (code === "STORAGE_UNAVAILABLE") return reply.status(501).send({ code });
    if (code === "STORAGE_SIGNATURE_INVALID") return reply.status(403).send({ code });
    if (code === "OBJECT_NOT_FOUND") return reply.status(404).send({ code });
    if (code === "INVALID_OBJECT_KEY") return reply.status(400).send({ code: "INVALID_INPUT", message: code });
    if (code === "UPLOAD_TOO_LARGE") return reply.status(400).send({ code: "INVALID_INPUT", message: code });
    if (code.startsWith("Unsupported content type")) {
      return reply.status(400).send({ code: "INVALID_INPUT", message: code });
    }
    if (code.includes("exceeds the") && code.includes("limit")) {
      return reply.status(400).send({ code: "INVALID_INPUT", message: code });
    }
    if (code === "UPLOAD_NOT_OWNED") return reply.status(403).send({ code });
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

  // 内部测试用的浏览器客户端。没开就不挂（测试里默认不挂）。
  if (dependencies.debugClient) {
    registerDebugClient(app, { socketUrl: dependencies.websocketUrl ?? "" });
    // 内测要分享的是一个网址，让根路径直接把人送到客户端 —— 否则拿到链接的人
    // 只会看到一个 404，还得再问一次「要加什么后缀」。
    app.get("/", async (_request, reply) => reply.redirect("/debug", 302));
  }

  app.get("/admin", async (_request, reply) => reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
    .header("X-Frame-Options", "DENY")
    .type("text/html; charset=utf-8")
    .send(adminConsoleHtml()));

  app.post("/v1/auth/activate", async (request, reply) => {
    enforceRateLimit(dependencies.rateLimiter, `auth:${request.ip}`, dependencies.rateLimitRules.authByIp);
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
    enforceRateLimit(dependencies.rateLimiter, `auth:${request.ip}`, dependencies.rateLimitRules.authByIp);
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

  /**
   * 注销账号。用户自己发起，立即生效且不可撤销。
   *
   * 只改账号本身（状态 + 匿名化），不碰积分与战绩 —— 见 `AccountService.deleteAccount`。
   * 注销之后同一个令牌立刻失效（`requireUser` 会拒绝非 active 状态），邀请密钥也一并作废。
   */
  app.post("/v1/account/delete", async (request, reply) => {
    const user = await requireUser(request.headers, dependencies);
    dependencies.accountService.deleteAccount(user);
    await dependencies.accountStore.flush?.();
    return reply.status(204).send();
  });

  /**
   * 管理员登录。
   *
   * 返回 2 小时的管理员令牌。失败时「账号不存在」与「密码不对」是同一条错误，
   * 且连续失败会锁定 —— 既不能用来枚举账号，也不适合爆破。
   */
  app.post("/v1/admin/session", async (request, reply) => {
    const body = z.object({
      adminId: z.string().trim().min(1).max(64),
      password: z.string().min(1).max(200),
    }).parse(request.body);
    const admin = dependencies.adminAuth.login(body.adminId, body.password);
    return reply.status(201).send({
      adminId: admin.adminId,
      role: admin.role,
      token: await dependencies.tokens.issueAdminToken(admin.adminId, admin.role),
    });
  });

  /** 改自己的密码。必须提供当前密码，并且同样受失败锁定约束。 */
  app.post("/v1/admin/password", async (request, reply) => {
    const admin = await requireAdmin(request.headers, dependencies.tokens);
    const body = z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: z.string().min(1).max(200),
    }).parse(request.body);
    dependencies.adminAuth.changePassword(admin.adminId, body.currentPassword, body.newPassword);
    await dependencies.adminAccountStore?.flush?.();
    return reply.status(204).send();
  });

  /**
   * 签发一个图片或语音的直传地址。
   *
   * 类型与大小在**签发时**就校验掉：客户端拿到的地址已经绑定了内容类型，
   * 换类型上传会被存储端拒绝，所以不必指望客户端自觉。
   */
  app.post("/v1/uploads", async (request, reply) => {
    const user = await requireUser(request.headers, dependencies);
    // 这是真正的成本风险：单张图最高 5MB，不限流可以把存储账单刷爆。分钟与小时两道都要。
    enforceRateLimit(dependencies.rateLimiter, `upload:${user.userId}`, dependencies.rateLimitRules.uploadByUser);
    enforceRateLimit(dependencies.rateLimiter, `upload-hourly:${user.userId}`, dependencies.rateLimitRules.uploadByUserHourly);
    const storage = dependencies.blobStorage;
    if (!storage) throw new Error("STORAGE_UNAVAILABLE");
    const body = z.object({
      kind: z.enum(["image", "voice"]),
      contentType: z.string().min(1).max(100),
      byteSize: z.number().int().positive(),
    }).parse(request.body);

    const limits = UPLOAD_LIMITS[body.kind];
    if (!(limits.contentTypes as readonly string[]).includes(body.contentType)) {
      throw new Error(`Unsupported content type for ${body.kind}: ${body.contentType}`);
    }
    if (body.byteSize > limits.maximumBytes) {
      throw new Error(`${body.kind} exceeds the ${Math.floor(limits.maximumBytes / 1024 / 1024)} MB limit`);
    }

    const objectKey = buildObjectKey(user.userId, body.kind, (dependencies.createBlobId ?? randomUUID)());
    const presigned = await storage.presignUpload({ key: objectKey, contentType: body.contentType });
    return reply.status(201).send({
      objectKey,
      uploadUrl: presigned.url,
      method: presigned.method,
      headers: presigned.headers,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
  });

  // 只有本地驱动才需要这两个路由：云上由存储服务自己接收直传与读取。
  const localBlobs = dependencies.localBlobStorage;
  if (localBlobs) {
    app.put("/v1/blobs/*", async (request, reply) => {
      const key = wildcardKey(request.params);
      const query = z.object({
        expires: z.string(),
        contentType: z.string(),
        signature: z.string(),
      }).parse(request.query);
      if (!localBlobs.verify({ method: "PUT", key, ...query })) {
        throw new Error("STORAGE_SIGNATURE_INVALID");
      }
      // Fastify 默认按 JSON 解析；图片与语音是二进制，必须显式声明解析器。
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? ""));
      const limits = UPLOAD_LIMITS[kindOfKey(key)!];
      if (body.length > limits.maximumBytes) throw new Error("UPLOAD_TOO_LARGE");
      await localBlobs.put(key, body, query.contentType);
      return reply.status(204).send();
    });

    app.get("/v1/blobs/*", async (request, reply) => {
      const key = wildcardKey(request.params);
      const query = z.object({
        expires: z.string(),
        signature: z.string(),
      }).parse(request.query);
      if (!localBlobs.verify({ method: "GET", key, contentType: "", ...query })) {
        throw new Error("STORAGE_SIGNATURE_INVALID");
      }
      const object = await localBlobs.get(key);
      if (!object) throw new Error("OBJECT_NOT_FOUND");
      return reply
        // 内容不可变（键里带随机 id），但仍然是私有资源，不要让中间缓存长期留存。
        .header("Cache-Control", "private, max-age=300")
        .type(object.contentType)
        .send(object.body);
    });
  }

  app.get("/v1/admin/invitation-keys", async (request) => {
    const admin = await requireAdmin(request.headers, dependencies.tokens);
    requireSuperAdmin(admin);
    const keys = dependencies.invitationKeys.list().map((key) =>
      invitationKeyView(key, Boolean(dependencies.accountStore.findAccountByInvitationKeyHash(key.keyHash))),
    );
    return { keys };
  });

  app.post("/v1/admin/invitation-keys", async (request, reply) => {
    const admin = await requireAdmin(request.headers, dependencies.tokens);
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
    const admin = await requireAdmin(request.headers, dependencies.tokens);
    requireSuperAdmin(admin);
    const params = z.object({ keyId: z.string().min(1) }).parse(request.params);
    const key = dependencies.invitationKeys.list().find((candidate) => candidate.keyId === params.keyId);
    if (!key) throw new Error("KEY_NOT_FOUND");
    const activated = Boolean(dependencies.accountStore.findAccountByInvitationKeyHash(key.keyHash));
    dependencies.invitationKeys.revoke(params.keyId, admin.adminId, activated);
    return reply.status(204).send();
  });

  app.get("/v1/admin/users", async (request) => {
    const admin = await requireAdmin(request.headers, dependencies.tokens);
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
    const admin = await requireAdmin(request.headers, dependencies.tokens);
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
    const admin = await requireAdmin(request.headers, dependencies.tokens);
    requireSuperAdmin(admin);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return { entries: dependencies.accountAdministration.auditLog.slice(-query.limit).reverse() };
  });

  app.post("/v1/admin/users/:userId/points", async (request, reply) => {
    const admin = await requireAdmin(request.headers, dependencies.tokens);
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
    const admin = await requireAdmin(request.headers, dependencies.tokens);
    requireSuperAdmin(admin);
    const params = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const account = dependencies.accountStore.findAccountById(params.userId);
    if (!account) throw new Error("USER_NOT_FOUND");
    return { userId: account.userId, balance: account.points, entries: dependencies.pointService.entriesFor(account.userId) };
  });

  app.post("/v1/admin/users/:userId/points/:ledgerId/reverse", async (request, reply) => {
    const admin = await requireAdmin(request.headers, dependencies.tokens);
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
    const actor = await requireUser(request.headers, dependencies);
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
    const actor = await requireUser(request.headers, dependencies);
    const target = dependencies.accountStore.findAccountById(body.targetUserId);
    if (!target || target.status !== "active") throw new Error("USER_NOT_FOUND");
    const friendRequest = dependencies.friendService.sendRequest(actor, target);
    return reply.status(201).send(friendRequestView(friendRequest, dependencies));
  });

  app.get("/v1/friends/requests", async (request) => {
    const actor = await requireUser(request.headers, dependencies);
    return {
      requests: dependencies.friendService.pendingFor(actor.userId)
        .map((friendRequest) => friendRequestView(friendRequest, dependencies)),
    };
  });

  app.post("/v1/friends/requests/:requestId/respond", async (request) => {
    const params = z.object({ requestId: z.string().min(1) }).parse(request.params);
    const body = z.object({ accept: z.boolean() }).parse(request.body);
    const actor = await requireUser(request.headers, dependencies);
    const friendRequest = dependencies.friendService.respond(params.requestId, actor.userId, body.accept);
    return friendRequestView(friendRequest, dependencies);
  });

  app.get("/v1/friends", async (request) => {
    const actor = await requireUser(request.headers, dependencies);
    const friends = dependencies.friendService.friendIds(actor.userId)
      .map((userId) => dependencies.accountStore.findAccountById(userId))
      .filter((account): account is UserAccount => account?.status === "active")
      .map(publicAccountView);
    return { friends };
  });

  app.delete("/v1/friends/:friendId", async (request, reply) => {
    const params = z.object({ friendId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const actor = await requireUser(request.headers, dependencies);
    dependencies.friendService.removeFriend(actor.userId, params.friendId);
    return reply.status(204).send();
  });

  app.post("/v1/rooms", async (request, reply) => {
    const user = await requireUser(request.headers, dependencies);
    const roomId = dependencies.createRoomId();
    const room = dependencies.createRoom ? dependencies.createRoom(roomId, user) : new MatchRoom(roomId, user);
    dependencies.roomStore.set(roomId, room);
    return reply.status(201).send({ roomId, status: room.status });
  });

  app.get("/v1/rooms/:roomId", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    requireRoomPlayer(room, user.userId);
    return roomSnapshot(room);
  });

  app.post("/v1/rooms/:roomId/join", async (request, reply) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.join(user);
    return reply.status(201).send({ roomId: room.roomId, status: room.status, playerCount: room.players.size });
  });

  app.post("/v1/rooms/:roomId/leave", async (request, reply) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.leave(user.userId);
    return reply.status(204).send();
  });

  app.post("/v1/rooms/:roomId/ready", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const body = z.object({ ready: z.boolean() }).parse(request.body ?? {});
    const user = await requireUser(request.headers, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.setReady(user.userId, body.ready);
    return { userId: user.userId, ready: body.ready };
  });

  app.post("/v1/rooms/:roomId/start", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    room.start(user.userId);
    for (const player of room.players.values()) dependencies.accountStore.saveAccount(player.account);
    return { roomId: room.roomId, status: room.status, completedRounds: room.completedRounds };
  });

  app.post("/v1/rooms/:roomId/dissolve", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    const finished = room.requestDissolve(user.userId);
    return finished
      ? { status: room.status, result: room.result ?? null }
      : { status: room.status, votes: room.dissolveVotes.size, requiredVotes: 3 };
  });

  app.post("/v1/rooms/:roomId/dissolve/vote", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const body = z.object({ agree: z.boolean() }).parse(request.body ?? {});
    const user = await requireUser(request.headers, dependencies);
    const room = requireRoom(dependencies.roomStore, params.roomId);
    const result = room.voteDissolve(user.userId, body.agree);
    if (result) {
      for (const player of room.players.values()) dependencies.accountStore.saveAccount(player.account);
      return { status: room.status, result };
    }
    return { status: room.status, votes: room.dissolveVotes.size, requiredVotes: 3 };
  });

  app.get("/v1/matches", async (request) => {
    const user = await requireUser(request.headers, dependencies);
    const history = requireMatchHistory(dependencies);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().min(1).optional(),
    }).parse(request.query);
    const page = await history.listMatchesFor(user.userId, query.limit, query.cursor);
    return {
      matches: page.matches.map((match) => matchSummaryView(match, dependencies, user.userId)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  app.get("/v1/rooms/:roomId/history", async (request) => {
    const params = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
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
    const user = await requireUser(request.headers, dependencies);
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
    const user = await requireUser(request.headers, dependencies);
    const group = dependencies.groupService.joinByGroupNo(user, body.groupNo);
    return { groupId: group.groupId, groupNo: group.groupNo, name: group.name, memberCount: group.members.size };
  });

  app.get("/v1/groups", async (request) => {
    const user = await requireUser(request.headers, dependencies);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const groups = dependencies.groupService.listFor(user.userId).slice(0, query.limit)
      .map((group) => groupSummaryView(group, user.userId));
    return { groups };
  });

  app.get("/v1/groups/:groupId", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
    const group = requireGroupMember(dependencies.groupService, params.groupId, user.userId);
    return {
      groupId: group.groupId,
      groupNo: group.groupNo,
      name: group.name,
      ownerId: group.ownerId,
      notice: group.notice,
      allMuted: group.allMuted,
      memberCount: group.members.size,
      // 调用者在这个群里的角色：群聊页面据此决定要不要显示管理入口。
      role: group.members.get(user.userId)?.role ?? "member",
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
    const user = await requireUser(request.headers, dependencies);
    enforceRateLimit(dependencies.rateLimiter, `group-message:${user.userId}`, dependencies.rateLimitRules.groupMessageByUser);
    // 图片与语音的 content 是对象键。归属与类型都写在键前缀里，所以一次前缀校验就够了 ——
    // 既不必为上传单独建表，也挡住了「引用别人的文件」。
    if (body.type === "image" || body.type === "voice") {
      if (!isOwnedKey(body.content, user.userId, body.type)) throw new Error("UPLOAD_NOT_OWNED");
    }
    const message = dependencies.groupService.sendMessage({
      groupId: params.groupId,
      sender: user,
      type: body.type,
      content: body.content,
      ...(body.voiceSeconds === undefined ? {} : { voiceSeconds: body.voiceSeconds }),
    });
    const view = await groupMessageView(message, dependencies);
    dependencies.groupEvents.publish({ type: "message", groupId: params.groupId, message: view });
    return reply.status(201).send(view);
  });

  app.get("/v1/groups/:groupId/messages", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      before: z.string().min(1).optional(),
    }).parse(request.query);
    const user = await requireUser(request.headers, dependencies);
    const group = requireGroupMember(dependencies.groupService, params.groupId, user.userId);
    // 游标分页由领域层统一实现（内存版与 PostgreSQL 版语义一致），路由只做转发。
    // 领域层按「新 → 旧」翻页，而对外一直保持「旧 → 新」—— 群聊页面直接从上往下渲染，
    // 加载更早的一页也只是前插，不必在渲染层再翻一次。
    const page = await dependencies.groupService.getMessages(group.groupId, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.before === undefined ? {} : { before: query.before }),
    });
    return {
      groupId: group.groupId,
      messages: await Promise.all([...page.messages].reverse().map((message) => groupMessageView(message, dependencies))),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });

  app.post("/v1/groups/:groupId/messages/:messageId/recall", async (request) => {
    const params = z.object({ groupId: z.string().min(1), messageId: z.string().min(1) }).parse(request.params);
    const user = await requireUser(request.headers, dependencies);
    const message = await dependencies.groupService.recall(params.groupId, user.userId, params.messageId);
    const view = await groupMessageView(message, dependencies);
    dependencies.groupEvents.publish({ type: "recalled", groupId: params.groupId, message: view });
    return view;
  });

  app.post("/v1/groups/:groupId/notice", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ notice: z.string().max(500) }).parse(request.body ?? {});
    const user = await requireUser(request.headers, dependencies);
    dependencies.groupService.updateNotice(params.groupId, user.userId, body.notice);
    const notice = body.notice.trim();
    dependencies.groupEvents.publish({ type: "updated", groupId: params.groupId, notice });
    return { notice };
  });

  app.post("/v1/groups/:groupId/all-mute", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    const user = await requireUser(request.headers, dependencies);
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
    const actor = await requireUser(request.headers, dependencies);
    const until = new Date(Date.now() + body.minutes * 60_000);
    dependencies.groupService.muteMember(params.groupId, actor.userId, body.userId, until);
    return { userId: body.userId, mutedUntil: until };
  });

  app.post("/v1/groups/:groupId/members/:memberId/remove", async (request, reply) => {
    const params = z.object({ groupId: z.string().min(1), memberId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const actor = await requireUser(request.headers, dependencies);
    dependencies.groupService.removeMember(params.groupId, actor.userId, params.memberId);
    // 被移出的成员必须立刻停止收消息，所以这里也要广播。
    dependencies.groupEvents.publish({ type: "member-removed", groupId: params.groupId, userId: params.memberId });
    return reply.status(204).send();
  });

  app.post("/v1/groups/:groupId/members/:memberId/admin", async (request) => {
    const params = z.object({ groupId: z.string().min(1), memberId: z.string().regex(/^\d{10}$/) }).parse(request.params);
    const body = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    const actor = await requireUser(request.headers, dependencies);
    dependencies.groupService.setAdministrator(params.groupId, actor.userId, params.memberId, body.enabled);
    return { userId: params.memberId, role: body.enabled ? "admin" : "member" };
  });

  app.post("/v1/groups/:groupId/transfer", async (request) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.body);
    const actor = await requireUser(request.headers, dependencies);
    dependencies.groupService.transferOwnership(params.groupId, actor.userId, body.userId);
    return { ownerId: body.userId };
  });

  app.post("/v1/groups/:groupId/invite", async (request, reply) => {
    const params = z.object({ groupId: z.string().min(1) }).parse(request.params);
    const body = z.object({ userId: z.string().regex(/^\d{10}$/) }).parse(request.body);
    const actor = await requireUser(request.headers, dependencies);
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
    const user = await requireUser(request.headers, dependencies);
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
    const user = await requireUser(request.headers, dependencies);
    dependencies.groupService.dissolveGroup(params.groupId, user.userId);
    dependencies.groupEvents.publish({ type: "dissolved", groupId: params.groupId });
    return reply.status(204).send();
  });

  return app;
}

async function requireAdmin(headers: { "x-auth-token"?: string | undefined; authorization?: string | undefined } | undefined, tokens: TokenService) {
  return tokens.verifyAdminToken(authToken(headers));
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

async function requireUser(headers: { "x-auth-token"?: string | undefined; authorization?: string | undefined } | undefined, dependencies: AppDependencies): Promise<UserAccount> {
  const userId = await dependencies.tokens.verifyUserToken(authToken(headers));
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

/** 取通配路由捕获到的对象键，并去掉前导斜杠。 */
function wildcardKey(params: unknown): string {
  const star = (params as { "*"?: unknown })["*"];
  return typeof star === "string" ? star.replace(/^\/+/, "") : "";
}

/** 带上建议等待时间的限流错误；错误处理器据此回 429 与 Retry-After。 */
class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("RATE_LIMITED");
  }
}

/** 超限就抛错，由统一的错误处理器转成 429。 */
function enforceRateLimit(limiter: RateLimiter, key: string, rule: RateLimitRule): void {
  const decision = limiter.check(key, rule);
  if (decision.allowed) return;
  throw new RateLimitedError(decision.retryAfterSeconds ?? 1);
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

/**
 * 群消息的对外视图。
 *
 * 图片与语音在库里存的是对象键，这里换成**带时效的读取地址** —— 私有桶只能这样读。
 * 换出来的地址只在几十秒的窗口里有效，所以客户端应当直接用，不要持久化。
 */
async function groupMessageView(message: StoredGroupMessage, dependencies: AppDependencies): Promise<GroupMessageView> {
  const recalled = message.recalledAt !== undefined;
  const blobKind = kindOfKey(message.content);
  const needsSignedUrl = !recalled && blobKind !== undefined && dependencies.blobStorage !== undefined;
  const content = recalled
    ? "[消息已撤回]"
    : needsSignedUrl
      ? await dependencies.blobStorage!.presignDownload(message.content)
      : message.content;
  const sender = dependencies.accountStore.findAccountById(message.senderId);
  return {
    messageId: message.messageId,
    senderId: message.senderId,
    ...(sender ? { senderNickname: sender.nickname } : {}),
    sentAt: message.sentAt,
    type: message.type,
    content,
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
  adminAccountStore?: AdminAccountStore;
  /** 密码哈希实现；测试可注入假实现，生产用 scrypt。 */
  passwordHasher?: PasswordHasher;
  friendService?: FriendService;
  groupService?: GroupService;
  roomStore?: Map<string, MatchRoom>;
  createRoom?: (roomId: string, owner: UserAccount) => MatchRoom;
  matchHistory?: MatchHistoryReader;
  gameStateStore?: GameStateStore;
  blobStorage?: BlobStorage;
  localBlobStorage?: LocalDiskBlobStorage;
  createBlobId?: () => string;
  rateLimiter?: RateLimiter;
  rateLimitRules?: RateLimitRules;
  debugClient?: boolean;
  websocketUrl?: string;
}): AppDependencies & { accountStore: AccountStore } {
  const accountStore = input.accountStore ?? new InMemoryAccountStore();
  const accountAdministration = new AccountAdministrationService(input.createAdminAuditId);
  const pointService = new PointService(input.createLedgerId);
  const invitationKeys = new InvitationKeyService(
    input.invitationKeyStore ?? new InMemoryInvitationKeyStore(),
    input.invitationKeyCodec,
    input.createKeyId,
  );
  const adminAccountStore = input.adminAccountStore ?? new InMemoryAdminAccountStore();
  const adminAuth = new AdminAuthService(adminAccountStore, input.passwordHasher ?? new ScryptPasswordHasher());
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
    adminAuth,
    tokens: input.tokens,
    roomStore: input.roomStore ?? new Map<string, MatchRoom>(),
    groupService: input.groupService
      ?? new GroupService(input.createGroupId, input.createGroupNo, input.createMessageId),
    friendService: input.friendService ?? new FriendService(input.createFriendRequestId),
    groupEvents: new InMemoryGroupEventBus(),
    createRoomId: input.createRoomId,
    ...(input.database ? { database: input.database } : {}),
    ...(input.adminStore ? { adminStore: input.adminStore } : {}),
    ...(input.adminAccountStore ? { adminAccountStore: input.adminAccountStore } : {}),
    ...(input.createRoom ? { createRoom: input.createRoom } : {}),
    ...(input.matchHistory ? { matchHistory: input.matchHistory } : {}),
    ...(input.gameStateStore ? { gameStateStore: input.gameStateStore } : {}),
    ...(input.blobStorage ? { blobStorage: input.blobStorage } : {}),
    ...(input.localBlobStorage ? { localBlobStorage: input.localBlobStorage } : {}),
    createBlobId: input.createBlobId ?? randomUUID,
    // 每个 app 自建一个限流器，测试之间因此互不干扰。
    rateLimiter: input.rateLimiter ?? new RateLimiter(),
    rateLimitRules: input.rateLimitRules ?? RATE_LIMITS,
    ...(input.debugClient ? { debugClient: true } : {}),
    ...(input.websocketUrl ? { websocketUrl: input.websocketUrl } : {}),
  };
}
