import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createInMemoryDependencies, type AppDependencies } from "./app.js";
import { TokenService } from "./auth.js";
import { createWebSocketServer } from "./ws-server.js";
import type { WebSocketServer } from "./ws.js";
import { MatchRoom } from "@mianyang-mahjong/domain";
import { MahjongGame, type GameSnapshot, type Suit, type Tile } from "@mianyang-mahjong/rules";
import type { GameStateStore } from "./game-state-store.js";
import { CryptoInvitationKeyCodec } from "./invitation-key-codec.js";

class TestClient {
  private socket: Socket | null = null;
  // Annotated as the widened `Buffer<ArrayBufferLike>`: `subarray` returns that type, while
  // `Buffer.alloc(0)` narrows to `Buffer<ArrayBuffer>`.
  private buffer: Buffer = Buffer.alloc(0);
  private readonly inbox: object[] = [];
  private readonly waiters: Array<(message: object) => void> = [];
  private handshakeDone = false;

  async connect(port: number): Promise<void> {
    this.socket = connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      this.socket!.on("connect", () => resolve());
      this.socket!.on("error", reject);
    });
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    const key = Buffer.from("test-key-1234567890").toString("base64");
    this.socket.write(
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeDone) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      this.buffer = this.buffer.subarray(headerEnd + 4);
      this.handshakeDone = true;
    }
    let frame = decodeServerFrame(this.buffer);
    while (frame) {
      const message = JSON.parse(frame.payload.toString("utf-8")) as object;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.inbox.push(message);
      this.buffer = frame.rest;
      frame = decodeServerFrame(this.buffer);
    }
  }

  send(payload: object): void {
    this.socket!.write(encodeClientFrame(JSON.stringify(payload)));
  }

  async next(timeoutMs = 3000): Promise<object> {
    const existing = this.inbox.shift();
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}

function decodeServerFrame(buffer: Buffer): { payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return { payload: buffer.subarray(offset, offset + length), rest: buffer.subarray(offset + length) };
}

function encodeClientFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf-8");
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let header: Buffer;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.from(data);
  for (let index = 0; index < masked.length; index += 1) masked[index] = masked[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}

let idCounter = 1234567890;
/** 房间号发号器：递增才不会在 `nextRoomNo` 里撞号空转。 */
let roomNoCounter = 200_000;

function fixture() {
  const tokens = new TokenService("test-jwt-secret-that-is-longer-than-32-characters");
  const dependencies = createInMemoryDependencies({
    tokens,
    invitationKeyCodec: new CryptoInvitationKeyCodec(),
    createKeyId: () => `key-${idCounter++}`,
    createUserId: () => String(idCounter++),
    createLedgerId: () => `ledger-${idCounter}`,
    createRoomId: () => `room-${idCounter}`,
    // 递增而不是固定值：一间 app 里可能建多间房，撞号会让 `nextRoomNo` 一直重抽。
    createRoomNo: () => String((roomNoCounter += 1)),
    createGroupId: () => `group-${idCounter}`,
    createGroupNo: () => "12345678",
    createMessageId: () => `msg-${idCounter++}`,
    createFriendRequestId: () => `friend-request-${idCounter++}`,
    createAdminAuditId: () => `audit-${idCounter++}`,
  });
  return { app: createApp(dependencies), dependencies, tokens };
}

/** 用开发方签发的密钥激活一个内测账号。 */
function createBetaUser(dependencies: AppDependencies, nickname: string): string {
  const key = dependencies.invitationKeys.issue({ count: 1, note: nickname, actorId: "developer" })[0]!.key;
  const account = dependencies.accountService.activateWithKey({
    key,
    nickname,
    avatarUrl: "avatar",
  });
  account.points = 10000;
  return account.userId;
}

function makeRoom(dependencies: AppDependencies, userIds: string[]): MatchRoom {
  const owner = dependencies.accountStore.findAccountById(userIds[0]!)!;
  // 房间号走依赖里的发号器，和真实建房路径保持一致（递增，不会撞号）。
  const room = new MatchRoom(`room-${idCounter++}`, dependencies.createRoomNo(), owner);
  dependencies.roomStore.set(room.roomId, room);
  for (const id of userIds.slice(1)) room.join(dependencies.accountStore.findAccountById(id)!);
  for (const id of userIds) room.setReady(id, true);
  return room;
}

interface ClientState {
  client: TestClient;
  userId: string;
  seat: number;
  hand: Tile[];
  missingSuit: Suit | null;
  actions: string[];
}

const wssInstances: WebSocketServer[] = [];

afterEach(() => {
  for (const server of wssInstances.splice(0)) server.close();
});

