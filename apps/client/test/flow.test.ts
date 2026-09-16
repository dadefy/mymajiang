import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { ClientFlow } from "../src/flow.js";
import { FakeHttpTransport, FakeSocketFactory, FakeUploadTransport, type FakeSocketTransport } from "./fakes.js";

const SESSION = {
  userId: "1234567890",
  nickname: "张三",
  avatarUrl: "avatar",
  status: "active" as const,
  points: 0,
  /** 没有进行中的对局；要测「回到房间」的用例自己覆盖这一项。 */
  activeRoom: null,
  token: "jwt-1",
};

/** 有对局在等着的登录响应：主页应当给出「回到对局」入口。 */
const SESSION_WITH_ACTIVE_ROOM = {
  ...SESSION,
  activeRoom: { roomId: "room-1", roomNo: "654321", status: "playing" as const, playerCount: 4 },
};

function flowWith() {
  const transport = new FakeHttpTransport();
  const sockets = new FakeSocketFactory();
  const uploads = new FakeUploadTransport();
  const flow = new ClientFlow(new ApiClient(transport), sockets, "ws://127.0.0.1:3001", uploads);
  const screens: Array<{ name: string }> = [];
  flow.onChange((screen) => screens.push({ name: screen.name }));
  return { transport, sockets, uploads, flow, screens, http: transport };
}

/** 主页要的两个列表；不注册的话 refreshHome 会把错误带进页面。 */
function stubHome(transport: FakeHttpTransport, groups: unknown[] = [], matches: unknown[] = []): void {
  transport.onJson("GET", "/v1/groups", 200, { groups });
  transport.onJson("GET", "/v1/matches", 200, { matches });
}

function stubRoom(transport: FakeHttpTransport, roomId: string, roomNo = "123456"): void {
  transport.onJson("POST", "/v1/rooms", 201, { roomId, roomNo, status: "waiting" });
  transport.onJson("GET", `/v1/rooms/${roomId}`, 200, {
    roomId,
    roomNo,
    ruleVersion: "MIANYANG_XZ_1_0",
    status: "waiting",
    ownerId: SESSION.userId,
    completedRounds: 0,
    players: [],
    result: null,
  });
  transport.onJson("POST", `/v1/rooms/${roomId}/leave`, 204);
}

function groupMessage(messageId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId,
    senderId: SESSION.userId,
    senderNickname: "张三",
    sentAt: "2026-09-16T04:00:00.000Z",
    type: "text",
    content: `内容 ${messageId}`,
    recalledAt: null,
    ...overrides,
  };
}

