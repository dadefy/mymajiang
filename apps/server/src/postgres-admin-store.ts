import {
  type AdminAuditEntry,
  type ManageableAccountStatus,
  type PointLedgerEntry,
  type UserAccount,
} from "@mianyang-mahjong/domain";
import type { AdminStore } from "./admin-store.js";
import type { PostgresDatabase } from "./database.js";
import {
  INSERT_POINT_LEDGER_SQL,
  UPSERT_ACCOUNT_SQL,
  accountParameters,
  ledgerParameters,
} from "./postgres-statements.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface LedgerRow {
  ledger_id: string;
  user_id: string;
  entry_type: PointLedgerEntry["type"];
  delta: string;
  balance_before: string;
  balance_after: string;
  reason: string;
  actor_id: string;
  room_id: string | null;
  reversal_of: string | null;
  created_at: Date;
}

interface AuditRow {
  audit_id: string;
  action: AdminAuditEntry["action"];
  actor_id: string;
  target_user_id: string;
  before_value: unknown;
  after_value: unknown;
  reason: string;
  created_at: Date;
}

const MANAGEABLE_STATUSES: readonly ManageableAccountStatus[] = [
  "active",
  "temporarily_banned",
  "permanently_banned",
];

const LEDGER_TYPES: readonly PointLedgerEntry["type"][] = [
  "admin_adjustment",
  "admin_reversal",
  "match_settlement",
];

const INSERT_AUDIT_SQL = `INSERT INTO admin_audit_log (
    audit_id, action, actor_id, target_user_id, before_value, after_value, reason, created_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

/**
 * Durable point ledger and administrator audit log.
 *
 * The account balance (or status) and its ledger (or audit) row are always written inside one
 * transaction on the shared write queue, so an administrator action is either fully recorded or
 * not recorded at all. Entries are read back in ascending creation order at startup so reversal
 * checks and ledger queries survive a restart.
 */
export class PostgresAdminStore implements AdminStore {
  readonly ledgerEntries: readonly PointLedgerEntry[];
  readonly auditEntries: readonly AdminAuditEntry[];

  private constructor(
    private readonly queue: PostgresWriteQueue,
    ledgerEntries: PointLedgerEntry[],
    auditEntries: AdminAuditEntry[],
  ) {
    this.ledgerEntries = ledgerEntries;
    this.auditEntries = auditEntries;
  }

  /** Reads the persisted ledger and audit history. Pass the queue shared with the account store. */
  static async load(
    database: PostgresDatabase,
    queue: PostgresWriteQueue = new PostgresWriteQueue(database),
  ): Promise<PostgresAdminStore> {
    const [ledger, audit] = await Promise.all([
      database.pool.query<LedgerRow>(
        "SELECT * FROM point_ledger ORDER BY created_at ASC, ledger_id ASC",
      ),
      database.pool.query<AuditRow>(
        "SELECT * FROM admin_audit_log ORDER BY created_at ASC, audit_id ASC",
      ),
    ]);
    return new PostgresAdminStore(
      queue,
      ledger.rows.map(ledgerEntryFromRow),
      audit.rows.map(auditEntryFromRow),
    );
  }

  commitPointAdjustment(account: UserAccount, entry: PointLedgerEntry): void {
    this.queue.enqueueTransaction([
      { sql: UPSERT_ACCOUNT_SQL, parameters: accountParameters(account) },
      { sql: INSERT_POINT_LEDGER_SQL, parameters: ledgerParameters(entry) },
    ]);
  }

  commitAccountStatusChange(account: UserAccount, entry: AdminAuditEntry): void {
    this.queue.enqueueTransaction([
      { sql: UPSERT_ACCOUNT_SQL, parameters: accountParameters(account) },
      { sql: INSERT_AUDIT_SQL, parameters: auditParameters(entry) },
    ]);
  }

  async flush(): Promise<void> {
    await this.queue.flush();
  }
}

function auditParameters(entry: AdminAuditEntry): readonly unknown[] {
  return [
    entry.auditId,
    entry.action,
    entry.actorId,
    entry.targetUserId,
    JSON.stringify(entry.before),
    JSON.stringify(entry.after),
    entry.reason,
    entry.createdAt,
  ];
}

function ledgerEntryFromRow(row: LedgerRow): PointLedgerEntry {
  if (!LEDGER_TYPES.includes(row.entry_type)) {
    throw new Error(`Unknown point ledger entry type: ${String(row.entry_type)}`);
  }
  const entry: PointLedgerEntry = {
    ledgerId: row.ledger_id,
    userId: row.user_id.trim(),
    type: row.entry_type,
    delta: safeInteger(row.delta, "delta"),
    balanceBefore: safeInteger(row.balance_before, "balance_before"),
    balanceAfter: safeInteger(row.balance_after, "balance_after"),
    reason: row.reason,
    actorId: row.actor_id,
    createdAt: row.created_at,
    ...(row.room_id ? { roomId: row.room_id } : {}),
    ...(row.reversal_of ? { reversalOf: row.reversal_of } : {}),
  };
  return entry;
}

function auditEntryFromRow(row: AuditRow): AdminAuditEntry {
  if (row.action !== "account_status_change") {
    throw new Error(`Unknown administrator audit action: ${String(row.action)}`);
  }
  return {
    auditId: row.audit_id,
    action: row.action,
    actorId: row.actor_id,
    targetUserId: row.target_user_id.trim(),
    before: manageableStatus(row.before_value, "before_value"),
    after: manageableStatus(row.after_value, "after_value"),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function safeInteger(value: string | number, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Unsafe integer stored in point_ledger.${column}: ${String(value)}`);
  }
  return parsed;
}

function manageableStatus(value: unknown, column: string): ManageableAccountStatus {
  // `pg` parses JSONB into a JavaScript value already, but accept a raw JSON text column too.
  const parsed = parseJsonText(value);
  if (typeof parsed === "string" && (MANAGEABLE_STATUSES as readonly string[]).includes(parsed)) {
    return parsed as ManageableAccountStatus;
  }
  throw new Error(`Unexpected value stored in admin_audit_log.${column}: ${JSON.stringify(value)}`);
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