describe("WebSocket 对局", () => {
  it("4 客户端 auth → start → 换三张 → 定缺 → 行牌，且状态脱敏", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3200 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const userIds = ["甲", "乙", "丙", "丁"].map((n) => createBetaUser(dependencies, n));
    const room = makeRoom(dependencies, userIds);

    const clients: TestClient[] = [];
    for (const id of userIds) {
      const client = new TestClient();
      await client.connect(port);
      client.send({ type: "auth", token: await tokens.issueUserToken(id), roomId: room.roomId });
      const ack = await client.next();
      expect((ack as { type: string }).type).toBe("room");
      clients.push(client);
    }

    // 房主 start
    clients[0]!.send({ type: "start" });

    // 每个客户端收到初始 game 状态（换三张阶段）
    const initial = await Promise.all(clients.map((c) => c.next()));
    for (const message of initial) {
      expect((message as { type: string }).type).toBe("game");
      const snap = (message as { state: any }).state;
      expect(snap.phase).toBe("swapping");
      expect(snap.actionDeadlineAt).toBeGreaterThan(Date.now());
      expect(snap.actionDeadlineAt).toBeLessThanOrEqual(Date.now() + 15_000);
      // 脱敏：他人快照不含手牌
      expect(snap.players.every((p: { hand?: unknown }) => p.hand === undefined)).toBe(true);
    }

    expect(new Set(initial.map((message) => (message as { state: { actionDeadlineAt: number } }).state.actionDeadlineAt)).size).toBe(1);

    // 四人自动换三张 → 进入定缺
    for (const client of clients) client.send({ type: "auto-swap" });
    await Promise.all(clients.map((c) => c.next()));
    for (const client of clients) client.send({ type: "auto-missing" });
    const afterMissing = await Promise.all(clients.map((c) => c.next()));
    for (const message of afterMissing) {
      const type = (message as { type: string }).type;
      expect(["game", "actions"]).toContain(type);
    }

    for (const client of clients) client.close();
  }, 30000);

  it("换三张与定缺提交不重置其他家的截止时间，超时仍自动推进", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3900 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port, { playTimeoutMs: 1000 });
    wssInstances.push(wss);
    const ids = ["甲", "乙", "丙", "丁"].map((n) => createBetaUser(dependencies, n));
    const room = makeRoom(dependencies, ids);
    const clients: TestClient[] = [];
    const nextGame = async (client: TestClient) => {
      for (;;) {
        const message = await client.next() as { type: string; state: { phase: string; actionDeadlineAt: number } };
        if (message.type === "game") return message.state;
      }
    };
    try {
      for (const id of ids) {
        const client = new TestClient();
        clients.push(client);
        await client.connect(port);
        client.send({ type: "auth", token: await tokens.issueUserToken(id), roomId: room.roomId });
        await client.next();
      }
      clients[0]!.send({ type: "start" });
      let states = await Promise.all(clients.map(nextGame));
      for (const [phase, action, nextPhase] of [
        ["swapping", "auto-swap", "missing"],
        ["missing", "auto-missing", "playing"],
      ] as const) {
        const deadline = states[0]!.actionDeadlineAt;
        expect(states.every((state) => state.phase === phase)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        clients[0]!.send({ type: action });
        states = await Promise.all(clients.map(nextGame));
        expect(states.every((state) => state.actionDeadlineAt === deadline)).toBe(true);
        // 其余三家不操作，必须在原截止时间到达时全部自动完成。
        states = await Promise.all(clients.map(async (client) => {
          let state;
          do { state = await nextGame(client); } while (state.phase === phase);
          return state;
        }));
        expect(Date.now()).toBeLessThan(deadline + 500);
        expect(states.every((state) => state.phase === nextPhase && state.actionDeadlineAt > deadline)).toBe(true);
      }
    } finally {
      for (const client of clients) client.close();
    }
  }, 10000);

  it("未开局发操作返回 error", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3300 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const userIds = ["single", "p1", "p2", "p3"].map((n) => createBetaUser(dependencies, n));
    const room = makeRoom(dependencies, userIds);

    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token: await tokens.issueUserToken(userIds[0]!), roomId: room.roomId });
    const ack = await client.next();
    expect((ack as { type: string }).type).toBe("room");

    await new Promise((r) => setTimeout(r, 100));
    client.send({ type: "discard", tile: 0 });
    const error = await client.next();
    expect((error as { type: string }).type).toBe("error");
    client.close();
  });

  it("拒绝伪造或无效的用户令牌", async () => {
    const { dependencies } = fixture();
    const port = 3400 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const userIds = ["owner", "p1", "p2", "p3"].map((name) => createBetaUser(dependencies, name));
    const room = makeRoom(dependencies, userIds);
    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token: "forged-token", roomId: room.roomId });
    await expect(client.next()).resolves.toMatchObject({ type: "error", message: "INVALID_USER_TOKEN" });
    client.close();
  });

  it("REST 已开局时，首个玩家认证后自动恢复实时对局", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3500 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const userIds = ["owner", "p1", "p2", "p3"].map((name) => createBetaUser(dependencies, name));
    const room = makeRoom(dependencies, userIds);
    room.start(userIds[0]!);

    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token: await tokens.issueUserToken(userIds[0]!), roomId: room.roomId });
    await expect(client.next()).resolves.toMatchObject({
      type: "game",
      state: { roomId: room.roomId, roundNumber: 1, phase: "swapping" },
    });
    client.close();
  });

  /** 打到行牌阶段的一局，用来当作「进程重启前存下的存档」。 */
  function storedRound(userIds: readonly string[]): ReturnType<MahjongGame["serialize"]> {
    const table = new MahjongGame(4242, [userIds[0]!, userIds[1]!, userIds[2]!, userIds[3]!]);
    for (const id of userIds) table.autoSwap(id);
    for (const id of userIds) table.autoMissing(id);
    return table.serialize();
  }

  function staleStore(state: ReturnType<MahjongGame["serialize"]>, roundNumber: number): GameStateStore {
    return {
      save() {},
      clear() {},
      async load() {
        return { roundNumber, state };
      },
    };
  }

  it("重启后按存档接着打同一局，而不是从头开一局", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3600 + Math.floor(Math.random() * 100);
    const userIds = ["owner", "p1", "p2", "p3"].map((name) => createBetaUser(dependencies, name));
    const room = makeRoom(dependencies, userIds);
    room.start(userIds[0]!);
    // 已经打完两局，存档里是正在打的第 3 局。
    room.completedRounds = 2;
    const saved = storedRound(userIds);
    dependencies.gameStateStore = staleStore(saved, 3);

    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token: await tokens.issueUserToken(userIds[0]!), roomId: room.roomId });

    const resumed = await client.next();
    expect(resumed).toMatchObject({ type: "game", state: { roomId: room.roomId, roundNumber: 3, phase: "playing" } });
    // 接的是存档里的手牌，不是重新发的牌。
    const hand = (resumed as { state: { hand: number[] } }).state.hand;
    expect([...hand].sort((left, right) => left - right))
      .toEqual([...saved.players[0]!.hand].sort((left, right) => left - right));
    client.close();
  });

  it("账号在连接期间被停用（封禁或注销）后，下一次操作就被踢下线", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3800 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const userIds = ["owner", "p1", "p2", "p3"].map((name) => createBetaUser(dependencies, name));
    const room = makeRoom(dependencies, userIds);

    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token: await tokens.issueUserToken(userIds[0]!), roomId: room.roomId });
    await expect(client.next()).resolves.toMatchObject({ type: "room" });

    // 他还连着的时候账号被停用。认证只在握手时做过一次，所以这一步必须靠
    // 「每次操作重新确认状态」才能立刻生效 —— 否则 socket 开着的人可以一直用下去。
    dependencies.accountAdministration.changeStatus(
      dependencies.accountStore.findAccountById(userIds[0]!)!,
      { adminId: "admin", role: "super_admin" },
      "permanently_banned",
      "违规",
    );

    client.send({ type: "start" });
    await expect(client.next()).resolves.toMatchObject({ type: "error", message: "ACCOUNT_NOT_ACTIVE" });
    client.close();
  }, 30000);

  it("忽略属于上一局的存档，改为开下一局", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3700 + Math.floor(Math.random() * 100);
    const userIds = ["owner", "p1", "p2", "p3"].map((name) => createBetaUser(dependencies, name));
    const room = makeRoom(dependencies, userIds);
    room.start(userIds[0]!);
    room.completedRounds = 3;
    // 存档写的是第 3 局 —— 那一局已经结算过了。接上去会把同一局重复记进战绩。
    dependencies.gameStateStore = staleStore(storedRound(userIds), 3);

    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token: await tokens.issueUserToken(userIds[0]!), roomId: room.roomId });

    await expect(client.next()).resolves.toMatchObject({
      type: "game",
      state: { roomId: room.roomId, roundNumber: 4, phase: "swapping" },
    });
    client.close();
  });

  it("快照写入按时间窗节流：窗口内的多次行动只写一次", async () => {
    const { dependencies, tokens } = fixture();
    const port = 3750 + Math.floor(Math.random() * 100);
    const saves: Array<{ roomId: string; roundNumber: number }> = [];
    dependencies.gameStateStore = {
      save(roomId, roundNumber) {
        saves.push({ roomId, roundNumber });
      },
      clear() {},
      async load() {
        return undefined;
      },
    };

    // 节流窗口设得很大，测试期间所有行动都落在同一个窗口里，只有第一次会落盘。
    const wss = await createWebSocketServer(dependencies, port, { saveIntervalMs: 60_000 });
    wssInstances.push(wss);

    const userIds = ["owner", "p1", "p2", "p3"].map((name) => createBetaUser(dependencies, name));
    const room = makeRoom(dependencies, userIds);
    const clients: TestClient[] = [];
    for (const id of userIds) {
      const client = new TestClient();
      await client.connect(port);
      client.send({ type: "auth", token: await tokens.issueUserToken(id), roomId: room.roomId });
      await expect(client.next()).resolves.toMatchObject({ type: "room" });
      clients.push(client);
    }

    // 开局：首次广播会落盘一次。
    clients[0]!.send({ type: "start" });
    await Promise.all(clients.map((c) => c.next()));
    expect(saves.length).toBe(1);

    // 四人换三张 + 定缺：这些状态变化都发生在同一时间窗内，不应再触发落盘。
    for (const client of clients) client.send({ type: "auto-swap" });
    await Promise.all(clients.map((c) => c.next()));
    for (const client of clients) client.send({ type: "auto-missing" });
    await Promise.all(clients.map((c) => c.next()));
    expect(saves.length).toBe(1);

    // 落盘的始终是同一个房间、同一局（开局后 roundNumber 未变）。
    expect(saves[0]).toEqual({ roomId: room.roomId, roundNumber: 1 });

    for (const client of clients) client.close();
  }, 30000);
});

