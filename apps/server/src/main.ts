import { randomInt, randomUUID } from "node:crypto";
import type { UserAccount } from "@mianyang-mahjong/domain";
import { createApp, createInMemoryDependencies } from "./app.js";
import { TokenService } from "./auth.js";
import { createWebSocketServer } from "./ws-server.js";
import { PostgresDatabase } from "./database.js";
import { CryptoInvitationKeyCodec } from "./invitation-key-codec.js";
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

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

// 对象存储。`local` 驱动把文件落到磁盘，并用自签名 URL 模拟云端预签名直传 ——
// 于是整条上传链路在没有云账号时也能跑通与测试；换成云端只需要再写一个驱动。
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
const localBlobStorage = process.env.STORAGE_DRIVER === "local"
  ? new LocalDiskBlobStorage(
      process.env.STORAGE_LOCAL_DIR ?? "storage/blobs",
      publicBaseUrl,
      process.env.STORAGE_SIGNING_SECRET ?? requiredEnvironment("JWT_SECRET"),
    )
  : undefined;
const blobStorage = localBlobStorage;

const dependencies = createInMemoryDependencies({
  tokens,
  invitationKeyCodec,
  createKeyId,
  createUserId: () => String(randomInt(1_000_000_000, 10_000_000_000)),
  createLedgerId,
  createRoomId,
  createGroupId,
  createGroupNo,
  createMessageId,
  createFriendRequestId,
  createAdminAuditId: randomUUID,
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
        createRoom: (roomId: string, owner: UserAccount) => roomStore.createRoom(roomId, owner),
      }
    : {}),
  ...(matchHistory ? { matchHistory } : {}),
  ...(gameStateStore ? { gameStateStore } : {}),
  ...(blobStorage ? { blobStorage } : {}),
  ...(localBlobStorage ? { localBlobStorage } : {}),
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
const wss = await createWebSocketServer(dependencies, Number(process.env.WS_PORT ?? 3001));
process.stdout.write(`[websocket] listening on ${process.env.WS_PORT ?? 3001}\n`);

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
