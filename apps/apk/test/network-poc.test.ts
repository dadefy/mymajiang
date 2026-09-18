import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, MatchSocket, type MatchState, type SocketEvent } from "@mianyang-mahjong/client";
import { createApp, createInMemoryDependencies } from "../../server/src/app.js";
import { TokenService } from "../../server/src/auth.js";
import { CryptoInvitationKeyCodec } from "../../server/src/invitation-key-codec.js";
import { createAttachedWebSocketServer } from "../../server/src/ws-server.js";
import { LayaHttpTransport, LayaSocketTransportFactory } from "../src/laya-transports.js";

type Handler = { caller: unknown; listener: (...args: unknown[]) => void; once: boolean };

class EventTargetMock {
  private readonly handlers = new Map<string, Handler[]>();

  on(type: string, caller: unknown, listener: (...args: unknown[]) => void): void {
    this.add(type, caller, listener, false);
  }

  once(type: string, caller: unknown, listener: (...args: unknown[]) => void): void {
    this.add(type, caller, listener, true);
  }

  protected emit(type: string, ...args: unknown[]): void {
    const current = this.handlers.get(type) ?? [];
    this.handlers.set(type, current.filter((entry) => !entry.once));
    for (const entry of current) entry.listener.apply(entry.caller, args);
  }

  private add(type: string, caller: unknown, listener: (...args: unknown[]) => void, once: boolean): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), { caller, listener, once }]);
  }
}

class HttpRequestMock extends EventTargetMock {
  data: unknown;
  http = { status: 0 };

  async send(url: string, data: string | null, method: string, _responseType: string, headers: string[]): Promise<void> {
    const requestHeaders: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 2) requestHeaders[headers[index]!] = headers[index + 1]!;
    try {
      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers: requestHeaders,
        ...(data === null ? {} : { body: data }),
      });
      this.http.status = response.status;
      const text = await response.text();
      this.data = text ? JSON.parse(text) : undefined;
      this.emit("complete");
    } catch (error) {
      this.http.status = 0;
      this.emit("error", error);
    }
  }
}

/**
 * 可编程的 `Laya.HttpRequest` 替身。
 *
 * 存在的理由：上面的 `HttpRequestMock` 永远把 `data` 设成**已经解析好的对象**，
 * 于是复现不了 Laya 3.4 在部分 201 响应上把 `data` 留成 `null` 的那个缺陷 ——
 * 而 `LayaHttpTransport` 里那条 `request.data ?? request.http.responseText` 兜底
 * 正是为它加的。这个替身让测试自己决定 `data` 与 `http.responseText` 各是什么，
 * 于是「201 兜底」「200 正常」「204 空响应体」「4xx 错误体」四条路径都能被钉住。
 */
class ScriptedHttpRequest extends EventTargetMock {
  data: unknown = undefined;
  http: { status: number; responseText?: string } = { status: 0 };
  responseType = "";
  url = "";

  async send(url: string, _data: string | null, _method: string, responseType: string): Promise<void> {
    this.url = url;
    this.responseType = responseType;
    httpResponder(this);
    this.emit("complete");
  }
}

/** 由每个用例自己决定这一帧怎么回来；默认什么都不设（等价于一次网络错误）。 */
let httpResponder: (request: ScriptedHttpRequest) => void = () => {};

class SocketMock extends EventTargetMock {
  static instances: SocketMock[] = [];
  connected = false;
  disableInput = false;
  private socket: WebSocket | null = null;

  constructor() {
    super();
    SocketMock.instances.push(this);
  }

  connectByUrl(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => { this.connected = true; this.emit("open"); });
    socket.addEventListener("message", (event) => this.emit("message", event.data));
    socket.addEventListener("close", () => { this.connected = false; this.emit("close"); });
    socket.addEventListener("error", (error) => this.emit("error", error));
  }

  send(payload: string): void {
    this.socket?.send(payload);
  }

  close(): void {
    this.socket?.close();
  }

  simulateDrop(): void {
    this.socket?.close();
  }
}

const EVENT = { COMPLETE: "complete", ERROR: "error", OPEN: "open", MESSAGE: "message", CLOSE: "close" };

