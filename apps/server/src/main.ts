import { randomInt, randomUUID } from "node:crypto";
import type { UserAccount } from "@mianyang-mahjong/domain";
import { createApp, createInMemoryDependencies } from "./app.js";
import { TokenService } from "./auth.js";
import { createWebSocketServer } from "./ws-server.js";
import { PostgresDatabase } from "./database.js";
import { CryptoInvitationKeyCodec } from "./invitation-key-codec.js";
import { PostgresAccountStore } from "./postgres-account-store.js";
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
});
const app = createApp(dependencies);
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
await app.listen({
  host,
  port,
});
if (process.env.NODE_ENV !== "production") {
  const adminToken = await tokens.issueAdminToken(process.env.DEV_ADMIN_ID ?? "local-developer", "super_admin");
  const adminHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  process.stdout.write(`[development admin] http://${adminHost}:${port}/admin\n[token] ${adminToken}\n`);
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
