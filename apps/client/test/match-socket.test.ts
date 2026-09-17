import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchSocket } from "../src/match-socket.js";
import { FakeSocketFactory } from "./fakes.js";

const factory = new FakeSocketFactory();

afterEach(() => {
  factory.created.length = 0;
  vi.useRealTimers();
});

function socketWith(token = "jwt-1"): MatchSocket {
  return new MatchSocket({ url: "ws://127.0.0.1:3001", token, factory });
}

describe("MatchSocket", () => {
  it("连接后第一帧是 auth，并带上房间", async () => {
    const socket = socketWith();
    await socket.connect("room-1");

    expect(factory.last().sent[0]).toEqual({ type: "auth", token: "jwt-1", roomId: "room-1" });
    expect(factory.last().url).toBe("ws://127.0.0.1:3001");
    socket.close();
  });

  it("不带 roomId 时只完成认证，方便只订阅群聊", async () => {
    const socket = socketWith();
    await socket.connect();

    expect(factory.last().sent[0]).toEqual({ type: "auth", token: "jwt-1" });
    socket.close();
  });

  it("把服务端帧翻译成带类型的事件", async () => {
    const socket = socketWith();
    const events: Array<{ kind: string }> = [];
    socket.on((event) => events.push(event));
    await socket.connect("room-1");

    factory.last().serverSends({ type: "game", state: { roomId: "room-1", phase: "swapping" } });
    factory.last().serverSends({ type: "actions", actions: ["swap"] });
    factory.last().serverSends({ type: "group-message", groupId: "g1", message: { messageId: "m1" } });
    factory.last().serverSends({ type: "error", message: "Not the player's turn" });

    expect(events.map((event) => event.kind)).toEqual([
      "connected",
      "game",
      "actions",
      "group-message",
      "error",
    ]);
    socket.close();
  });

  it("断线后按退避节奏重连，并重放 auth 与群订阅", async () => {
    vi.useFakeTimers();
    const socket = socketWith();
    await socket.connect("room-1");
    socket.subscribeGroup("group-1");
    factory.last().sent.length = 0;

    const events: Array<{ kind: string }> = [];
    socket.on((event) => events.push(event));
    factory.last().serverCloses();
    await vi.advanceTimersByTimeAsync(500);

    expect(events).toContainEqual({ kind: "disconnected" });
    expect(events).toContainEqual({ kind: "reconnected" });
    expect(factory.last().sent).toEqual([
      { type: "auth", token: "jwt-1", roomId: "room-1" },
      { type: "group-subscribe", groupId: "group-1" },
    ]);
    socket.close();
  });

  it("被移出群后不再重连订阅，也不再收到该群消息", async () => {
    vi.useFakeTimers();
    const socket = socketWith();
    const events: Array<{ kind: string }> = [];
    socket.on((event) => events.push(event));
    await socket.connect();
    socket.subscribeGroup("group-1");
    socket.subscribeGroup("group-2");
    factory.last().serverSends({ type: "group-removed", groupId: "group-1" });
    factory.last().sent.length = 0;

    factory.last().serverCloses();
    await vi.advanceTimersByTimeAsync(500);

    // group-1 已经被服务端撤了订阅，本地也不再重放。
    expect(factory.last().sent).toEqual([
      { type: "auth", token: "jwt-1" },
      { type: "group-subscribe", groupId: "group-2" },
    ]);
    socket.close();
  });

  it("close 之后不再重连", async () => {
    vi.useFakeTimers();
    const socket = socketWith();
    await socket.connect("room-1");

    socket.close();
    factory.last().serverCloses();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(factory.created).toHaveLength(1);
  });

  it("未连接就发帧会抛错", async () => {
    const socket = socketWith();
    expect(() => socket.send({ type: "start" })).toThrow("not connected");
  });

  it("还没连上就退订不抛错，也不会上线后补订阅", async () => {
    const socket = socketWith();
    // 「刚进群就点返回」走的就是这条路：`openChat` 里 socket 先挂上，而 `connect()` 还没 await 完，
    // 这期间 `transport` 是 null。退订如果抛出去，`backHome()` 的 promise 会被拒绝，
    // 后面的 `enterHome()` 永远执行不到 —— 返回键点了没反应，人被困在群聊里。
    expect(() => socket.unsubscribeGroup("group-1")).not.toThrow();

    await socket.connect();
    expect(factory.last().sent).toEqual([{ type: "auth", token: "jwt-1" }]);
    socket.close();
  });
});
