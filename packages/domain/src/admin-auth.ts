import type { AdminRole } from "./points.js";

export interface AdminAccount {
  adminId: string;
  /** 自描述的密码哈希串（含算法与参数与盐）；明文永远不落库、不记日志。 */
  passwordHash: string;
  role: AdminRole;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 密码哈希能力。
 *
 * 与 `InvitationKeyCodec` 同一套分层：领域层只声明接口，真正用 node:crypto 的实现放在服务端，
 * 这样登录与锁定规则可以脱离加密实现单独测试。
 */
export interface PasswordHasher {
  hash(password: string): string;
  /** 哈希串损坏或参数不认识时返回 `false`，不要抛异常 —— 调用方只关心「验过了没有」。 */
  verify(password: string, storedHash: string): boolean;
}

export interface AdminAccountStore {
  listAdminAccounts(): AdminAccount[];
  findAdminAccount(adminId: string): AdminAccount | undefined;
  saveAdminAccount(account: AdminAccount): void;
}

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 200;

/** 连续失败与锁定时长。锁是进程内的，重启即清零 —— 单实例部署下够用，见文档已知限制。 */
export const ADMIN_LOGIN_POLICY = {
  maxFailures: 5,
  lockDurationMs: 15 * 60_000,
} as const;

function assertPassword(password: string): string {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(`Admin password must contain at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw new Error(`Admin password must contain at most ${ADMIN_PASSWORD_MAX_LENGTH} characters`);
  }
  return password;
}

/**
 * 管理员账号的建立、登录与改密。
 *
 * 三条安全约束写在这里，不靠调用方自觉：
 *
 * 1. **失败次数累计后锁定**。登录与「改密码时校验旧密码」走同一个入口，
 *    所以拿着一个有效令牌想爆破当前密码，同样会被锁。
 * 2. **不靠响应时间泄露账号是否存在**：账号不存在时也会做一次哈希校验。
 * 3. **明文密码只在本类的作用域里存在**，存进 store 的永远是哈希。
 */
export class AdminAuthService {
  /** adminId → 失败计数与解锁时间。进程内状态，不进数据库。 */
  private readonly failures = new Map<string, { count: number; lockedUntil?: number }>();
  /** 账号不存在时用来「空跑一次校验」的哈希，首次需要时才生成。 */
  private dummyHash: string | undefined;

  constructor(
    private readonly store: AdminAccountStore,
    private readonly hasher: PasswordHasher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 现有管理员。用于启动时判断「有没有引导过管理员」。 */
  listAdmins(): AdminAccount[] {
    return this.store.listAdminAccounts();
  }

  /**
   * 建一个管理员，已存在则什么都不做。
   *
   * 用来从环境变量引导「第一个管理员」：重复启动不会覆盖已经改过的密码。
   * 返回是否真的建了。
   */
  createAdminIfAbsent(input: { adminId: string; password: string; role?: AdminRole }): boolean {
    const adminId = input.adminId.trim();
    if (!adminId) throw new Error("Admin ID is required");
    if (this.store.findAdminAccount(adminId)) return false;
    const now = this.now();
    this.store.saveAdminAccount({
      adminId,
      passwordHash: this.hasher.hash(assertPassword(input.password)),
      role: input.role ?? "super_admin",
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  /**
   * 校验凭据。成功返回账号，失败抛错。
   *
   * 失败信息对「账号不存在」和「密码不对」是同一条，不给爆破者任何提示。
   */
  login(adminId: string, password: string): AdminAccount {
    const nowMs = this.now().getTime();
    const state = this.failures.get(adminId);
    if (state?.lockedUntil !== undefined) {
      if (state.lockedUntil > nowMs) throw new Error("TOO_MANY_ATTEMPTS");
      // 锁已过期：重新计数，而不是继续累加历史失败。
      this.failures.delete(adminId);
    }

    const account = this.store.findAdminAccount(adminId);
    const verified = this.hasher.verify(password, account?.passwordHash ?? this.dummy());
    if (!account || !verified) {
      this.recordFailure(adminId, nowMs);
      throw new Error("INVALID_ADMIN_CREDENTIALS");
    }
    this.failures.delete(adminId);
    return account;
  }

  /** 改自己的密码，必须提供当前密码（同样受失败锁定约束）。 */
  changePassword(adminId: string, currentPassword: string, newPassword: string): void {
    const account = this.login(adminId, currentPassword);
    this.store.saveAdminAccount({
      ...account,
      passwordHash: this.hasher.hash(assertPassword(newPassword)),
      updatedAt: this.now(),
    });
  }

  /** 当前锁定状态，供测试与运维观察；不参与鉴权判断。 */
  lockState(adminId: string): { failures: number; lockedUntil: number | undefined } {
    const state = this.failures.get(adminId);
    return { failures: state?.count ?? 0, lockedUntil: state?.lockedUntil };
  }

  private recordFailure(adminId: string, nowMs: number): void {
    const state = this.failures.get(adminId) ?? { count: 0 };
    state.count += 1;
    if (state.count >= ADMIN_LOGIN_POLICY.maxFailures) {
      state.lockedUntil = nowMs + ADMIN_LOGIN_POLICY.lockDurationMs;
    }
    this.failures.set(adminId, state);
  }

  private dummy(): string {
    // 只为消耗与真实校验相当的时间，内容本身没有意义。
    this.dummyHash ??= this.hasher.hash("dummy-password-for-timing-equalisation");
    return this.dummyHash;
  }
}

export class InMemoryAdminAccountStore implements AdminAccountStore {
  readonly accounts = new Map<string, AdminAccount>();

  listAdminAccounts(): AdminAccount[] {
    return [...this.accounts.values()];
  }

  findAdminAccount(adminId: string): AdminAccount | undefined {
    return this.accounts.get(adminId);
  }

  saveAdminAccount(account: AdminAccount): void {
    this.accounts.set(account.adminId, account);
  }
}
