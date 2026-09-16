import { describe, expect, it } from "vitest";
import { IdempotencyStore, isValidIdempotencyKey, needsIdempotency } from "./idempotency.js";

const DAY_MS = 24 * 60 * 60_000;

describe("幂等存储", () => {
  it("记住一次响应之后，同一个键能取回来", () => {
    const store = new IdempotencyStore();
    expect(store.lookup("u1", "key-1")).toBeUndefined();

    store.remember("u1", "key-1", 201, '{"ok":true}');
    expect(store.lookup("u1", "key-1")).toMatchObject({ status: 201, body: '{"ok":true}' });
  });

  it("不同用户（scope）之间的同名键互不影响", () => {
    const store = new IdempotencyStore();
    store.remember("u1", "same-key", 201, '{"who":"u1"}');

    expect(store.lookup("u2", "same-key")).toBeUndefined();
    expect(store.lookup("u1", "same-key")).toMatchObject({ body: '{"who":"u1"}' });
  });

  it("超过保留期的记录不再回放", () => {
    let now = 1_000_000;
    const store = new IdempotencyStore(() => now);
    store.remember("u1", "key-1", 200, "{}");

    now += DAY_MS + 1;
    expect(store.lookup("u1", "key-1")).toBeUndefined();
  });

  it("单个用户狂刷键时会丢掉最早的记录，不会无限涨", () => {
    const store = new IdempotencyStore();
    for (let index = 0; index < 250; index += 1) {
      store.remember("u1", `key-${index}`, 200, "{}");
    }

    expect(store.trackedEntries).toBe(200);
    expect(store.lookup("u1", "key-0")).toBeUndefined();
    expect(store.lookup("u1", "key-249")).toBeDefined();
  });

  it("定期扫描会把过期记录真正删掉，而不是留到进程结束", () => {
    let now = 1_000_000;
    const store = new IdempotencyStore(() => now);
    store.remember("u1", "key-1", 200, "{}");
    expect(store.trackedEntries).toBe(1);

    now += DAY_MS + 1;
    // 攒够写入次数触发一次扫描：u1 那条过期了被删，u2 只留上限内的 200 条。
    for (let index = 0; index < 500; index += 1) {
      store.remember("u2", `other-${index}`, 200, "{}");
    }
    expect(store.trackedEntries).toBe(200);
  });
});

describe("需要幂等的路由", () => {
  it("保护「重复到达会产生额外副作用」的写接口", () => {
    expect(needsIdempotency("POST", "/v1/rooms")).toBe(true);
    expect(needsIdempotency("POST", "/v1/groups")).toBe(true);
    expect(needsIdempotency("POST", "/v1/groups/group-1/messages")).toBe(true);
    expect(needsIdempotency("POST", "/v1/admin/users/1234567890/points")).toBe(true);
    expect(needsIdempotency("POST", "/v1/admin/invitation-keys")).toBe(true);
  });

  it("带上查询串也认得出来", () => {
    expect(needsIdempotency("POST", "/v1/rooms?draft=1")).toBe(true);
  });

  it("本来就幂等的接口不保护", () => {
    expect(needsIdempotency("POST", "/v1/rooms/room-1/ready")).toBe(false);
    expect(needsIdempotency("POST", "/v1/rooms/room-1/join")).toBe(false);
    expect(needsIdempotency("POST", "/v1/rooms/room-1/start")).toBe(false);
    expect(needsIdempotency("POST", "/v1/auth/activate")).toBe(false);
    expect(needsIdempotency("POST", "/v1/groups/join")).toBe(false);
    expect(needsIdempotency("POST", "/v1/groups/group-1/invite")).toBe(false);
    expect(needsIdempotency("GET", "/v1/rooms")).toBe(false);
  });

  it("撤回是消息路径的子路径，不能被消息那条规则误伤", () => {
    // 「再撤一次」本来就会被服务端以业务规则拒掉，不需要幂等键；误伤只是白占内存。
    expect(needsIdempotency("POST", "/v1/groups/group-1/messages/message-1/recall")).toBe(false);
  });
});

describe("幂等键的形状", () => {
  it("接受 URL 安全的 16–128 位", () => {
    expect(isValidIdempotencyKey("op-mfk3n-abcdefghij")).toBe(true);
    expect(isValidIdempotencyKey("A".repeat(16))).toBe(true);
    expect(isValidIdempotencyKey("A".repeat(128))).toBe(true);
    expect(isValidIdempotencyKey("with_underscore-1234567890")).toBe(true);
  });

  it("拒绝太短、太长、带奇怪字符或不是字符串的", () => {
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("A".repeat(129))).toBe(false);
    expect(isValidIdempotencyKey("op key with space")).toBe(false);
    expect(isValidIdempotencyKey("键-abcdefghijklmn")).toBe(false);
    expect(isValidIdempotencyKey(1234567890123456)).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });
});
