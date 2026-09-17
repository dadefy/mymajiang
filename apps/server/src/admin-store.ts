import type { AdminAuditEntry, PointLedgerEntry, UserAccount } from "@mianyang-mahjong/domain";

/**
 * Durable storage for the two administrator-owned records: the point ledger and the account
 * audit log.
 *
 * Both commits are expected to persist the account row together with its ledger or audit row in a
 * single transaction, so a balance can never change without a traceable entry and never the other
 * way around.
 */
export interface AdminStore {
  /**
   * Ledger entries read from durable storage when this store was created, ascending by creation
   * time. The domain service owns the live view; this snapshot only warms it at startup.
   */
  readonly ledgerEntries: readonly PointLedgerEntry[];

  /** Audit entries read from durable storage when this store was created, ascending by creation time. */
  readonly auditEntries: readonly AdminAuditEntry[];

  /** Atomically persists the account balance and the matching ledger entry. */
  commitPointAdjustment(account: UserAccount, entry: PointLedgerEntry): Promise<void>;

  /** Atomically persists the account status and the matching audit entry. */
  commitAccountStatusChange(account: UserAccount, entry: AdminAuditEntry): void;

  /** Waits for every queued write and rethrows the first failure. */
  flush(): Promise<void>;
}
