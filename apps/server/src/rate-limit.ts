/**
 * 滑动窗口限流。
 *
 * 按任意 key 计数（未认证接口用 IP，已认证接口用 userId），窗口滑过即自动放行，
 * 所以不会出现「固定窗口」那种「第 59 秒用满额度、第 61 秒又满额度」的二倍突发。
 *
 * 状态只在内存里：单进程部署够用，多实例部署时各算各的（已记在文档的已知限制里）。
 * 与管理员登录的失败锁定是两套东西 —— 那个是「密码试错」的针对性防护，
 * 这个是「别把接口打爆」的通用闸门，两者并存不冲突。
 */

export interface RateLimitRule {
  /** 时间窗内允许的最大次数。 */
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 窗口内已用的次数（含本次）。 */
  used: number;
  /** 被拒时建议的等待秒数，用于 Retry-After。 */
  retryAfterSeconds?: number;
}

export class RateLimiter {
  /** key → 命中时间戳（毫秒），按发生顺序排列。 */
  private readonly hits = new Map<string, number[]>();
  private checksSinceSweep = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = this.now();
    const windowStart = now - rule.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > windowStart);

    if (recent.length >= rule.limit) {
      // 最早那次滑出窗口时就能再来一次。
      const oldest = recent[0]!;
      const retryAfterMs = Math.max(0, oldest + rule.windowMs - now);
      this.hits.set(key, recent);
      return {
        allowed: false,
        used: recent.length,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    this.maybeSweep(now);
    return { allowed: true, used: recent.length };
  }

  /** 只读地看一个 key 当前用了几次（不计数）。 */
  peek(key: string, rule: RateLimitRule): number {
    const windowStart = this.now() - rule.windowMs;
    return (this.hits.get(key) ?? []).filter((at) => at > windowStart).length;
  }

  /** 清掉一个 key 的记录，例如用户成功登录之后。 */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** 当前跟踪的 key 数量，供观测与测试。 */
  get trackedKeys(): number {
    return this.hits.size;
  }

  /**
   * 周期性清理彻底过期的 key。
   *
   * 用了最长的窗口做阈值，所以不会误删某个还在短窗口内的记录；
   * 不清理的话，被大量伪造 IP 打过的进程会一直涨内存。
   */
  private maybeSweep(now: number): void {
    this.checksSinceSweep += 1;
    if (this.checksSinceSweep < 1000) return;
    this.checksSinceSweep = 0;
    const cutoff = now - SWEEP_WINDOW_MS;
    for (const [key, times] of this.hits) {
      const recent = times.filter((at) => at > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

/** 清理阈值取所有规则里最长的窗口，保证不会误删仍有效的记录。 */
const SWEEP_WINDOW_MS = 60 * 60_000;

/**
 * 各处额度的形状。
 *
 * 单独定义而不直接用 `typeof RATE_LIMITS`：后者是 `as const` 出来的字面量类型
 * （`limit: 30`），任何按同样含义构造的对象都不可赋值，测试想换额度就会被类型挡住。
 */
export interface RateLimitRules {
  authByIp: RateLimitRule;
  uploadByUser: RateLimitRule;
  uploadByUserHourly: RateLimitRule;
  groupMessageByUser: RateLimitRule;
}

/**
 * 各处实际使用的额度。
 *
 * 取值原则是「正常用户绝对碰不到，脚本刷子很快撞墙」：
 *   * 登录/激活按 IP —— 正常人不会一分钟登 30 次；这里主要挡脚本骚扰，
 *     **不是**用来防密钥猜测的（邀请密钥是 80 位随机量，猜不出来）；
 *   * 上传按用户 —— 这是真正的成本风险：单张图最高 5MB，不限流可以刷爆存储账单；
 *   * 发消息按用户 —— 防刷屏，正常手速远低于这个额度。
 */
export const RATE_LIMITS = {
  authByIp: { limit: 30, windowMs: 60_000 },
  uploadByUser: { limit: 20, windowMs: 60_000 },
  uploadByUserHourly: { limit: 200, windowMs: 60 * 60_000 },
  groupMessageByUser: { limit: 30, windowMs: 60_000 },
} as const satisfies RateLimitRules;
