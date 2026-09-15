import { describe, expect, it } from "vitest";
import { RateLimiter, type RateLimitRule } from "./rate-limit.js";

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };
const SECOND = 1000;

/** 可手动推进的时钟，避免测试真的去等窗口滑过。 */
function controllableClock(start = 1_700_000_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

describe("RateLimiter", () => {
  it("窗口内额度用满之前放行，超出后拒绝", () => {
    const limiter = new RateLimiter();

    expect(limiter.check("a", RULE).allowed).toBe(true);
    expect(limiter.check("a", RULE).allowed).toBe(true);
    expect(limiter.check("a", RULE).allowed).toBe(true);

    const blocked = limiter.check("a", RULE);
    expect(blocked.allowed).toBe(false);
    expect(blocked.used).toBe(3);
  });

  it("被拒时给出合理的等待秒数，并且越接近窗口末尾等得越短", () => {
    const clock = controllableClock();
    const limiter = new RateLimiter(clock.now);
    for (let index = 0; index < RULE.limit; index += 1) limiter.check("a", RULE);

    const justAfterStart = limiter.check("a", RULE).retryAfterSeconds!;
    expect(justAfterStart).toBeGreaterThan(0);
    expect(justAfterStart).toBeLessThanOrEqual(60);

    // 过了 30 秒再来，最早那次还剩 30 秒滑出窗口。
    clock.advance(30 * SECOND);
    const halfway = limiter.check("a", RULE).retryAfterSeconds!;
    expect(halfway).toBeLessThan(justAfterStart);
    expect(halfway).toBeLessThanOrEqual(31);
  });

  it("窗口滑过之后自动恢复，不会因为历史记录一直被挡", () => {
    const clock = controllableClock();
    const limiter = new RateLimiter(clock.now);
    for (let index = 0; index < RULE.limit; index += 1) limiter.check("a", RULE);
    expect(limiter.check("a", RULE).allowed).toBe(false);

    clock.advance(RULE.windowMs + 1);
    expect(limiter.check("a", RULE).allowed).toBe(true);
  });

  it("滑动窗口：不会出现「跨窗口瞬间翻倍」的突发", () => {
    const clock = controllableClock();
    const limiter = new RateLimiter(clock.now);
    // 在窗口末尾用满额度。
    for (let index = 0; index < RULE.limit; index += 1) limiter.check("a", RULE);

    // 只过了 1 秒（固定窗口实现到这里会「重置」从而再放行 3 次）。
    clock.advance(SECOND);
    expect(limiter.check("a", RULE).allowed).toBe(false);

    // 再等满窗口，才真正恢复。
    clock.advance(RULE.windowMs);
    expect(limiter.check("a", RULE).allowed).toBe(true);
  });

  it("不同 key 互不影响", () => {
    const limiter = new RateLimiter();
    for (let index = 0; index < RULE.limit; index += 1) limiter.check("a", RULE);

    expect(limiter.check("a", RULE).allowed).toBe(false);
    expect(limiter.check("b", RULE).allowed).toBe(true);
  });

  it("同一 key 的不同规则各自计数", () => {
    const limiter = new RateLimiter();
    const perMinute: RateLimitRule = { limit: 2, windowMs: 60_000 };
    const perHour: RateLimitRule = { limit: 5, windowMs: 60 * 60_000 };

    expect(limiter.check("a", perMinute).allowed).toBe(true);
    expect(limiter.check("a", perMinute).allowed).toBe(true);
    expect(limiter.check("a", perMinute).allowed).toBe(false);
    // 分钟额度用满不影响小时额度。
    expect(limiter.check("a", perHour).allowed).toBe(true);
  });

  it("peek 只看不改，reset 清掉某个 key", () => {
    const limiter = new RateLimiter();
    limiter.check("a", RULE);

    expect(limiter.peek("a", RULE)).toBe(1);
    expect(limiter.peek("a", RULE)).toBe(1);

    limiter.reset("a");
    expect(limiter.peek("a", RULE)).toBe(0);
  });

  it("长期不清理也不会无限增长：过期 key 会被扫掉", () => {
    const clock = controllableClock();
    const limiter = new RateLimiter(clock.now);
    const shortRule: RateLimitRule = { limit: 1, windowMs: 1000 };

    // 1000 次不同 key 的访问触发一次清扫。
    for (let index = 0; index < 999; index += 1) limiter.check(`key-${index}`, shortRule);
    expect(limiter.trackedKeys).toBe(999);

    // 让它们全部过期，再来一次触发清扫。
    clock.advance(60 * 60_000 + 1);
    limiter.check("fresh", shortRule);
    // 扫掉之后只剩刚访问的这个。
    expect(limiter.trackedKeys).toBe(1);
  });

  it("清理不会误删仍在窗口内的记录", () => {
    const clock = controllableClock();
    const limiter = new RateLimiter(clock.now);
    const longRule: RateLimitRule = { limit: 5, windowMs: 60 * 60_000 };

    limiter.check("stays", longRule);
    for (let index = 0; index < 999; index += 1) limiter.check(`key-${index}`, longRule);
    clock.advance(1000);
    limiter.check("fresh", longRule);

    // 清扫用最长的窗口做阈值，所以一小时内的记录都还在。
    expect(limiter.peek("stays", longRule)).toBe(1);
  });
});