/** 群详情与一页消息；`nextCursor` 决定还有没有更早的可以翻。 */
function stubChat(transport: FakeHttpTransport, groupId: string, messages: unknown[] = [], nextCursor?: string): void {
  transport.onJson("GET", `/v1/groups/${groupId}`, 200, {
    groupId,
    groupNo: "12345678",
    name: "牌友群",
    ownerId: SESSION.userId,
    notice: "",
    allMuted: false,
    memberCount: 2,
    role: "owner",
    members: [],
  });
  transport.onJson("GET", `/v1/groups/${groupId}/messages`, 200, {
    groupId,
    messages,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

/** 登录并进到 g1 的群聊页面 —— 发图与群聊相关的用例都从这里开始。 */
async function chatWith() {
  const context = flowWith();
  context.http.onJson("POST", "/v1/auth/login", 200, SESSION);
  stubHome(context.http);
  await context.flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
  stubChat(context.http, "g1", [groupMessage("m1")]);
  await context.flow.openChat("g1");
  return { ...context, socket: context.sockets.last() };
}

/** 一张图片的直传票据，`objectKey` 是发消息时要填的 content。 */
function uploadTicket(objectKey: string): Record<string, unknown> {
  return {
    objectKey,
    uploadUrl: `https://bucket.example.com/${objectKey}?sign=abc`,
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    expiresInSeconds: 60,
  };
}

describe("ClientFlow", () => {
  it("已激活的密钥直接进主页；没激活的进资料页", async () => {
    const first = flowWith();
    first.http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(first.http);
    await first.flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    expect(first.flow.current).toMatchObject({ name: "home", me: { userId: SESSION.userId, points: 0 } });
    // home 会出现两次：先给一个空的加载态，列表回来后再给一次。
    expect(first.screens.map((screen) => screen.name)).toEqual(["key-entry", "home", "home"]);

    const second = flowWith();
    second.http.onJson("POST", "/v1/auth/login", 409, { code: "KEY_ACTIVATION_REQUIRED" });
    await second.flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    expect(second.flow.current).toMatchObject({ name: "profile", key: "MYMJ-7K3M-9QXA-2WET-5ZVB" });
  });

  it("激活失败的错误会显示在资料页上", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 409, { code: "KEY_ACTIVATION_REQUIRED" });
    http.onJson("POST", "/v1/auth/activate", 401, { code: "KEY_REVOKED" });

    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    await flow.submitProfile("MYMJ-7K3M-9QXA-2WET-5ZVB", "张三", "a");

    expect(flow.current).toMatchObject({ name: "profile", error: "邀请密钥已被撤销" });
  });

  it("建房后进入房间页并完成 auth 握手，离开时回主页", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    http.requests.length = 0;
    stubRoom(http, "room-1");

    await flow.createRoom();

    expect(flow.current).toMatchObject({ name: "room", roomId: "room-1" });
    expect(sockets.last().sent[0]).toEqual({ type: "auth", token: SESSION.token, roomId: "room-1" });

    await flow.leaveRoom();
    expect(flow.current.name).toBe("home");
    expect(sockets.last().closed).toBe(true);
    expect(http.requests.some((request) => request.path === "/v1/rooms/room-1/leave")).toBe(true);
  });

  it("实时帧驱动房间页：牌局状态、动作集合、单局结算", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubRoom(http, "room-1");
    await flow.createRoom();
    const socket: FakeSocketTransport = sockets.last();

    const state = { roomId: "room-1", roundNumber: 1, seat: 0, phase: "swapping" as const, hand: [] };
    socket.serverSends({ type: "game", state });
    socket.serverSends({ type: "actions", actions: ["swap"] });
    expect(flow.current).toMatchObject({ name: "room", match: state, actions: ["swap"] });

    const result = { reason: "three-winners" as const, deltas: [], winnerSeats: [0], nextDealerSeat: 1 };
    socket.serverSends({ type: "round-finished", roundNumber: 1, result });
    expect(flow.current).toMatchObject({ name: "room", lastResult: result });

    socket.serverSends({ type: "match-finished", result });
    expect(flow.current).toMatchObject({ name: "room", lastResult: result, match: null, actions: [] });
  });

  it("行牌动作都走实时通道", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubRoom(http, "room-1");
    await flow.createRoom();
    const socket = sockets.last();
    socket.sent.length = 0;

    flow.autoSwap();
    flow.chooseMissing("tong");
    flow.discard(13);
    flow.claim("pass");

    expect(socket.sent).toEqual([
      { type: "auto-swap" },
      { type: "missing", suit: "tong" },
      { type: "discard", tile: 13 },
      { type: "claim", action: "pass" },
    ]);
    expect(() => flow.claim("fly")).toThrow("Unsupported claim action");
  });

  it("断线提示与恢复", async () => {
    vi.useFakeTimers();
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubRoom(http, "room-1");
    await flow.createRoom();
    const first = sockets.last();

    first.serverCloses();
    expect(flow.current).toMatchObject({ name: "room", notice: "连接已断开，正在重连…" });

    // 退避 500ms 后自动重连；重连成功会清掉提示，新通道继续推帧。
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets.created).toHaveLength(2);
    expect(flow.current).toMatchObject({ name: "room", notice: undefined });

    sockets.last().serverSends({ type: "game", state: { roomId: "room-1", phase: "missing" as const } });
    expect(flow.current).toMatchObject({ name: "room", notice: undefined, match: { phase: "missing" } });
    expect(first.closed).toBe(true);
  });

  it("战绩不可用（内存模式）不算错误，只在主页说明", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    http.onJson("GET", "/v1/groups", 200, { groups: [] });
    // 没配数据库时服务端**按设计**返回 501。内测时每个人都会碰到它，
    // 写成「操作失败」会让人以为系统坏了 —— 所以它只该是主页上的一句说明。
    http.onJson("GET", "/v1/matches", 501, { code: "MATCH_HISTORY_UNAVAILABLE" });

    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    expect(flow.current).toMatchObject({
      name: "home",
      me: { userId: SESSION.userId },
      groups: [],
      matches: [],
      matchesUnavailable: true,
    });
    expect(flow.current).not.toHaveProperty("error");
  });

  it("群列表拉取失败时留在主页并提示，不弹回登录", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    http.onJson("GET", "/v1/groups", 500, { code: "BOOM" });
    http.onJson("GET", "/v1/matches", 200, { matches: [] });

    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    // 真正的失败仍然要提示出来 —— 上面那条「不算错误」不能把这类也吞掉。
    expect(flow.current).toMatchObject({
      name: "home",
      groups: [],
      matches: [],
      error: "操作失败（BOOM）",
    });
  });

  it("登出会清掉实时通道并回到密钥输入页", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    flow.signOut();

    expect(flow.current).toEqual({ name: "key-entry", busy: false });
    expect(sockets.created.every((socket) => socket.closed)).toBe(true);
  });

  it("进群聊会拉群详情与消息，并订阅这个群（连接不绑房间）", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubChat(http, "g1", [groupMessage("m1")]);

    await flow.openChat("g1");

    expect(flow.current).toMatchObject({ name: "chat", groupId: "g1", meId: SESSION.userId, hasEarlier: false });
    // 群聊连接不带 roomId：auth 之后紧跟一条订阅帧。
    expect(sockets.last().sent[0]).toEqual({ type: "auth", token: SESSION.token });
    expect(sockets.last().sent[1]).toEqual({ type: "group-subscribe", groupId: "g1" });
    expect(flow.current).toMatchObject({ messages: [{ messageId: "m1" }] });
  });

  it("群聊页面的实时推送会追加消息，别的群的消息不会打扰这一页", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubChat(http, "g1", [groupMessage("m1")]);
    await flow.openChat("g1");

    const socket = sockets.last();
    socket.serverSends({ type: "group-message", groupId: "g2", message: groupMessage("x9") });
    socket.serverSends({ type: "group-message", groupId: "g1", message: groupMessage("m2") });

    const screen = flow.current;
    expect(screen.name).toBe("chat");
    expect(screen.name === "chat" ? screen.messages.map((message) => message.messageId) : []).toEqual(["m1", "m2"]);
  });

  it("自己发的消息不会因为「接口返回值 + 实时推送」显示两次", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubChat(http, "g1", [groupMessage("m1")]);
    await flow.openChat("g1");
    http.onJson("POST", "/v1/groups/g1/messages", 201, groupMessage("m2"));

    await flow.sendText("  大家好  ");
    // 服务端随后把同一条推回来。
    sockets.last().serverSends({ type: "group-message", groupId: "g1", message: groupMessage("m2") });

    const screen = flow.current;
    const ids = screen.name === "chat" ? screen.messages.map((message) => message.messageId) : [];
    expect(ids).toEqual(["m1", "m2"]);
    // 发出去的是去掉首尾空白的文本。
    expect(http.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/groups/g1/messages",
      body: { type: "text", content: "大家好" },
    });
  });

  it("撤回后那条消息就地变成已撤回", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubChat(http, "g1", [groupMessage("m1"), groupMessage("m2")]);
    await flow.openChat("g1");
    http.onJson("POST", "/v1/groups/g1/messages/m1/recall", 200, groupMessage("m1", {
      content: "[消息已撤回]",
      recalledAt: "2026-09-16T04:05:00.000Z",
    }));

    await flow.recallMessage("m1");

    const screen = flow.current;
    expect(screen.name).toBe("chat");
    if (screen.name !== "chat") return;
    expect(screen.messages[0]).toMatchObject({ messageId: "m1", content: "[消息已撤回]" });
    expect(screen.messages[1]).toMatchObject({ messageId: "m2", recalledAt: null });
  });

  it("加载更早的一页会接在列表前面，翻完就没有了", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    // 先注册带游标的响应：假传输是「先注册的先匹配」。
    http.on(
      (request) => request.path.startsWith("/v1/groups/g1/messages?") && request.path.includes("before=cursor-1"),
      () => ({ status: 200, body: { groupId: "g1", messages: [groupMessage("m1")] } }),
    );
    stubChat(http, "g1", [groupMessage("m2")], "cursor-1");
    await flow.openChat("g1");

    expect(flow.current).toMatchObject({ hasEarlier: true });
    await flow.loadEarlier();

    const screen = flow.current;
    expect(screen.name).toBe("chat");
    if (screen.name !== "chat") return;
    expect(screen.messages.map((message) => message.messageId)).toEqual(["m1", "m2"]);
    // 服务端这一页没有给出游标，说明已经到头。
    expect(screen.hasEarlier).toBe(false);
  });

  it("回主页会退订并断开群聊通道，然后重拉主页列表", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubChat(http, "g1", [groupMessage("m1")]);
    await flow.openChat("g1");
    const socket = sockets.last();

    await flow.backHome();

    expect(flow.current.name).toBe("home");
    expect(socket.sent).toContainEqual({ type: "group-unsubscribe", groupId: "g1" });
    expect(socket.closed).toBe(true);
  });

  it("群聊页面的断线提示与恢复", async () => {
    vi.useFakeTimers();
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubChat(http, "g1", [groupMessage("m1")]);
    await flow.openChat("g1");

    sockets.last().serverCloses();
    expect(flow.current).toMatchObject({ name: "chat", notice: "连接已断开，正在重连…" });

    await vi.advanceTimersByTimeAsync(500);
    expect(sockets.created).toHaveLength(2);
    // 重连要重放订阅，否则恢复连接后收不到群消息。
    expect(sockets.last().sent).toContainEqual({ type: "group-subscribe", groupId: "g1" });
    expect(flow.current).toMatchObject({ name: "chat", notice: undefined });
    vi.useRealTimers();
  });

  it("发图片：签发直传地址 → 把字节 PUT 上去 → 用对象键发消息", async () => {
    const { flow, http, uploads } = await chatWith();
    const objectKey = "uploads/1234567890/image/blob-1";
    http.onJson("POST", "/v1/uploads", 201, uploadTicket(objectKey));
    http.onJson("POST", "/v1/groups/g1/messages", 201, groupMessage("m9", { type: "image", content: objectKey }));

    await flow.sendImage({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" });

    // 字节直接打到对象存储，并带上服务端给的头（内容类型参与签名）。
    expect(uploads.requests).toHaveLength(1);
    expect(uploads.requests[0]).toMatchObject({
      url: `https://bucket.example.com/${objectKey}?sign=abc`,
      method: "PUT",
      headers: { "Content-Type": "image/png" },
    });
    expect([...uploads.requests[0]!.body]).toEqual([1, 2, 3]);
    // 发消息时传的是对象键，不是那个带签名的地址。
    expect(http.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/groups/g1/messages",
      body: { type: "image", content: objectKey },
    });
    const screen = flow.current;
    expect(screen.name).toBe("chat");
    if (screen.name !== "chat") return;
    expect(screen.messages.map((message) => message.messageId)).toEqual(["m1", "m9"]);
    expect(screen.uploading).toBe(false);
  });

  it("服务器没开图片上传时给出明确提示，且不会去直传", async () => {
    const { flow, http, uploads } = await chatWith();
    http.onJson("POST", "/v1/uploads", 501, { code: "STORAGE_UNAVAILABLE" });

    await flow.sendImage({ bytes: new Uint8Array([1]), contentType: "image/png" });

    expect(uploads.requests).toHaveLength(0);
    expect(flow.current).toMatchObject({ error: "服务器没有开启图片上传", uploading: false });
  });

  it("直传被存储端拒绝时不会把消息发出去", async () => {
    const { flow, http, uploads } = await chatWith();
    http.onJson("POST", "/v1/uploads", 201, uploadTicket("uploads/1234567890/image/blob-2"));
    uploads.respondWith(403);

    await flow.sendImage({ bytes: new Uint8Array([1]), contentType: "image/png" });

    expect(flow.current).toMatchObject({ error: "图片上传失败（403）", uploading: false });
    expect(http.requests.some((request) => request.method === "POST" && request.path === "/v1/groups/g1/messages")).toBe(false);
  });

  it("直传网络不通时提示重试，而不是抛出去", async () => {
    const { flow, http, uploads } = await chatWith();
    http.onJson("POST", "/v1/uploads", 201, uploadTicket("uploads/1234567890/image/blob-3"));
    uploads.failWith(new Error("socket hang up"));

    await flow.sendImage({ bytes: new Uint8Array([1]), contentType: "image/png" });

    expect(flow.current).toMatchObject({ error: "图片上传失败，请检查网络后重试", uploading: false });
  });

  it("本地就挡掉超限的图片，不白传一次", async () => {
    const { flow, uploads } = await chatWith();

    await flow.sendImage({ bytes: new Uint8Array(5 * 1024 * 1024 + 1), contentType: "image/png" });

    expect(uploads.requests).toHaveLength(0);
    expect(flow.current).toMatchObject({ error: "图片不能超过 5 MB" });
  });

  it("上传不依赖当前页面：在主页里也能往指定群发图（浏览器调试面板就是这么做）", async () => {
    const { flow, http, uploads } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    const objectKey = "uploads/1234567890/image/blob-4";
    http.onJson("POST", "/v1/uploads", 201, uploadTicket(objectKey));
    http.onJson("POST", "/v1/groups/g1/messages", 201, groupMessage("m5", { type: "image", content: objectKey }));

    expect(flow.current.name).toBe("home");
    const sent = await flow.uploadGroupImage("g1", { bytes: new Uint8Array([7]), contentType: "image/png" });

    expect(sent).toMatchObject({ ok: true, value: { messageId: "m5" } });
    expect(uploads.requests).toHaveLength(1);
    // 页面没变，也不会把消息贴进不存在的列表里。
    expect(flow.current.name).toBe("home");
  });

  it("建房遇到网络错误会重试一次，两次用的是同一个幂等键", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    http.requests.length = 0;

    // 第一次抛异常（弱网下丢了响应），第二次成功。先注册的先匹配。
    let attempt = 0;
    http.on(
      (request) => request.method === "POST" && request.path === "/v1/rooms",
      () => {
        attempt += 1;
        if (attempt === 1) throw new Error("socket hang up");
        return { status: 201, body: { roomId: "room-1", status: "waiting" } };
      },
    );
    stubRoom(http, "room-1");

    await flow.createRoom();

    const calls = http.requests.filter((request) => request.path === "/v1/rooms");
    expect(calls).toHaveLength(2);
    // 关键在这里：重试复用同一个键，服务端才认得出「这是同一次操作」，
    // 否则它会把重试当成新请求，建出两间房。
    expect(calls[0]!.idempotencyKey).toBeDefined();
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    expect(flow.current).toMatchObject({ name: "room", roomId: "room-1" });
  });

  it("业务错误不重试（重试也不会变好）", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    http.requests.length = 0;
    http.onJson("POST", "/v1/rooms", 409, { code: "DOMAIN_CONFLICT" });

    await flow.createRoom();

    expect(http.requests.filter((request) => request.path === "/v1/rooms")).toHaveLength(1);
    expect(flow.current).toMatchObject({ name: "home" });
  });

  it("发消息遇到网络错误会重试一次，并且只贴出一条", async () => {
    const { flow, http } = await chatWith();
    http.requests.length = 0;

    let attempt = 0;
    http.on(
      (request) => request.method === "POST" && request.path === "/v1/groups/g1/messages",
      () => {
        attempt += 1;
        if (attempt === 1) throw new Error("timeout");
        return { status: 201, body: groupMessage("m7") };
      },
    );

    await flow.sendText("会重试");

    const calls = http.requests.filter((request) => request.path === "/v1/groups/g1/messages");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);

    const screen = flow.current;
    expect(screen.name).toBe("chat");
    if (screen.name !== "chat") return;
    // 第二次的返回值贴进来只有一条。
    expect(screen.messages.filter((message) => message.messageId === "m7")).toHaveLength(1);
  });

  it("发语音：按 voice 签发 → 直传 → 发消息带上时长", async () => {
    const { flow, http, uploads } = await chatWith();
    const objectKey = "uploads/1234567890/voice/blob-9";
    http.onJson("POST", "/v1/uploads", 201, {
      objectKey,
      uploadUrl: `https://bucket.example.com/${objectKey}?sign=def`,
      method: "PUT",
      headers: { "Content-Type": "audio/webm" },
      expiresInSeconds: 60,
    });
    http.onJson("POST", "/v1/groups/g1/messages", 201, groupMessage("m8", {
      type: "voice",
      content: objectKey,
      voiceSeconds: 7,
    }));

    await flow.sendVoice({ bytes: new Uint8Array([1, 2]), contentType: "audio/webm", seconds: 7 });

    // 签发时必须是 voice —— 服务端按 kind 卡不同的类型白名单与大小上限。
    expect(http.requests.find((request) => request.path === "/v1/uploads")?.body).toMatchObject({
      kind: "voice",
      contentType: "audio/webm",
      byteSize: 2,
    });
    expect(uploads.requests[0]).toMatchObject({ url: `https://bucket.example.com/${objectKey}?sign=def` });
    // 时长随消息一起发出去，收件人才能显示「7 秒」。
    expect(http.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/groups/g1/messages",
      body: { type: "voice", content: objectKey, voiceSeconds: 7 },
    });

    const screen = flow.current;
    const ids = screen.name === "chat" ? screen.messages.map((message) => message.messageId) : [];
    expect(ids).toEqual(["m1", "m8"]);
  });

  it("语音的时长与字节在本地就校验，不合规不会去传", async () => {
    const { flow, http, uploads } = await chatWith();
    const send = (seconds: number, length = 1) =>
      flow.sendVoice({ bytes: new Uint8Array(length), contentType: "audio/webm", seconds });

    // 服务端只收 1–60 的整数秒。
    await send(0);
    expect(uploads.requests).toHaveLength(0);
    expect(flow.current).toMatchObject({ error: "语音长度要在 1–60 秒之间" });

    await send(61);
    expect(uploads.requests).toHaveLength(0);
    // 不是整数也不行（服务端是 z.number().int()）。
    await send(2.5);
    expect(uploads.requests).toHaveLength(0);

    // 一秒钟都没录到。
    await send(3, 0);
    expect(uploads.requests).toHaveLength(0);
    expect(flow.current).toMatchObject({ error: "没有录到声音" });

    // 三次都没发过消息。
    expect(http.requests.some((request) => request.method === "POST" && request.path === "/v1/groups/g1/messages")).toBe(false);
  });

  it("准备之后立刻重拉快照 —— 否则界面上看不出变化，像「点了没反应」", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    // 快照里的 ready 由变量控制：准备前 false、准备后 true。
    let ready = false;
    http.on(
      (request) => request.method === "POST" && request.path === "/v1/rooms",
      () => ({ status: 201, body: { roomId: "room-1", status: "waiting" } }),
    );
    http.on(
      (request) => request.method === "GET" && request.path === "/v1/rooms/room-1",
      () => ({
        status: 200,
        body: {
          roomId: "room-1",
          ruleVersion: "MIANYANG_XZ_1_0",
          status: "waiting",
          ownerId: SESSION.userId,
          completedRounds: 0,
          players: [{
            userId: SESSION.userId, nickname: "张三", points: 2000, ready,
            connected: true, disconnectedAt: null, reconnectDeadline: null,
          }],
          result: null,
        },
      }),
    );
    http.onJson("POST", "/v1/rooms/room-1/ready", 200, { userId: SESSION.userId, ready: true });

    await flow.createRoom();
    const before = flow.current;
    expect(before.name === "room" ? before.snapshot?.players[0]?.ready : null).toBe(false);

    ready = true; // 服务端那边已经改了
    await flow.setReady(true);

    const after = flow.current;
    expect(after.name).toBe("room");
    if (after.name !== "room") return;
    // 没有再拉一次的话这里仍是 false —— 用户看到的就是「点了没反应」。
    expect(after.snapshot?.players[0]?.ready).toBe(true);
  });

  it("准备失败要提示，不能静默吞掉", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubRoom(http, "room-1");
    await flow.createRoom();
    http.onJson("POST", "/v1/rooms/room-1/ready", 409, { code: "ROOM_NOT_WAITING" });

    await flow.setReady(true);

    expect(flow.current).toMatchObject({ name: "room", notice: "操作失败（ROOM_NOT_WAITING）" });
  });

  it("开局走实时通道，失败时把服务端的话显示出来", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    stubRoom(http, "room-1");
    await flow.createRoom();
    const socket = sockets.last();

    await flow.startMatch();

    // 对局活在实时层：REST 的 /start 只改房间状态，实时层不会知道要开局，
    // 而四个人的连接早就在开局前建好了、之后不会再有握手 —— 那样谁都收不到首帧。
    expect(socket.sent.at(-1)).toEqual({ type: "start" });
    expect(http.requests.some((request) => request.path === "/v1/rooms/room-1/start")).toBe(false);

    // 服务端拒绝（例如还有人没准备）时要把原话显示出来。
    socket.serverSends({ type: "error", message: "All players must be ready" });
    expect(flow.current).toMatchObject({ name: "room", notice: "还有玩家没有准备" });
  });

  it("房间规则类的拒绝要翻成中文，不能把英文原文甩给用户", async () => {
    // 域层抛的是英文句子（服务端把 message 原样透传），直接显示会让人一头雾水。
    const cases: Array<[string, string]> = [
      ["Four players are required", "要四个人才能开局"],
      ["All players must be ready", "还有玩家没有准备"],
      ["Only the room owner can start the match", "只有房主能开局"],
      ["Room is not waiting to start", "这个房间已经开局了"],
      // 按房间号加入会遇到的那几种。
      ["ROOM_NOT_FOUND", "没有这个房间号，可能房主已经解散了"],
      ["Room is full", "房间满了，一桌只能坐四个人"],
      ["Active account with at least 500 points is required", "积分不足 500，暂时进不了牌局"],
    ];

    for (const [raw, translated] of cases) {
      const { flow, http, sockets } = flowWith();
      http.onJson("POST", "/v1/auth/login", 200, SESSION);
      stubHome(http);
      await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
      stubRoom(http, "room-1");
      await flow.createRoom();

      // 开局被拒：服务端以 error 帧回话。
      sockets.last().serverSends({ type: "error", message: raw });

      expect(flow.current).toMatchObject({ name: "room", notice: translated });
    }
  });

  it("按 6 位房间号加入：号码有效才发请求", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    stubHome(http);
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    // 位数不对：本地就说清楚，不用白跑一趟服务端（那边只会回一句「参数不合法」）。
    await flow.joinRoom("12345");
    expect(flow.current).toMatchObject({ name: "home", error: "房间号是 6 位数字，请再确认一下" });
    expect(http.requests.some((request) => request.path === "/v1/rooms/join")).toBe(false);

    // 号码有效：服务端换回内部 roomId，客户端用它进房，房间号显示在界面上。
    http.onJson("POST", "/v1/rooms/join", 201, { roomId: "room-9", roomNo: "654321", status: "waiting", playerCount: 2 });
    stubRoom(http, "room-9", "654321");
    await flow.joinRoom("654321");

    expect(flow.current).toMatchObject({ name: "room", roomId: "room-9", roomNo: "654321" });
    const sent = http.requests.find((request) => request.path === "/v1/rooms/join");
    expect(sent?.body).toEqual({ roomNo: "654321" });
  });

  it("对局中途退出的人重新登录后能一键回到房间", async () => {
    const { flow, http, sockets } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION_WITH_ACTIVE_ROOM);
    stubHome(http);
    stubRoom(http, "room-1", "654321");
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    // 主页要给出入口，并且带上房间号与人数。
    expect(flow.current).toMatchObject({
      name: "home",
      activeRoom: { roomId: "room-1", roomNo: "654321", status: "playing", playerCount: 4 },
    });

    await flow.rejoinActiveRoom();

    expect(flow.current).toMatchObject({ name: "room", roomId: "room-1", roomNo: "654321" });
    // 直接回到牌桌，**不再调一次「加入」**：对局中 join 会被域层拒绝。
    expect(http.requests.some((request) => request.path === "/v1/rooms/join")).toBe(false);
    // 实时通道带上同一间房重新握手，断线重连仍由它负责。
    expect(sockets.last().sent[0]).toMatchObject({ type: "auth", roomId: "room-1" });
  });

  it("对局结束后主页不再显示「回到房间」", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION_WITH_ACTIVE_ROOM);
    stubHome(http);
    // 进房时快照显示这一局已经打完了。
    http.onJson("GET", "/v1/rooms/room-1", 200, {
      roomId: "room-1",
      roomNo: "654321",
      ruleVersion: "MIANYANG_XZ_1_0",
      status: "finished",
      ownerId: SESSION.userId,
      completedRounds: 8,
      players: [],
      result: null,
    });
    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");
    await flow.rejoinActiveRoom();
    http.onJson("POST", "/v1/rooms/room-1/leave", 204);
    await flow.leaveRoom();

    expect(flow.current).toMatchObject({ name: "home", activeRoom: null });
  });
});
