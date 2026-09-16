import { randomInt, randomUUID } from "node:crypto";
import type { UserAccount } from "@mianyang-mahjong/domain";
import { createApp, createInMemoryDependencies } from "./app.js";
import { TokenService } from "./auth.js";
import { createAttachedWebSocketServer, createWebSocketServer } from "./ws-server.js";
import { PostgresDatabase } from "./database.js";
import { CryptoInvitationKeyCodec } from "./invitation-key-codec.js";
import { CosBlobStorage } from "./cos-blob-storage.js";
import { LocalDiskBlobStorage } from "./local-blob-storage.js";
import { PostgresAccountStore } from "./postgres-account-store.js";
import { PostgresAdminAccountStore } from "./postgres-admin-account-store.js";
import { PostgresAdminStore } from "./postgres-admin-store.js";
import { PostgresFriendStore } from "./postgres-friend-store.js";
import { PostgresGameStateStore } from "./postgres-game-state-store.js";
import { PostgresGroupStore } from "./postgres-group-store.js";
import { PostgresInvitationKeyStore } from "./postgres-invitation-key-store.js";
import { PostgresMatchHistory } from "./postgres-match-history.js";
import { PostgresRoomStore } from "./postgres-room-store.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";
import { loadEnvironment } from "./load-environment.js";

// 必须最先执行：下面所有 process.env 读取都依赖它。
loadEnvironment();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const tokens = new TokenService(requiredEnvironment("JWT_SECRET"));
const databaseUrl = process.env.DATABASE_URL;
if (process.env.NODE_ENV === "production" && !databaseUrl) throw new Error("DATABASE_URL is required in production");
const database = databaseUrl
  ? new PostgresDatabase({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === "true" })
  : undefined;
// Identifier policy lives here, at the composition root, and is shared by the in-memory and
// PostgreSQL-backed services so both behave identically.
const createGroupId = randomUUID;
const createGroupNo = () => String(randomInt(10_000_000, 100_000_000));
const createMessageId = randomUUID;
const createFriendRequestId = randomUUID;
const createLedgerId = randomUUID;
const createRoomId = randomUUID;
/** 6 位数字房间号（100000–999999）：给人念、给人输的那串，与群聊的 8 位群号同一套发号方式。 */
const createRoomNo = () => String(randomInt(100_000, 1_000_000));
const createKeyId = randomUUID;
// 内测入口：开发方签发一次性邀请密钥，不再使用手机短信验证码。
const invitationKeyCodec = new CryptoInvitationKeyCodec();

if (database) await database.migrate();
// One queue for every repository: writes keep their request order and a single flush covers them.
const writeQueue = database ? new PostgresWriteQueue(database) : undefined;
const accountStore = database && writeQueue ? await PostgresAccountStore.load(database, writeQueue) : undefined;
const invitationKeyStore = database && writeQueue
  ? await PostgresInvitationKeyStore.load(database, writeQueue)
  : undefined;
const adminStore = database && writeQueue ? await PostgresAdminStore.load(database, writeQueue) : undefined;
const friendService = database && writeQueue
  ? await PostgresFriendStore.load(database, writeQueue, createFriendRequestId)
  : undefined;
const groupService = database && writeQueue
  ? await PostgresGroupStore.load(database, writeQueue, { createGroupId, createGroupNo, createMessageId })
  : undefined;
// Rooms are read after accounts: rebuilding a room needs the accounts of its players.
const roomStore = database && writeQueue && accountStore
  ? await PostgresRoomStore.load(database, accountStore, { queue: writeQueue, createLedgerId })
  : undefined;
// History is read-only, so it needs the pool but not the write queue.
const matchHistory = database ? new PostgresMatchHistory(database) : undefined;
// The round in flight is overwritten on every action, so it shares the write queue.
const gameStateStore = database && writeQueue ? PostgresGameStateStore.create(database, writeQueue) : undefined;
// 管理员账号：密码哈希只在服务端实现，领域层只声明接口。
const adminAccountStore = database && writeQueue
  ? await PostgresAdminAccountStore.load(database, writeQueue)
  : undefined;

// 默认绑定所有网卡：这是服务端应用的正常默认值，也是容器、反向代理、内网穿透的前提
// （只绑 127.0.0.1 的话，外面一律连不上）。只在本机自己调试时才设 HOST=127.0.0.1。
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

// 调试客户端注入的实时通道地址。**留空表示与服务端同源**，前端会用 location.origin
// 推出 ws:// 或 wss:// —— 这在隧道与反向代理下都自动正确，也是推荐配置。
// 只有在实时通道确实位于另一个入口时才需要显式指定。
const websocketUrl = process.env.PUBLIC_WEBSOCKET_URL;

/**
 * 反代后面的真实客户端地址。**不设就是"不信任任何代理"**。
 *
 * 为什么必须有这个开关：限流按 `request.ip` 计数，而反代后面取到的是代理的地址 ——
 * 全站共用一个额度，一个人的操作会把所有人的登录额度吃光（见 `docs/DEPLOYMENT.md`）。
 *
 * 取值（直接把字符串交给 Fastify 的 `trustProxy`）：
 *   * 不设          —— 直连部署（或本机测试）。**直连时绝不能开**，否则客户端能伪造 IP 绕过限流；
 *   * `loopback`    —— 最常见：Nginx 与它在同一台机器上，只有本机能转发过来；
 *   * `1` / `true`  —— 信任所有代理；仅当服务端口只对代理开放时使用；
 *   * `1.2.3.4/32,10.0.0.0/8` —— 精确列出可信代理网段；
 *   * `0` / `false` —— 显式关闭（等同于不设）。
 */