describe("WebSocket 群聊推送", () => {
  /** 建一个群，把 `memberIds` 加进去。 */
  async function makeGroup(
    app: ReturnType<typeof createApp>,
    tokens: TokenService,
    ownerId: string,
    memberIds: readonly string[],
  ): Promise<{ groupId: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/v1/groups",
      headers: { authorization: `Bearer ${await tokens.issueUserToken(ownerId)}` },
      payload: { name: "群聊" },
    });
    expect(created.statusCode).toBe(201);
    for (const memberId of memberIds) {
      const joined = await app.inject({
        method: "POST",
        url: "/v1/groups/join",
        headers: { authorization: `Bearer ${await tokens.issueUserToken(memberId)}` },
        payload: { groupNo: created.json().groupNo },
      });
      expect(joined.statusCode).toBe(200);
    }
    return { groupId: created.json().groupId as string };
  }

  /** 连上、认证（不绑房间）、订阅一个群。 */
  async function subscribedClient(port: number, token: string, userId: string, groupId: string): Promise<TestClient> {
    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token });
    await expect(client.next()).resolves.toMatchObject({ type: "ready", userId });
    client.send({ type: "group-subscribe", groupId });
    await expect(client.next()).resolves.toMatchObject({ type: "group-subscribed", groupId });
    return client;
  }

  it("群消息、撤回、群公告与全员禁言都实时推送", async () => {
    const { app, dependencies, tokens } = fixture();
    const port = 3900 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const owner = createBetaUser(dependencies, "群主");
    const member = createBetaUser(dependencies, "成员");
    const { groupId } = await makeGroup(app, tokens, owner, [member]);
    const ownerToken = await tokens.issueUserToken(owner);
    const client = await subscribedClient(port, await tokens.issueUserToken(member), member, groupId);

    // REST 发消息，订阅的成员立刻收到推送。
    const sent = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { type: "text", content: "大家好" },
    });
    expect(sent.statusCode).toBe(201);
    const pushed = await client.next();
    expect(pushed).toMatchObject({
      type: "group-message",
      groupId,
      message: { content: "大家好", senderId: owner, recalledAt: null },
    });

    // 撤回：推的是「已撤回」的视图，不是原始内容。
    const messageId = (pushed as { message: { messageId: string } }).message.messageId;
    await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/messages/${messageId}/recall`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "group-message-recalled",
      groupId,
      message: { messageId, content: "[消息已撤回]" },
    });

    await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/notice`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { notice: " 今晚八点开局 " },
    });
    await expect(client.next()).resolves.toMatchObject({ type: "group-updated", groupId, notice: "今晚八点开局" });

    await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/all-mute`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { enabled: true },
    });
    await expect(client.next()).resolves.toMatchObject({ type: "group-updated", groupId, allMuted: true });

    client.close();
  }, 30000);

  it("不是群成员的人订阅会被拒绝", async () => {
    const { app, dependencies, tokens } = fixture();
    const port = 4000 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const owner = createBetaUser(dependencies, "群主");
    const outsider = createBetaUser(dependencies, "外人");
    const { groupId } = await makeGroup(app, tokens, owner, []);

    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "auth", token: await tokens.issueUserToken(outsider) });
    await expect(client.next()).resolves.toMatchObject({ type: "ready" });
    client.send({ type: "group-subscribe", groupId });
    await expect(client.next()).resolves.toMatchObject({
      type: "error",
      message: "User is not a group member",
    });
    client.close();
  });

  it("被移出群的成员立刻停止收到消息", async () => {
    const { app, dependencies, tokens } = fixture();
    const port = 4100 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const owner = createBetaUser(dependencies, "群主");
    const member = createBetaUser(dependencies, "成员");
    const { groupId } = await makeGroup(app, tokens, owner, [member]);
    const ownerToken = await tokens.issueUserToken(owner);
    const client = await subscribedClient(port, await tokens.issueUserToken(member), member, groupId);

    const removed = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/members/${member}/remove`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(removed.statusCode).toBe(204);
    await expect(client.next()).resolves.toMatchObject({ type: "group-removed", groupId });

    // 被移出之后，群里的新消息不再推给他。
    await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { type: "text", content: "他看不到这条" },
    });
    await expect(client.next(200)).rejects.toThrow("timeout");

    client.close();
  }, 30000);

  it("没认证就订阅群会被拒绝", async () => {
    const { app, dependencies, tokens } = fixture();
    const port = 4200 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const owner = createBetaUser(dependencies, "群主");
    const { groupId } = await makeGroup(app, tokens, owner, []);

    const client = new TestClient();
    await client.connect(port);
    client.send({ type: "group-subscribe", groupId });
    await expect(client.next()).resolves.toMatchObject({ type: "error", message: "Not authenticated" });
    client.close();
  });

  it("群被解散时推送通知并作废订阅", async () => {
    const { app, dependencies, tokens } = fixture();
    const port = 4300 + Math.floor(Math.random() * 100);
    const wss = await createWebSocketServer(dependencies, port);
    wssInstances.push(wss);

    const owner = createBetaUser(dependencies, "解散群主");
    const member = createBetaUser(dependencies, "被解散群员");
    const { groupId } = await makeGroup(app, tokens, owner, [member]);
    const client = await subscribedClient(port, await tokens.issueUserToken(member), member, groupId);

    const dissolved = await app.inject({
      method: "POST",
      url: `/v1/groups/${groupId}/dissolve`,
      headers: { authorization: `Bearer ${await tokens.issueUserToken(owner)}` },
    });
    expect(dissolved.statusCode).toBe(204);

    // 群已经不存在，订阅必须一起作废，否则客户端会一直挂着一个死订阅。
    await expect(client.next()).resolves.toMatchObject({ type: "group-dissolved", groupId });
    client.close();
  }, 30000);
});

