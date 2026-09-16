/**
 * 幂等键：同一个键重复提交，第二次直接回放第一次的响应，不重放副作用。
 *
 * 解决的是**重试**带来的重复：客户端在弱网下超时后重试、用户连点两下按钮，
 * 同一个请求可能真的到达两次。对「建房」「发消息」「调分」这类每次调用都会产生
 * 新副作用的接口来说，第二次到达就是真重复 —— 多一个房间、多一条消息、多扣一次分。
 *
 * 状态只在内存里，与限流、管理员失败锁定是同一个取舍：单进程部署够用，
 * 多实例部署时要换成共享存储，否则同一个键在 A 实例执行、重试落到 B 实例仍会重复执行。
 */

export interface IdempotentResponse {
  status: number;
  /** 已经序列化好的响应体，回放时原样发出。 */
  body: string;
  storedAt: number;
}

/** 记录保留多久。更久的重试已经不值得复用响应，而且几乎不可能发生。 */
const RETENTION_MS = 24 * 60 * 60_000;

/** 每个 scope 最多留多少条：一次清理要等 500 次写入，得有个硬上限兜住内存。 */
const MAX_ENTRIES_PER_SCOPE = 200;

export class IdempotencyStore {
  /** scope（用户） → 键 → 已完成的响应。 */
  private readonly entries = new Map<string, Map<string, IdempotentResponse>>();
  private writesSinceSweep = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 取第一次的响应；没有、或已过期时返回 undefined。 */
  lookup(scope: string, key: string): IdempotentResponse | undefined {
    const bucket = this.entries.get(scope);
    const entry = bucket?.get(key);
    if (!bucket || !entry) return undefined;
    if (this.now() - entry.storedAt > RETENTION_MS) {
      bucket.delete(key);
      return undefined;
    }
    return entry;
  }

  /** 记住一次成功的响应，供同一个键的重试复用。 */
  remember(scope: string, key: string, status: number, body: string): void {
    let bucket = this.entries.get(scope);
    if (!bucket) {
      bucket = new Map();
      this.entries.set(scope, bucket);
    }
    bucket.set(key, { status, body, storedAt: this.now() });
    // 超量时丢最早的那条：重试几乎都发生在几秒内，被丢掉的都是早已无用的记录。
    while (bucket.size > MAX_ENTRIES_PER_SCOPE) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
    this.maybeSweep();
  }

  /** 当前跟踪的键数（含已过期但尚未清理的），供观测与测试。 */
  get trackedEntries(): number {
    let total = 0;
    for (const bucket of this.entries.values()) total += bucket.size;
    return total;
  }

  private maybeSweep(): void {
    this.writesSinceSweep += 1;
    if (this.writesSinceSweep < 500) return;
    this.writesSinceSweep = 0;
    const cutoff = this.now() - RETENTION_MS;
    for (const [scope, bucket] of this.entries) {
      for (const [key, entry] of bucket) {
        if (entry.storedAt <= cutoff) bucket.delete(key);
      }
      if (bucket.size === 0) this.entries.delete(scope);
    }
  }
}

/** 客户端用这个请求头发送幂等键。 */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/**
 * 哪些路由需要幂等保护。
 *
 * 判据是「**重复到达会不会产生额外副作用**」，而不是「是不是写操作」：
 * - 建房、建群 → 每调一次多一个房间 / 群；
 * - 发群消息 → 每调一次多一条消息；
 * - 管理员调分 → 每调一次就多扣或多加一次分（这个最危险，涉及余额）；
 * - 签发邀请密钥 → 每调一次多签出几把，明文只在响应里出现一次，重复签出等于密钥失控。
 *
 * 刻意**不**列入的（重复调用本来就安全，加键只是徒增内存）：
 * - 激活账号（`invitation_key_hash` 上有唯一约束兜底）、
 * - 加入房间 / 群、准备、设公告 / 禁言 / 设管理员（幂等或覆盖语义）、
 * - 退群、撤回、撤销密钥、拒绝申请（第二次会被服务端以业务规则拒掉）、
 * - 以及所有只读接口。
 */
const IDEMPOTENT_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/v1\/rooms$/ },
  { method: "POST", pattern: /^\/v1\/groups$/ },
  { method: "POST", pattern: /^\/v1\/groups\/[^/]+\/messages$/ },
  { method: "POST", pattern: /^\/v1\/admin\/users\/[^/]+\/points$/ },
  { method: "POST", pattern: /^\/v1\/admin\/invitation-keys$/ },
];

/** `url` 可能带查询串，比较时只看路径。 */
export function needsIdempotency(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return IDEMPOTENT_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}

/**
 * 键的合法形状：16–128 位、只含 URL 安全字符。
 *
 * 不接受任意字符串是为了避免有人拿超长内容把 map 撑大；
 * 长度下限则是为了让「忘了生成键、随手传个 1」也能被挡住。
 */
export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}
