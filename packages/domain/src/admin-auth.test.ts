import { describe, expect, it } from "vitest";
import {
  ADMIN_LOGIN_POLICY,
  AdminAuthService,
  InMemoryAdminAccountStore,
  type PasswordHasher,
} from "./index.js";

/**
 * 测试用的假哈希：**可逆**且一眼看得出没加密，避免测试为了等 scrypt 而变慢。
 * 真实实现（scrypt）单独在 `apps/server/src/password-hasher.test.ts` 里测。
 */
const fakeHasher: PasswordHasher = {
  hash: (password) => `fake:${password}`,
  verify: (password, storedHash) => storedHash === `fake:${password}`,
};

function serviceAt(times: Date[]): { service: AdminAuthService; store: InMemoryAdminAccountStore } {
  let index = 0;
  const store = new InMemoryAdminAccountStore();
  const service = new AdminAuthService(store, fakeHasher, () => times[Math.min(index++, times.length - 1)]!);
  return { service, store };
}

const PASSWORD = "correct horse battery";
const NEXT_PASSWORD = "another long passphrase";

describe("管理员账号", () => {
  it("建号后只存哈希，登录校验密码", () => {
    const { service, store } = serviceAt([new Date("2026-09-16T00:00:00.000Z")]);

    expect(service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD })).toBe(true);
    const stored = store.findAdminAccount("dev")!;
    expect(stored.passwordHash).toBe(`fake:${PASSWORD}`);
    expect(stored.role).toBe("super_admin");

    const admin = service.login("dev", PASSWORD);
    expect(admin.adminId).toBe("dev");
    expect(admin.role).toBe("super_admin");
  });

  it("账号已存在时不再创建，也不会覆盖已经改过的密码", () => {
    const { service, store } = serviceAt([new Date("2026-09-16T00:00:00.000Z")]);

    service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD });
    expect(service.createAdminIfAbsent({ adminId: "dev", password: NEXT_PASSWORD })).toBe(false);
    expect(store.accounts.size).toBe(1);
    // 密码仍是第一次那把 —— 否则每次重启都会被环境变量覆盖回去。
    expect(service.login("dev", PASSWORD).adminId).toBe("dev");
  });

  it("账号不存在与密码错误是同一条错误，且都会累计失败次数", () => {
    const { service } = serviceAt([new Date("2026-09-16T00:00:00.000Z")]);
    service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD });

    expect(() => service.login("dev", "wrong password")).toThrow("INVALID_ADMIN_CREDENTIALS");
    expect(() => service.login("nobody", PASSWORD)).toThrow("INVALID_ADMIN_CREDENTIALS");
    expect(service.lockState("dev").failures).toBe(1);
    expect(service.lockState("nobody").failures).toBe(1);
  });

  it("连续失败到达上限后锁定，锁定期间正确密码也进不去，解锁后恢复", () => {
    const base = new Date("2026-09-16T00:00:00.000Z").getTime();
    // 时间只在登录时被读取，所以给足刻度：每次 login 消耗一个。
    const times = Array.from({ length: 20 }, (_, index) => new Date(base + index * 1000));
    const { service } = serviceAt(times);
    service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD });

    for (let attempt = 0; attempt < ADMIN_LOGIN_POLICY.maxFailures; attempt += 1) {
      expect(() => service.login("dev", "wrong password")).toThrow("INVALID_ADMIN_CREDENTIALS");
    }
    expect(service.lockState("dev").lockedUntil).toBeDefined();

    // 锁上之后即使密码正确也拒绝 —— 这正是防爆破的关键。
    expect(() => service.login("dev", PASSWORD)).toThrow("TOO_MANY_ATTEMPTS");

    // 时间越过锁定期后重新可用，且计数清零。
    const later = serviceAt([new Date(base + ADMIN_LOGIN_POLICY.lockDurationMs + 60_000)]);
    later.service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD });
    expect(later.service.login("dev", PASSWORD).adminId).toBe("dev");
    expect(later.service.lockState("dev").failures).toBe(0);
  });

  it("改密码需要当前密码，且旧密码立刻失效", () => {
    const { service, store } = serviceAt([new Date("2026-09-16T00:00:00.000Z"), new Date("2026-09-16T01:00:00.000Z")]);
    service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD });

    expect(() => service.changePassword("dev", "not the current one", NEXT_PASSWORD))
      .toThrow("INVALID_ADMIN_CREDENTIALS");
    expect(store.findAdminAccount("dev")!.passwordHash).toBe(`fake:${PASSWORD}`);

    service.changePassword("dev", PASSWORD, NEXT_PASSWORD);
    expect(store.findAdminAccount("dev")!.passwordHash).toBe(`fake:${NEXT_PASSWORD}`);
    expect(() => service.login("dev", PASSWORD)).toThrow("INVALID_ADMIN_CREDENTIALS");
    expect(service.login("dev", NEXT_PASSWORD).adminId).toBe("dev");
  });

  it("密码太短或太长都拒绝，且不会建出账号", () => {
    const { service, store } = serviceAt([new Date("2026-09-16T00:00:00.000Z")]);

    expect(() => service.createAdminIfAbsent({ adminId: "short", password: "too-short" }))
      .toThrow("at least 12 characters");
    expect(() => service.createAdminIfAbsent({ adminId: "long", password: "x".repeat(201) }))
      .toThrow("at most 200 characters");
    expect(() => service.createAdminIfAbsent({ adminId: "  ", password: PASSWORD })).toThrow("Admin ID is required");
    expect(store.accounts.size).toBe(0);

    service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD });
    expect(() => service.changePassword("dev", PASSWORD, "short")).toThrow("at least 12 characters");
    expect(store.findAdminAccount("dev")!.passwordHash).toBe(`fake:${PASSWORD}`);
  });

  it("改密码时输错旧密码同样会被锁定 —— 拿着令牌也爆破不了", () => {
    const base = new Date("2026-09-16T00:00:00.000Z").getTime();
    const times = Array.from({ length: 20 }, (_, index) => new Date(base + index * 1000));
    const { service } = serviceAt(times);
    service.createAdminIfAbsent({ adminId: "dev", password: PASSWORD });

    for (let attempt = 0; attempt < ADMIN_LOGIN_POLICY.maxFailures; attempt += 1) {
      expect(() => service.changePassword("dev", "wrong", NEXT_PASSWORD)).toThrow("INVALID_ADMIN_CREDENTIALS");
    }
    expect(() => service.changePassword("dev", PASSWORD, NEXT_PASSWORD)).toThrow("TOO_MANY_ATTEMPTS");
  });
});