function installLayaNetworkMock(): void {
  (globalThis as { Laya?: unknown }).Laya = {
    Event: EVENT,
    HttpRequest: HttpRequestMock,
    Socket: SocketMock,
  };
}

function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = probe();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for network PoC event"));
      }
    }, 20);
  });
}

describe("LayaAir network PoC", () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
    SocketMock.instances.length = 0;
    delete (globalThis as { Laya?: unknown }).Laya;
  });

  it("logs in, enters the lobby and room, receives a private snapshot, acts, and reconnects", async () => {
    installLayaNetworkMock();
    let userId = 1_900_000_000;
    let roomNo = 410_000;
    const secret = `${randomUUID()}${randomUUID()}`;
    const dependencies = createInMemoryDependencies({
      tokens: new TokenService(secret),
      invitationKeyCodec: new CryptoInvitationKeyCodec(),
      createKeyId: randomUUID,
      createUserId: () => String(++userId),
      createLedgerId: randomUUID,
      createRoomId: randomUUID,
      createRoomNo: () => String(++roomNo),
      createGroupId: randomUUID,
      createGroupNo: () => "51000001",
      createMessageId: randomUUID,
      createFriendRequestId: randomUUID,
      createAdminAuditId: randomUUID,
    });
    const app = createApp(dependencies);
    const wss = createAttachedWebSocketServer(app.server, dependencies);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    closeServer = async () => { wss.close(); await app.close(); };

    const baseUrl = `http://127.0.0.1:${port}`;
    const socketUrl = `ws://127.0.0.1:${port}`;
    const clients: ApiClient[] = [];
    for (let index = 0; index < 4; index += 1) {
      const key = dependencies.invitationKeys.issue({ count: 1, note: "Laya PoC", actorId: "test" })[0]!.key;
      const client = new ApiClient(new LayaHttpTransport(baseUrl));
      const activated = await client.activate(key, `玩家${index + 1}`, "https://example.com/avatar.png");
      if (!activated.ok) throw new Error(JSON.stringify(activated.error));
      expect(activated).toMatchObject({ ok: true });
      dependencies.accountStore.findAccountById(activated.value.userId)!.points = 2_000;
      expect((await client.me()).ok).toBe(true);
      clients.push(client);
    }

    const created = await clients[0]!.createRoom("laya-network-poc");
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    for (const client of clients.slice(1)) expect((await client.joinRoom(created.value.roomNo)).ok).toBe(true);
    const room = await clients[0]!.room(created.value.roomId);
    expect(room.ok && room.value.players).toHaveLength(4);

    const sockets = clients.map((client) => new MatchSocket({
      url: socketUrl,
      token: client.token!,
      factory: new LayaSocketTransportFactory(),
    }));
    const events: SocketEvent[][] = sockets.map(() => []);
    sockets.forEach((socket, index) => socket.on((event) => events[index]!.push(event)));
    await Promise.all(sockets.map((socket) => socket.connect(created.value.roomId)));
    await Promise.all(events.map((received) => waitFor(() => received.find((event) => event.kind === "connected"))));

    sockets[0]!.send({ type: "start" });
    const firstGame = await waitFor(() => events[0]!.find((event): event is Extract<SocketEvent, { kind: "game" }> => event.kind === "game"));
    const state: MatchState = firstGame.state;
    expect(state.hand.length).toBeGreaterThan(0);
    expect(state.players).toHaveLength(4);
    expect(state.players.every((player) => !("hand" in player))).toBe(true);
    expect(state.control ?? "human").toBe("human");
    expect(state.away ?? false).toBe(false);
    expect(state.players.every((player) => typeof player.roundDelta === "number" && typeof player.matchDelta === "number")).toBe(true);

    sockets[0]!.send({ type: "auto-swap" });
    await waitFor(() => events[0]!.filter((event) => event.kind === "game").length >= 2 ? true : undefined);

    const oldSocketCount = SocketMock.instances.length;
    SocketMock.instances[0]!.simulateDrop();
    await waitFor(() => events[0]!.find((event) => event.kind === "reconnected"), 8_000);
    expect(SocketMock.instances.length).toBeGreaterThan(oldSocketCount);
    const reconnectedGame = await waitFor(() => {
      const reconnectedAt = events[0]!.findIndex((event) => event.kind === "reconnected");
      return events[0]!.slice(reconnectedAt + 1).find((event): event is Extract<SocketEvent, { kind: "game" }> => event.kind === "game");
    });
    expect(reconnectedGame.state.roomId).toBe(created.value.roomId);

    sockets.forEach((socket) => socket.close());
  });
});

