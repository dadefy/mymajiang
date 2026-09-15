import type { InvitationKey, InvitationKeyStore } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface InvitationKeyRow {
  key_id: string;
  key_hash: string;
  key_hint: string;
  note: string;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

// key_hash 不参与更新：一把密钥的明文哈希是不可变的，改它等于换了一把钥匙。
const UPSERT_KEY_SQL = `INSERT INTO invitation_keys (
    key_id, key_hash, key_hint, note, created_by, created_at, revoked_at, revoked_by
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (key_id) DO UPDATE SET
    note = EXCLUDED.note, revoked_at = EXCLUDED.revoked_at, revoked_by = EXCLUDED.revoked_by`;

/**
 * 邀请密钥的发放与撤销账目。
 *
 * 和其他仓库一样在内存里镜像一份并在启动时载入：领域服务是同步的，而且这套数据的写入
 * 只发生在管理员签发（低频）与极少数撤销上。规模大到需要分页时再改成按需查询。
 */
export class PostgresInvitationKeyStore implements InvitationKeyStore {
  private readonly keys = new Map<string, InvitationKey>();

  private constructor(
    private readonly queue: PostgresWriteQueue,
    keys: readonly InvitationKey[],
  ) {
    for (const key of keys) this.keys.set(key.keyId, key);
  }

  static async load(
    database: PostgresDatabase,
    queue: PostgresWriteQueue = new PostgresWriteQueue(database),
  ): Promise<PostgresInvitationKeyStore> {
    const rows = await database.pool.query<InvitationKeyRow>(
      `SELECT key_id, key_hash, key_hint, note, created_by, created_at, revoked_at, revoked_by
         FROM invitation_keys ORDER BY created_at ASC, key_id ASC`,
    );
    return new PostgresInvitationKeyStore(queue, rows.rows.map(keyFromRow));
  }

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
    this.queue.enqueue(UPSERT_KEY_SQL, [
      key.keyId,
      key.keyHash,
      key.keyHint,
      key.note,
      key.createdBy,
      key.createdAt,
      key.revokedAt ?? null,
      key.revokedBy ?? null,
    ]);
  }

  /**
   * Waits for every queued write. All repositories share one queue, so flushing any of them drains
   * the others too.
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }
}

function keyFromRow(row: InvitationKeyRow): InvitationKey {
  return {
    keyId: row.key_id,
    keyHash: row.key_hash.trim(),
    keyHint: row.key_hint,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.revoked_by ? { revokedBy: row.revoked_by } : {}),
  };
}
