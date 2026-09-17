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
