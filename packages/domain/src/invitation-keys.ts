/**
 * 一次性内测邀请密钥。
 *
 * 开发方签发密钥并线下发给内测用户；用户拿密钥首次激活即建立账号，之后同一把密钥就是该账号的
 * 登录凭据。所以「一次性」指的是**只能建立一个账号**，不是用一次就作废。
 *
 * 明文只在签发那一刻返回一次，系统里保存的一直是哈希。
 */
export interface InvitationKey {
  keyId: string;
  /** 明文密钥的 SHA-256 十六进制摘要。 */
  keyHash: string;
  /** 前 8 位，只用于管理员在列表里辨认是哪一把。 */
  keyHint: string;
  /** 备注，例如「给张三」。 */
  note: string;
  createdBy: string;
  createdAt: Date;
  revokedAt?: Date;
  revokedBy?: string;
}

export interface IssuedInvitationKey {
  keyId: string;
  /** 明文密钥，只在此刻返回一次。 */
  key: string;
  note: string;
}

export interface InvitationKeyStore {
  findKeyByHash(keyHash: string): InvitationKey | undefined;
  findKeyById(keyId: string): InvitationKey | undefined;
  listKeys(): InvitationKey[];
  saveKey(key: InvitationKey): void;
}

/**
 * 明文的生成、归一化与哈希。
 *
 * 抽成接口是为了让领域服务不直接依赖 `node:crypto`；实现见服务端的
 * `CryptoInvitationKeyCodec`。
 */
export interface InvitationKeyCodec {
  /** 生成一把新密钥的明文，形如 `MYMJ-XXXX-XXXX-XXXX-XXXX`。 */
  generate(): string;
  /** 归一化用户输入：去掉分隔符并转成大写。格式不对时抛 `KEY_MALFORMED`。 */
  normalize(input: string): string;
  /** 归一化后的明文 → 存储与查找用的哈希。 */
  hash(canonicalKey: string): string;
  /** 归一化后的明文 → 管理员辨认用的短标识。 */
  hint(canonicalKey: string): string;
}

export class InvitationKeyService {
  constructor(
    private readonly store: InvitationKeyStore,
    private readonly codec: InvitationKeyCodec,
    private readonly createKeyId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 签发一批密钥。明文只在这里返回一次。 */
  issue(input: { count: number; note: string; actorId: string }): IssuedInvitationKey[] {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100) {
      throw new Error("Between 1 and 100 keys can be issued at once");
    }
    const note = input.note.trim().slice(0, 100);
    const issued: IssuedInvitationKey[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const key = this.codec.generate();
      const canonical = this.codec.normalize(key);
      const record: InvitationKey = {
        keyId: this.createKeyId(),
        keyHash: this.codec.hash(canonical),
        keyHint: this.codec.hint(canonical),
        note,
        createdBy: input.actorId,
        createdAt: this.now(),
      };
      this.store.saveKey(record);
      issued.push({ keyId: record.keyId, key, note });
    }
    return issued;
  }

  /** 管理员查看已签发的密钥：只有提示位，没有明文。最近签发的排前面。 */
  list(): InvitationKey[] {
    return [...this.store.listKeys()].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  /**
   * 解析用户提交的密钥，返回记录本身。
   *
   * 是否已经绑定账号不在这一步判断：「一把密钥一个账号」的事实存在账号行上，
   * 由 `AccountStore.findAccountByInvitationKeyHash` 回答。
   */
  resolve(input: string): InvitationKey {
    const record = this.store.findKeyByHash(this.codec.hash(this.codec.normalize(input)));
    if (!record) throw new Error("KEY_INVALID");
    if (record.revokedAt) throw new Error("KEY_REVOKED");
    return record;
  }

  /** 只返回哈希，给只关心绑定关系的调用方（例如账号激活）使用。 */
  resolveKey(input: string): string {
    return this.resolve(input).keyHash;
  }

  /**
   * 撤销一把密钥。
   *
   * 只允许撤销**还没绑定账号**的密钥：已绑定的密钥是那个账号唯一的凭据，撤销它等于把用户
   * 锁在门外。要停用账号请改账号状态。
   */
  revoke(keyId: string, actorId: string, activated: boolean): InvitationKey {
    const record = this.store.findKeyById(keyId);
    if (!record) throw new Error("KEY_NOT_FOUND");
    if (record.revokedAt) throw new Error("KEY_ALREADY_REVOKED");
    if (activated) throw new Error("KEY_ALREADY_ACTIVATED");
    const revoked: InvitationKey = { ...record, revokedAt: this.now(), revokedBy: actorId };
    this.store.saveKey(revoked);
    return revoked;
  }
}

export class InMemoryInvitationKeyStore implements InvitationKeyStore {
  readonly keys = new Map<string, InvitationKey>();

  findKeyByHash(keyHash: string): InvitationKey | undefined {
    return [...this.keys.values()].find((key) => key.keyHash === keyHash);
  }

  findKeyById(keyId: string): InvitationKey | undefined {
    return this.keys.get(keyId);
  }

  listKeys(): InvitationKey[] {
    return [...this.keys.values()];
  }

  saveKey(key: InvitationKey): void {
    this.keys.set(key.keyId, key);
  }
}
