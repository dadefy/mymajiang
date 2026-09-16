import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { ClientFlow } from "../src/flow.js";
import { FakeHttpTransport, FakeSocketFactory, type FakeSocketTransport } from "./fakes.js";

const SESSION = {
  userId: "1234567890",
  nickname: "张三",
  avatarUrl: "avatar",
  status: "active" as const,
  points: 0,
  token: "jwt-1",
};

function flowWith() {
  const transport = new FakeHttpTransport();
  const sockets = new FakeSocketFactory();
  const flow = new ClientFlow(new ApiClient(transport), sockets, "ws://127.0.0.1:3001");
  const screens: Array<{ name: string }> = [];
  flow.onChange((screen) => screens.push({ name: screen.name }));
  return { transport, sockets, flow, screens, http: transport };
}

/** 主页要的两个列表；不注册的话 refreshHome 会把错误带进页面。 */
function stubHome(transport: FakeHttpTransport, groups: unknown[] = [], matches: unknown[] = []): void {
  transport.onJson("GET", "/v1/groups", 200, { groups });
  transport.onJson("GET", "/v1/matches", 200, { matches });
}

function stubRoom(transport: FakeHttpTransport, roomId: string): void {
  transport.onJson("POST", "/v1/rooms", 201, { roomId, status: "waiting" });
  transport.onJson("GET", `/v1/rooms/${roomId}`, 200, {
    roomId,
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

  it("主页列表拉取失败时留在主页并提示，不弹回登录", async () => {
    const { flow, http } = flowWith();
    http.onJson("POST", "/v1/auth/login", 200, SESSION);
    http.onJson("GET", "/v1/groups", 200, { groups: [] });
    http.onJson("GET", "/v1/matches", 501, { code: "MATCH_HISTORY_UNAVAILABLE" });

    await flow.enterKey("MYMJ-7K3M-9QXA-2WET-5ZVB");

    expect(flow.current).toMatchObject({
      name: "home",
      me: { userId: SESSION.userId },
      groups: [],
      matches: [],
      error: "操作失败（MATCH_HISTORY_UNAVAILABLE）",
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
});
