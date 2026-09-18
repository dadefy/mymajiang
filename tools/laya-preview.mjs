// 隔离的 Laya 四客户端联调环境：内存数据库 + 同源 WebSocket + release/web 静态文件。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { createApp, createInMemoryDependencies } from "../apps/server/dist/app.js";
import { TokenService } from "../apps/server/dist/auth.js";
import { CryptoInvitationKeyCodec } from "../apps/server/dist/invitation-key-codec.js";
import { createAttachedWebSocketServer } from "../apps/server/dist/ws-server.js";
import { ScryptPasswordHasher } from "../apps/server/dist/password-hasher.js";

const port = Number(process.env.LAYA_PREVIEW_PORT || 3000);
const secret = randomUUID() + randomUUID();
let id = 1800000000;
const dependencies = createInMemoryDependencies({
  tokens: new TokenService(secret), invitationKeyCodec: new CryptoInvitationKeyCodec(),
  createKeyId: randomUUID, createUserId: () => String(++id), createLedgerId: randomUUID,
  createRoomId: randomUUID, createGroupId: randomUUID, createGroupNo: () => "32000001",
  createMessageId: randomUUID, createFriendRequestId: randomUUID, createAdminAuditId: randomUUID,
  debugClient: true,
});
const password = "Preview123!";
const hasher = new ScryptPasswordHasher();
const users = ["青竹", "听雨", "晚风", "小满"].map((nickname) => {
  const key = dependencies.invitationKeys.issue({ count: 1, note: "Laya preview", actorId: "preview" })[0].key;
  const user = dependencies.accountService.activateWithKey({ key, nickname, avatarUrl: "avatar" });
  user.points = 2000;
  user.passwordHash = hasher.hash(password);
  return user;
});

const app = createApp(dependencies);
const webRoot = resolve("apps/apk/release/web");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
app.get("/laya/*", async (request, reply) => {
  const tail = String(request.params["*"] || "index.html");
  const file = resolve(join(webRoot, normalize(tail)));
  if (!file.startsWith(webRoot)) return reply.code(404).send();
  try {
    return reply.type(mime[extname(file)] || "application/octet-stream").send(await readFile(file));
  } catch {
    return reply.code(404).send();
  }
});
createAttachedWebSocketServer(app.server, dependencies);
await app.listen({ host: "127.0.0.1", port });
console.log(`Laya preview http://127.0.0.1:${port}/laya/index.html`);
console.log(`Accounts ${users.map((user) => user.userId).join(", ")} / ${password}`);