/**
 * 201 修复的回归覆盖。
 *
 * `LayaHttpTransport` 把响应类型从 `json` 改成 `text`，并加了
 * `request.data ?? request.http.responseText` 兜底 —— 这两处都是冲着 Laya 3.4
 * 在部分 201 响应上把 `data` 留成 `null` 的真实缺陷做的。但上面那个端到端 PoC
 * 用的替身永远把 `data` 设成解析好的对象，一次都走不到那条路径，所以这里把缺陷
 * 本身复现出来钉住它，同时确认 200 / 204 / 4xx 没被这次改动带偏。
 */
describe("LayaAir HTTP transport", () => {
  const transport = new LayaHttpTransport("http://example.test");

  function install(responder: (request: ScriptedHttpRequest) => void): void {
    httpResponder = responder;
    (globalThis as { Laya?: unknown }).Laya = { Event: EVENT, HttpRequest: ScriptedHttpRequest, Socket: SocketMock };
  }

  afterEach(() => {
    httpResponder = () => {};
    delete (globalThis as { Laya?: unknown }).Laya;
  });

  it("reads a 201 body out of responseText when Laya leaves data null", async () => {
    // 缺陷原样：201 + `json` 模式时 data 是 null，只有 responseText 有内容。
    // 修复前这里会 resolve 成 `body: undefined`，建房/建群的成功响应全被读成空。
    install((request) => {
      request.http = { status: 201, responseText: JSON.stringify({ roomId: "room-1", roomNo: "410001" }) };
      request.data = null;
    });
    const response = await transport.request<{ roomId: string }>({ method: "POST", path: "/v1/rooms", body: {} });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ roomId: "room-1", roomNo: "410001" });
  });

  it("keeps the ordinary 200 path working when the engine already parsed the body", async () => {
    install((request) => {
      request.http = { status: 200, responseText: JSON.stringify({ userId: "1900000001" }) };
      request.data = { userId: "1900000001" };
    });
    const response = await transport.request<{ userId: string }>({ method: "GET", path: "/v1/me" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "1900000001" });
  });

  it("also reads a 200 body from responseText when data is null", async () => {
    install((request) => {
      request.http = { status: 200, responseText: JSON.stringify({ points: 1500 }) };
      request.data = null;
    });
    const response = await transport.request<{ points: number }>({ method: "GET", path: "/v1/me" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ points: 1500 });
  });

  it("treats an empty 204 body as undefined instead of throwing", async () => {
    // 204 没有响应体，三种「空」的写法都要落在 `undefined` 上，不能抛 JSON 解析错。
    for (const empty of [null, "", undefined]) {
      install((request) => {
        request.http = { status: 204, responseText: "" };
        request.data = empty;
      });
      const response = await transport.request({ method: "POST", path: "/v1/rooms/r1/seat/presence", body: {} });
      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
    }
  });

  it("still surfaces a JSON error body on 4xx", async () => {
    install((request) => {
      request.http = { status: 409, responseText: JSON.stringify({ error: "Room is full" }) };
      request.data = null;
    });
    const response = await transport.request<{ error: string }>({ method: "POST", path: "/v1/rooms/join", body: {} });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Room is full" });
  });

  it("asks the engine for text so every status shares one reliable path", async () => {
    const seen: ScriptedHttpRequest[] = [];
    install((request) => {
      seen.push(request);
      request.http = { status: 200, responseText: "{}" };
      request.data = null;
    });
    await transport.request({ method: "GET", path: "/v1/me" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.responseType).toBe("text");
    expect(seen[0]!.url).toBe("http://example.test/v1/me");
  });

  it("rejects with NETWORK_ERROR when no status ever arrives", async () => {
    install((request) => {
      request.http = { status: 0 };
    });
    await expect(transport.request({ method: "GET", path: "/v1/me" })).rejects.toThrow("NETWORK_ERROR");
  });
});