function trustProxySetting(): boolean | string | undefined {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return raw;
}
const trustProxy = trustProxySetting();

// 对象存储。两种驱动：
//   * `local` —— 文件落磁盘，用自签名 URL 模拟云端预签名直传，不需要云账号；
//   * `cos`   —— 腾讯云 COS。桶上开默认加密即可，预签名直传会自动加密，代码不用管。
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
const localBlobStorage = process.env.STORAGE_DRIVER === "local"
  ? new LocalDiskBlobStorage(
      process.env.STORAGE_LOCAL_DIR ?? "storage/blobs",
      publicBaseUrl,
      process.env.STORAGE_SIGNING_SECRET ?? requiredEnvironment("JWT_SECRET"),
    )
  : undefined;
const cosBlobStorage = process.env.STORAGE_DRIVER === "cos"
  ? new CosBlobStorage({
      secretId: requiredEnvironment("COS_SECRET_ID"),
      secretKey: requiredEnvironment("COS_SECRET_KEY"),
      bucket: requiredEnvironment("COS_BUCKET"),
      region: requiredEnvironment("COS_REGION"),
    })
  : undefined;
const blobStorage = cosBlobStorage ?? localBlobStorage;

const dependencies = createInMemoryDependencies({
  tokens,
  invitationKeyCodec,
  createKeyId,
  createUserId: () => String(randomInt(1_000_000_000, 10_000_000_000)),
  createLedgerId,
  createRoomId,
  createRoomNo,
  createGroupId,
  createGroupNo,
  createMessageId,
  createFriendRequestId,
  createAdminAuditId: randomUUID,
  // 反代后面必须设，否则限流会把所有人算成一个 IP（见上面 trustProxySetting）。
  ...(trustProxy === undefined ? {} : { trustProxy }),
  ...(database ? { database } : {}),
  ...(accountStore ? { accountStore } : {}),
  ...(invitationKeyStore ? { invitationKeyStore } : {}),
  ...(adminStore ? { adminStore } : {}),
  ...(adminAccountStore ? { adminAccountStore } : {}),
  ...(friendService ? { friendService } : {}),
  ...(groupService ? { groupService } : {}),
  ...(roomStore
    ? {
        roomStore: roomStore.rooms,
        createRoom: (roomId: string, roomNo: string, owner: UserAccount) =>
          roomStore.createRoom(roomId, roomNo, owner),
      }
    : {}),
  ...(matchHistory ? { matchHistory } : {}),
  ...(gameStateStore ? { gameStateStore } : {}),
  ...(blobStorage ? { blobStorage } : {}),
  ...(localBlobStorage ? { localBlobStorage } : {}),
  // 浏览器客户端是内测入口，默认挂上；要关掉可以设 DEBUG_CLIENT=false。
  ...(process.env.DEBUG_CLIENT === "false" ? {} : { debugClient: true }),
  ...(websocketUrl ? { websocketUrl } : {}),
});

// 第一个管理员由环境变量引导。只在账号不存在时创建，所以重复启动不会把改过的密码覆盖回去。
const adminId = process.env.ADMIN_ID;
const adminPassword = process.env.ADMIN_PASSWORD;
if (adminId && adminPassword) {
  if (dependencies.adminAuth.createAdminIfAbsent({ adminId, password: adminPassword })) {
    process.stdout.write(`[admin] 已创建管理员 ${adminId}（密码来自 ADMIN_PASSWORD）\n`);
  }
  if (adminAccountStore) await adminAccountStore.flush();
}
// 生产环境必须至少有一个管理员，否则后台谁也进不去 —— 这是配置错误，宁可启动失败。
if (process.env.NODE_ENV === "production" && dependencies.adminAuth.listAdmins().length === 0) {
  throw new Error("No administrator account exists: set ADMIN_ID and ADMIN_PASSWORD once to bootstrap one");
}

const app = createApp(dependencies);
await app.listen({
  host,
  port,
});
// 不再打印管理员令牌。以前非生产环境会打印一枚 2 小时令牌，那等于把后台钥匙放进日志里，
// 任何能读到日志的人都能进管理后台 —— 现在必须用账号密码登录（见 POST /v1/admin/session）。
if (process.env.NODE_ENV !== "production") {
  const adminHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  process.stdout.write(`[admin] http://${adminHost}:${port}/admin\n`);
}
// 实时通道**与 HTTP 共用同一个端口**：公网部署通常只有一个入口（隧道、反向代理），
// 而且页面一旦是 HTTPS，浏览器就会拦截 ws://，只能用 wss:// —— 共用端口后这件事自动成立。
// 需要单独端口的部署可以设 WS_PORT。
const wss = process.env.WS_PORT
  ? await createWebSocketServer(dependencies, Number(process.env.WS_PORT), {}, process.env.WS_HOST ?? host)
  : createAttachedWebSocketServer(app.server, dependencies);
process.stdout.write(process.env.WS_PORT
  ? `[websocket] listening on ${process.env.WS_HOST ?? host}:${process.env.WS_PORT}\n`
  : `[websocket] 与 HTTP 共用端口 ${port}\n`);
// 把可分享的地址打出来，省得每次翻配置。
const shownHost = process.env.PUBLIC_HOST ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
process.stdout.write(`[debug client] http://${shownHost}:${port}/debug\n`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  wss.close();
  await app.close();
  if (writeQueue) {
    // Do not drop a queued balance/ledger write just because the process is going away.
    await writeQueue.flush().catch((error: unknown) => {
      process.stderr.write(`[shutdown] pending database writes failed: ${String(error)}\n`);
    });
  }
  await database?.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