function suitOf(tile: Tile): Suit {
  return (["wan", "tong", "tiao"] as const)[Math.floor(tile / 9)]!;
}

/**
 * 一直读到出现满足条件的帧（超时抛错），中间的帧直接丢掉。
 *
 * 必须用这一种「同一个 waiter 反复读」的写法，不能用「短超时轮询 + 捕获」：
 * `TestClient.next` 超时后那个 waiter 不会被摘掉，下一次到达的帧会被喂给一个已经 reject 的
 * promise —— 帧被吞掉，后面的断言就会看到"少了几帧"这种莫名其妙的现象。
 */
async function readUntil(
  client: TestClient,
  predicate: (message: any) => boolean,
  timeoutMs = 20_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timeout waiting for a matching frame");
    const message = await client.next(remaining);
    if (predicate(message)) return message;
  }
}

/**
 * 等一个条件成立（轮询）。用于"断线"这类**不产生任何帧**的状态变化：
 * 客户端 destroy 掉 socket 之后，服务端要过一个事件循环才看得到 close，
 * 而 disconnect 本身不广播任何东西，没有帧可以等。
 */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("退出托管与重新接管", () => {
  let nextPort = 4300;

  /**
   * 四人开局并推进到「行牌」阶段。
   *
   * `roundsPlayed` 用来把开局点抬到「第 N+1 局」：`MatchRoom.completedRounds` 是公开字段，
   * `startMatch` 用 `completedRounds + 1` 当本局局号，所以设 1 就等于"这一局是第 2 局"。
   * 这样"第 2 局退出、第 4 局回来"不用真的先打一局半。
   */
  async function playingMatch(options: {
    playTimeoutMs?: number;
    claimTimeoutMs?: number;
    interRoundPauseMs?: number;
    reconnectWindowMs?: number;
    roundsPlayed?: number;
  } = {}) {
    const { dependencies, tokens } = fixture();
    const port = (nextPort += 1);
    const wss = await createWebSocketServer(dependencies, port, {
      playTimeoutMs: options.playTimeoutMs ?? 15_000,
      claimTimeoutMs: options.claimTimeoutMs ?? 8_000,
      interRoundPauseMs: options.interRoundPauseMs ?? 3_000,
      ...(options.reconnectWindowMs === undefined ? {} : { reconnectWindowMs: options.reconnectWindowMs }),
    });
    wssInstances.push(wss);

    const names = ["甲", "乙", "丙", "丁"];
    const userIds = names.map((name) => createBetaUser(dependencies, name));
    const room = makeRoom(dependencies, userIds);
    if (options.roundsPlayed !== undefined) room.completedRounds = options.roundsPlayed;

    const clients: TestClient[] = [];
    for (const id of userIds) {
      const client = new TestClient();
      await client.connect(port);
      client.send({ type: "auth", token: await tokens.issueUserToken(id), roomId: room.roomId });
      await readUntil(client, (message) => message.type === "room");
      clients.push(client);
    }

    clients[0]!.send({ type: "start" });
    for (const client of clients) {
      await readUntil(client, (message) => message.type === "game" && message.state.phase === "swapping");
    }
    for (const client of clients) client.send({ type: "auto-swap" });
    for (const client of clients) {
      await readUntil(client, (message) => message.type === "game" && message.state.phase === "missing");
    }
    for (const client of clients) client.send({ type: "auto-missing" });
    const states: any[] = [];
    for (const client of clients) {
      states.push((await readUntil(client, (message) => message.type === "game" && message.state.phase === "playing")).state);
    }

    return { dependencies, tokens, room, clients, userIds, states, port };
  }

  it("主动退出：立刻转托管，座位/手牌/积分一个都不少", async () => {
    const { room, clients, userIds } = await playingMatch();
    const before = room.players.get(userIds[1]!);
    const beforePlayers = room.players.size;
    const beforeSeat = before!.seat;
    const beforePoints = before!.account.points;

    clients[1]!.send({ type: "quit" });

    // 控制权立刻落到服务器手上 —— 不等 120 秒（那是异常断线的口径）
    await readUntil(clients[1]!, (message) => message.type === "game" && message.state.control === "trustee");
    expect(room.players.get(userIds[1]!)!.control).toBe("trustee");

    // 牌、座次、积分、大局归属全部保留
    expect(room.players.size).toBe(beforePlayers);
    expect(room.players.get(userIds[1]!)!.seat).toBe(beforeSeat);
    expect(room.players.get(userIds[1]!)!.account.points).toBe(beforePoints);
    expect(room.players.get(userIds[1]!)!.account.activeMatchId).toBe(room.roomId);
    expect(room.status).toBe("playing");

    // 另外三家看得见「这一座在托管」—— 否则会一直等"他怎么还不出牌"
    const seen = await readUntil(
      clients[0]!,
      (message) => message.type === "game"
        && message.state.players.some((player: any) => player.seat === beforeSeat && player.presence === "trustee"),
    );
    expect(seen.state.players.find((player: any) => player.seat === beforeSeat).presence).toBe("trustee");
  });

  it("托管座位：服务端不给可用操作，且发来的动作一律被拒", async () => {
    const { clients, userIds, room } = await playingMatch();
    clients[2]!.send({ type: "quit" });
    // 消费到"这一座已经托管"那一帧为止；它后面紧跟着的就是这一座的 actions 帧。
    await readUntil(clients[2]!, (message) => message.type === "game" && message.state.control === "trustee");

    // 1) 可用操作是空的 —— 两个客户端据此把牌桌置灰，
    //    不会出现"按钮亮着，点了才报错"。
    const actionsFrame = await clients[2]!.next();
    expect(actionsFrame).toEqual({ type: "actions", actions: [] });

    // 2) 硬闯：直接发一个出牌帧，必须被控制权闸门挡住（前端置灰不算权威）
    const hand = (await readUntil(clients[2]!, (message) => message.type === "game")).state.hand as Tile[];
    clients[2]!.send({ type: "discard", tile: hand[0]! });
    const error = await readUntil(clients[2]!, (message) => message.type === "error");
    expect(error.message).toBe("SEAT_UNDER_TRUSTEE");
    // 座位还在、人还在、牌局还在
    expect(room.players.get(userIds[2]!)!.seat).toBe(2);
    expect(room.players.has(userIds[2]!)).toBe(true);
    expect(room.status).toBe("playing");
  });

  it("重新接管：控制权回到人工，之后动作不再被控制权闸门挡住", async () => {
    const { clients, states, room, userIds } = await playingMatch({ playTimeoutMs: 30_000, claimTimeoutMs: 30_000 });
    // 让**当前该走的那一家**退出：托管的 delay 是 0，所以只有轮到他时状态才会前进
    const acting = states[0]!.currentPlayerSeat as number;

    clients[acting]!.send({ type: "quit" });
    await readUntil(clients[acting]!, (message) => message.type === "game" && message.state.control === "trustee");
    const drifted = await readUntil(
      clients[acting]!,
      (message) => message.type === "game" && message.state.discards.length > 0,
    );
    expect(drifted.state.control).toBe("trustee");

    clients[acting]!.send({ type: "request_takeover" });
    const taken = await readUntil(clients[acting]!, (message) => message.type === "game" && message.state.control === "human");
    expect(taken.state.control).toBe("human");
    expect(room.players.get(userIds[acting]!)!.control).toBe("human");

    // 幂等：再点一次不报错，也不改变什么
    clients[acting]!.send({ type: "request_takeover" });
    const again = await readUntil(clients[acting]!, (message) => message.type === "game" && message.state.control === "human");
    expect(again.state.control).toBe("human");

    /*
     * 真正的验收：接管之后人工动作要**进到引擎**，而不是被控制权闸门拦在门外。
     *
     * 这一手可能因为"还没轮到你"被引擎拒绝 —— 那不重要，重要的是拒绝的理由
     * 不能是 `SEAT_UNDER_TRUSTEE`。两种情况（这一步成功 / 因为时机被引擎拒）都说明闸门放行了，
     * 而"被闸门拦住"那一条在「托管座位」那个用例里已经单独验过。
     */
    const hand = (await readUntil(clients[acting]!, (message) => message.type === "game")).state.hand as Tile[];
    clients[acting]!.send({ type: "discard", tile: hand[0]! });
    const rejection = await readUntil(clients[acting]!, (message) => message.type === "error", 1200).catch(() => null);
    expect(rejection?.message ?? "").not.toBe("SEAT_UNDER_TRUSTEE");
  });

  it("从大厅回到牌桌：暂离标记被清掉，控制权不受影响", async () => {
    const { clients, room, userIds, port, tokens } = await playingMatch({ playTimeoutMs: 60_000, claimTimeoutMs: 60_000 });
    // 「返回大厅」走的是 REST 标记（见 POST /v1/rooms/:roomId/seat/presence），
    // 这里直接打在房间上，验的是**回到牌桌**那一半：握手时要把 away 清掉。
    room.markAway(userIds[3]!, true);
    expect(room.players.get(userIds[3]!)!.away).toBe(true);

    const returning = new TestClient();
    await returning.connect(port);
    returning.send({ type: "auth", token: await tokens.issueUserToken(userIds[3]!), roomId: room.roomId });
    const entered = await readUntil(returning, (message) => message.type === "game");
    expect(entered.state.away).toBe(false);
    // 暂离从来不动控制权：回来就能直接接着打，不需要「重新接管」
    expect(entered.state.control).toBe("human");
    expect(room.players.get(userIds[3]!)!.away).toBe(false);
    returning.close();
    clients[3]!.close();
  });

  it("接管不重建、不回滚：同一小场里手牌与弃牌与接管前完全一致", async () => {
    // 需求四：以服务器当前实时状态为准，不能回到退出时的旧状态，也不能重开这一局。
    const { clients, states } = await playingMatch({ playTimeoutMs: 60_000, claimTimeoutMs: 60_000 });
    // 让**当前该走的那一家**退出：托管是"立刻出牌"，所以只有轮到他时状态才会前进，
    // 由此能观察到"服务器替这一座打过牌了"，再验证接管接上的是打完之后的状态。
    const acting = states[0]!.currentPlayerSeat as number;
    clients[acting]!.send({ type: "quit" });
    await readUntil(clients[acting]!, (message) => message.type === "game" && message.state.control === "trustee");

    const drifted = await readUntil(
      clients[acting]!,
      (message) => message.type === "game" && message.state.discards.length > 0,
    );

    clients[acting]!.send({ type: "request_takeover" });
    const after = await readUntil(clients[acting]!, (message) => message.type === "game" && message.state.control === "human");

    expect(after.state.roundNumber).toBe(drifted.state.roundNumber);
    expect(after.state.hand).toEqual(drifted.state.hand);
    expect(after.state.discards).toEqual(drifted.state.discards);
    expect(after.state.tilesLeft).toBe(drifted.state.tilesLeft);
    expect(after.state.currentPlayerSeat).toBe(drifted.state.currentPlayerSeat);
  });

  it("托管刚出过一手就接管：不会再多出一张牌（一个座位只有一个控制来源）", async () => {
    // 这一条盯的是"已经排进事件循环队列的自动定时器"：
    // 它开火时如果发现控制权世代变了就必须放弃，否则会替一个已经回到人工的座位再打一手。
    const { clients, room, userIds } = await playingMatch({ playTimeoutMs: 60_000, claimTimeoutMs: 60_000 });
    clients[1]!.send({ type: "quit" });
    await readUntil(clients[1]!, (message) => message.type === "game" && message.state.control === "trustee");

    clients[1]!.send({ type: "request_takeover" });
    const taken = await readUntil(clients[1]!, (message) => message.type === "game" && message.state.control === "human");
    const handAfter = taken.state.hand.length;
    const discardsAfter = taken.state.discards.length;

    // 人工控制下的超时是 60 秒，所以这 400 毫秒里服务器**不该**再替这一座动任何一手。
    await new Promise((resolve) => setTimeout(resolve, 400));

    clients[1]!.send({ type: "request_takeover" }); // 只是要一帧最新的，不改状态
    const later = await readUntil(clients[1]!, (message) => message.type === "game" && message.state.roundNumber === taken.state.roundNumber);
    expect(later.state.hand.length).toBe(handAfter);
    expect(later.state.discards.length).toBe(discardsAfter);
    expect(room.players.get(userIds[1]!)!.control).toBe("human");
  });

  it("异常断线满 120 秒自动转托管；之后回来仍能进入并接管", async () => {
    // 新口径：120 秒是「人工控制权保留多久」，**不是**「禁止重新进入」。
    const { clients, room, userIds, port, tokens } = await playingMatch({
      playTimeoutMs: 60_000,
      claimTimeoutMs: 60_000,
      reconnectWindowMs: 150,
    });

    clients[2]!.close();
    // 断线这一步不广播任何帧，所以要等条件成立而不是等帧
    await waitFor(() => room.players.get(userIds[2]!)!.reconnectDeadline !== undefined);
    expect(room.players.get(userIds[2]!)!.control).toBe("human");

    // 到点：这一座交给服务器（并广播给另外三家）
    await readUntil(
      clients[0]!,
      (message) => message.type === "game"
        && message.state.players.some((player: any) => player.seat === 2 && player.presence === "trustee"),
      5000,
    );
    expect(room.players.get(userIds[2]!)!.control).toBe("trustee");

    // 人回来了：**允许进入**（不再抛 RECONNECT_WINDOW_EXPIRED），但进来≠接管
    const returning = new TestClient();
    await returning.connect(port);
    returning.send({ type: "auth", token: await tokens.issueUserToken(userIds[2]!), roomId: room.roomId });
    const entered = await readUntil(returning, (message) => message.type === "game");
    expect(entered.state.control).toBe("trustee");
    expect(entered.state.seat).toBe(2);

    returning.send({ type: "request_takeover" });
    const taken = await readUntil(returning, (message) => message.type === "game" && message.state.control === "human");
    expect(taken.state.control).toBe("human");
    expect(room.players.get(userIds[2]!)!.control).toBe("human");
    returning.close();
  });

  it("第 2 局退出、第 4 局才回来接管：拿到的是第 4 局的当前状态", async () => {
    const { clients, room, userIds } = await playingMatch({
      playTimeoutMs: 20,
      claimTimeoutMs: 20,
      interRoundPauseMs: 0,
      roundsPlayed: 1, // 本局 = 第 2 局
    });
    const firstRound = (await readUntil(clients[1]!, (message) => message.type === "game")).state.roundNumber;
    expect(firstRound).toBe(2);

    clients[1]!.send({ type: "quit" });
    await readUntil(clients[1]!, (message) => message.type === "game" && message.state.control === "trustee");

    // 一路托管到第 4 局
    await readUntil(clients[1]!, (message) => message.type === "game" && message.state.roundNumber >= 4);

    clients[1]!.send({ type: "request_takeover" });
    const taken = await readUntil(clients[1]!, (message) => message.type === "game" && message.state.control === "human");
    expect(taken.state.roundNumber).toBeGreaterThanOrEqual(4);
    expect(taken.state.roundNumber).not.toBe(2);
    expect(room.players.get(userIds[1]!)!.seat).toBe(1);
  });

  it("大局打完之后不能再接管（第 8 局结束）", async () => {
    const { clients, room } = await playingMatch({
      playTimeoutMs: 20,
      claimTimeoutMs: 20,
      interRoundPauseMs: 0,
      roundsPlayed: 7, // 这一局是第 8 局，打完就整场结束
    });

    clients[1]!.send({ type: "quit" });
    await readUntil(clients[1]!, (message) => message.type === "game" && message.state.control === "trustee");
    await readUntil(clients[1]!, (message) => message.type === "match-finished", 30_000);

    expect(room.status).toBe("finished");
    // 已结束的大局：接管请求被拒，而且托管/暂离关系已经作废
    for (const player of room.players.values()) expect(player.control).toBe("human");

    clients[1]!.send({ type: "request_takeover" });
    const error = await readUntil(clients[1]!, (message) => message.type === "error");
    expect(error.message).toBe("Match has not started");
  });

  it("暂离与回桌：另外三家实时看到「暂离」出现与消失", async () => {
    // 「返回大厅 → 显示暂离 → 回来 → 暂离消失」另外三家都必须实时看到。
    // 暂离走的是 REST，而房间里的状态变化只能由实时层广播 —— 中间那座桥就是 seatEvents。
    const { dependencies, tokens, clients, room, userIds, port } = await playingMatch({
      playTimeoutMs: 60_000,
      claimTimeoutMs: 60_000,
    });

    // 1) 返回大厅。REST 路由写完状态就会发这一条，这里直接模拟路由层那一发；
    //    路由自身"真的会发"由 app.test.ts 断言。
    expect(room.markAway(userIds[1]!, true)).toBe(true);
    dependencies.seatEvents.publish({ roomId: room.roomId, userId: userIds[1]! });

    for (const index of [0, 2, 3]) {
      const frame = await readUntil(clients[index]!, (message) => message.type === "game"
        && message.state.players.some((player: any) => player.seat === 1 && player.presence === "away"));
      const seat1 = frame.state.players.find((player: any) => player.seat === 1);
      expect(seat1.presence).toBe("away");
      // 暂离只是标签：座位、牌、控制权一样没动，他随时回来就能接着打
      expect(seat1.handSize).toBeGreaterThan(0);
      expect(room.players.get(userIds[1]!)!.control).toBe("human");
    }

    // 2) 回到牌桌：重新握手就够，暂离标记由服务端清掉
    const back = new TestClient();
    await back.connect(port);
    back.send({ type: "auth", token: await tokens.issueUserToken(userIds[1]!), roomId: room.roomId });
    expect((await readUntil(back, (message) => message.type === "game")).state.away).toBe(false);

    // 另外三家也要看到「暂离」消失（这一发正是本轮补上的那种广播）
    for (const index of [0, 2, 3]) {
      await readUntil(clients[index]!, (message) => message.type === "game"
        && message.state.players.some((player: any) => player.seat === 1 && player.presence === "online"), 30_000);
    }
    expect(room.players.get(userIds[1]!)!.away).toBe(false);
    expect(room.players.get(userIds[1]!)!.control).toBe("human");
    back.close();
  });

  it("暂离中主动退出按「托管」处理；重开页面不自动取消托管；接管后另外三家看到托管消失", async () => {
    const { tokens, clients, room, userIds, port } = await playingMatch({
      playTimeoutMs: 60_000,
      claimTimeoutMs: 60_000,
    });

    // 先暂离、再主动退出 —— 最容易写错的一条路径：
    // 必须按「退出」处理（control = trustee、暂离标记一并清掉），不能退化成普通暂离。
    expect(room.markAway(userIds[2]!, true)).toBe(true);
    clients[2]!.send({ type: "quit" });
    const quitted = await readUntil(
      clients[2]!,
      (message) => message.type === "game" && message.state.control === "trustee",
    );
    expect(quitted.state.away).toBe(false);
    expect(quitted.state.players.find((player: any) => player.seat === 2).presence).toBe("trustee");

    // 另外三家看到的是「托管中」，不是「暂离」
    for (const index of [0, 1, 3]) {
      await readUntil(clients[index]!, (message) => message.type === "game"
        && message.state.players.some((player: any) => player.seat === 2 && player.presence === "trustee"));
    }

    // 托管中重新打开网页：只清暂离，**不自动取消托管**
    const reopened = new TestClient();
    await reopened.connect(port);
    reopened.send({ type: "auth", token: await tokens.issueUserToken(userIds[2]!), roomId: room.roomId });
    expect((await readUntil(reopened, (message) => message.type === "game")).state.control).toBe("trustee");

    // 点「重新接管」：另外三家实时看到「托管中」消失
    reopened.send({ type: "request_takeover" });
    expect((await readUntil(
      reopened,
      (message) => message.type === "game" && message.state.control === "human",
    )).state.control).toBe("human");
    for (const index of [0, 1, 3]) {
      await readUntil(clients[index]!, (message) => message.type === "game"
        && message.state.players.some((player: any) => player.seat === 2 && player.presence === "online"), 30_000);
    }
    expect(room.players.get(userIds[2]!)!.control).toBe("human");
    expect(room.players.get(userIds[2]!)!.away).toBe(false);
    reopened.close();
  });

  it("没有定时器盯着也行：别人动一下，过期座位照样按墙钟交给服务器", async () => {
    // 定时器是调度手段，不是真相来源。这条走的是"没人给它排过定时器"的路径 ——
    // 也就是服务重启后从库里恢复出那个过期时刻的真实形态。
    const { clients, room, userIds } = await playingMatch({
      playTimeoutMs: 60_000,
      claimTimeoutMs: 60_000,
    });

    // 手工摆出"从库里读出来的旧时刻"：**没走 onClose**，所以没有任何内存定时器盯着它。
    const stranded = room.players.get(userIds[2]!)!;
    stranded.connected = false;
    stranded.reconnectDeadline = new Date(Date.now() - 1_000);

    // 另一家随便动一下 ⇒ 每一次操作前都会按墙钟重判一次
    clients[0]!.send({ type: "request_takeover" });

    for (const index of [0, 1, 3]) {
      await readUntil(clients[index]!, (message) => message.type === "game"
        && message.state.players.some((player: any) => player.seat === 2 && player.presence === "trustee"));
    }
    expect(stranded.control).toBe("trustee");
    // 转托管之后不留旧时刻
    expect(stranded.reconnectDeadline).toBeUndefined();
    // 而发起动作的这一家本身不受影响
    expect(room.players.get(userIds[0]!)!.control).toBe("human");
  });
});

