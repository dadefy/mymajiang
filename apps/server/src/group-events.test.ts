import { describe, expect, it } from "vitest";
import { InMemoryGroupEventBus, type GroupEvent } from "./group-events.js";

function messageEvent(content: string, groupId = "group-1"): GroupEvent {
  return {
    type: "message",
    groupId,
    message: {
      messageId: `message-${content}`,
      senderId: "1234567890",
      sentAt: new Date("2026-09-15T00:00:00.000Z"),
      type: "text",
      content,
      recalledAt: null,
    },
  };
}

describe("InMemoryGroupEventBus", () => {
  it("把事件送给所有订阅者", () => {
    const bus = new InMemoryGroupEventBus();
    const first: GroupEvent[] = [];
    const second: GroupEvent[] = [];
    bus.subscribe((event) => first.push(event));
    bus.subscribe((event) => second.push(event));

    bus.publish(messageEvent("大家好"));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("退订后不再收到事件", () => {
    const bus = new InMemoryGroupEventBus();
    const received: GroupEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.publish(messageEvent("第一条"));
    unsubscribe();
    bus.publish(messageEvent("第二条"));

    expect(received).toHaveLength(1);
  });

  it("订阅者在回调里退订不会打乱这一次广播", () => {
    const bus = new InMemoryGroupEventBus();
    const received: string[] = [];
    const unsubscribe = bus.subscribe(() => {
      received.push("第一个");
      unsubscribe();
    });
    bus.subscribe(() => received.push("第二个"));

    bus.publish(messageEvent("大家好"));
    bus.publish(messageEvent("再来一条"));

    // 第一次广播两个监听器都要收到；第二次只剩剩下的那个。
    expect(received).toEqual(["第一个", "第二个", "第二个"]);
  });

  it("没有订阅者时广播是空操作", () => {
    const bus = new InMemoryGroupEventBus();
    expect(() => bus.publish(messageEvent("无人接收"))).not.toThrow();
  });
});
