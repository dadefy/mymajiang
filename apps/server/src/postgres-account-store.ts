import { InMemoryAccountStore, type UserAccount } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { UPSERT_ACCOUNT_SQL, accountParameters } from "./postgres-statements.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface AccountRow {
  user_id: string;
  invitation_key_hash: string | null;
  password_hash: string | null;
  nickname: string;
  avatar_url: string;
  status: UserAccount["status"];
  points: string;
  active_match_id: string | null;
  created_at: Date;
}

export class PostgresAccountStore extends InMemoryAccountStore {
  private constructor(readonly queue: PostgresWriteQueue) {
    super();
  }

  /** Loads persisted accounts. Reuse one queue for every repository. */
  static async load(
    database: PostgresDatabase,
    queue: PostgresWriteQueue = new PostgresWriteQueue(database),
  ): Promise<PostgresAccountStore> {
    const store = new PostgresAccountStore(queue);
    const accounts = await database.pool.query<AccountRow>("SELECT * FROM users");
    for (const row of accounts.rows) {
      const account: UserAccount = {
        userId: row.user_id.trim(),
        ...(row.password_hash ? { passwordHash: row.password_hash } : {}),
        nickname: row.nickname,
        avatarUrl: row.avatar_url,
        status: row.status,
        points: Number(row.points),
        createdAt: row.created_at,
        ...(row.invitation_key_hash ? { invitationKeyHash: row.invitation_key_hash.trim() } : {}),
        ...(row.active_match_id ? { activeMatchId: row.active_match_id } : {}),
      };
      if (!Number.isSafeInteger(account.points)) throw new Error(`Unsafe point balance for user ${account.userId}`);
      store.accounts.set(account.userId, account);
    }
    return store;
  }

  override saveAccount(account: UserAccount): void {
    super.saveAccount(account);
    this.queue.enqueue(UPSERT_ACCOUNT_SQL, accountParameters(account));
  }

  async flush(): Promise<void> {
    await this.queue.flush();
  }
}
