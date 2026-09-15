export type AccountStatus = "active" | "temporarily_banned" | "permanently_banned" | "deleted";

export interface UserAccount {
  userId: string;
  nickname: string;
  avatarUrl: string;
  status: AccountStatus;
  points: number;
  /**
   * 建立这个账号时使用的一次性邀请密钥哈希。
   *
   * 数据库上这一列是 UNIQUE 的，所以「一把密钥只能建立一个账号」由约束本身保证。
   * 管理员手工建号时为空。
   */
  invitationKeyHash?: string;
  activeMatchId?: string;
  createdAt: Date;
}

export interface AccountStore {
  listAccounts(): UserAccount[];
  findAccountById(userId: string): UserAccount | undefined;
  /** 用邀请密钥哈希反查账号；登录走的就是这个查询。 */
  findAccountByInvitationKeyHash(keyHash: string): UserAccount | undefined;
  saveAccount(account: UserAccount): void;
  flush?(): Promise<void>;
}

export interface CreateAccountInput {
  nickname: string;
  avatarUrl: string;
  /** 用邀请密钥激活时传入；管理员手工建号时省略。 */
  invitationKeyHash?: string;
}

/** 注销之后所有人看到的昵称。原来的昵称属于个人信息，注销时一并抹掉。 */
export const DELETED_ACCOUNT_NICKNAME = "已注销用户";

/**
 * 账号的建立与绑定。
 *
 * 内测的入口是「开发方签发的一次性密钥」：用户不需要提交申请，也没有人工审核 ——
 * 拿到密钥的人就是被邀请的人，首次激活即建号。
 */
export interface AccountActivator {
  /** 校验密钥并返回它的哈希；找不到、已撤销、格式不对都抛错。 */
  resolveKey(key: string): string;
}

export class AccountService {
  constructor(
    private readonly store: AccountStore,
    private readonly keys: AccountActivator,
    private readonly createUserId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 用一把邀请密钥激活账号。
   *
   * 重复激活会被 `createAccount` 拦下：密钥与账号是一对一的。
   */
  activateWithKey(input: { key: string; nickname: string; avatarUrl: string }): UserAccount {
    const invitationKeyHash = this.keys.resolveKey(input.key);
    return this.createAccount({
      nickname: input.nickname,
      avatarUrl: input.avatarUrl,
      invitationKeyHash,
    });
  }

  /** 建号。带 `invitationKeyHash` 时检查密钥是否已经被用过。 */
  createAccount(input: CreateAccountInput): UserAccount {
    const nickname = input.nickname.trim();
    const avatarUrl = input.avatarUrl.trim();
    if (!nickname) throw new Error("Nickname is required");
    if (!avatarUrl) throw new Error("Avatar is required");

    if (input.invitationKeyHash) {
      if (!/^[0-9a-f]{64}$/.test(input.invitationKeyHash)) {
        throw new Error("Invitation key hash must be a SHA-256 hex digest");
      }
      if (this.store.findAccountByInvitationKeyHash(input.invitationKeyHash)) {
        throw new Error("KEY_ALREADY_ACTIVATED");
      }
    }

    let userId = this.createUserId();
    while (this.store.findAccountById(userId)) userId = this.createUserId();
    if (!/^\d{10}$/.test(userId)) throw new Error("User ID must contain exactly 10 digits");

    const account: UserAccount = {
      userId,
      nickname,
      avatarUrl,
      status: "active",
      points: 0,
      createdAt: this.now(),
      ...(input.invitationKeyHash ? { invitationKeyHash: input.invitationKeyHash } : {}),
    };
    this.store.saveAccount(account);
    return account;
  }

  /**
   * 注销账号。立即生效，不可撤销。
   *
   * 做三件事：状态转 `deleted`（于是 `requireUser` 与各处 `assertActive` 立刻拒绝这个账号，
   * 连已经签发出去的令牌也一起失效）、昵称与头像匿名化。
   *
   * **`invitationKeyHash` 有意保留**：数据库上这一列是 UNIQUE 的，留着它，这把密钥就永远
   * 绑定在一个已注销的账号上 —— 既登不进来（状态不是 active），也不能拿去重新注册
   * （`createAccount` 会报 `KEY_ALREADY_ACTIVATED`）。这正是「注销后密钥作废」的实现方式。
   *
   * **积分与战绩一概不动**：它们同时是其他玩家的对局记录，也有财务属性，
   * 删掉会破坏别人的战绩与账目。
   */
  deleteAccount(account: UserAccount): void {
    if (account.status === "deleted") throw new Error("Account is already deleted");
    // 与管理员改状态同一条约束：牌局进行中不动账号，否则那局会缺一个人。
    if (account.activeMatchId) throw new Error("Account cannot be deleted during an active match");
    account.status = "deleted";
    account.nickname = DELETED_ACCOUNT_NICKNAME;
    account.avatarUrl = "";
    this.store.saveAccount(account);
  }
}

export class InMemoryAccountStore implements AccountStore {
  readonly accounts = new Map<string, UserAccount>();

  listAccounts(): UserAccount[] {
    return [...this.accounts.values()];
  }

  findAccountById(userId: string): UserAccount | undefined {
    return this.accounts.get(userId);
  }

  findAccountByInvitationKeyHash(keyHash: string): UserAccount | undefined {
    return [...this.accounts.values()].find((account) => account.invitationKeyHash === keyHash);
  }

  saveAccount(account: UserAccount): void {
    this.accounts.set(account.userId, account);
  }
}
