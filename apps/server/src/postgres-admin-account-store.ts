import type { AdminAccount, AdminAccountStore, AdminRole } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface AdminAccountRow {
  admin_id: string;
  password_hash: string;
  role: AdminRole;
  created_at: Date;
  updated_at: Date;
}

const UPSERT_ADMIN_SQL = `INSERT INTO admin_accounts (admin_id, password_hash, role, created_at, updated_at)
  VALUES ($1,$2,$3,$4,$5)
  ON CONFLICT (admin_id) DO UPDATE SET
    password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, updated_at = EXCLUDED.updated_at`;

/**
 * 管理员账号的持久化。
 *
 * 账号数量极少、只在启动与改密时写，所以写入走与其它仓库共享的队列即可 ——
 * 不需要单独的事务。
 */
export class PostgresAdminAccountStore implements AdminAccountStore {
  private constructor(
    private readonly queue: PostgresWriteQueue,
    private readonly accounts: Map<string, AdminAccount>,
  ) {}

  /** 读出全部管理员账号。传入与其它仓库共享的写队列。 */
  static async load(
    database: PostgresDatabase,
    queue: PostgresWriteQueue = new PostgresWriteQueue(database),
  ): Promise<PostgresAdminAccountStore> {
    const rows = await database.pool.query<AdminAccountRow>(
      "SELECT admin_id, password_hash, role, created_at, updated_at FROM admin_accounts ORDER BY admin_id ASC",
    );
    const accounts = new Map<string, AdminAccount>(
      rows.rows.map((row) => [
        row.admin_id.trim(),
        {
          adminId: row.admin_id.trim(),
          passwordHash: row.password_hash,
          role: row.role,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      ]),
    );
    return new PostgresAdminAccountStore(queue, accounts);
  }

  listAdminAccounts(): AdminAccount[] {
    return [...this.accounts.values()];
  }

  findAdminAccount(adminId: string): AdminAccount | undefined {
    return this.accounts.get(adminId);
  }

  saveAdminAccount(account: AdminAccount): void {
    this.accounts.set(account.adminId, account);
    this.queue.enqueue(UPSERT_ADMIN_SQL, [
      account.adminId,
      account.passwordHash,
      account.role,
      account.createdAt,
      account.updatedAt,
    ]);
  }

  /**
   * 等待队列排空。所有仓库共享一个队列，所以冲刷任意一个都会把其它的也带走。
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }
}
