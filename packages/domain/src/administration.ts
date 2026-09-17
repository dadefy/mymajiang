import { assertAccountWritable, type AccountStatus, type UserAccount } from "./accounts.js";
import type { AdminActor } from "./points.js";

export type ManageableAccountStatus = Extract<AccountStatus, "active" | "temporarily_banned" | "permanently_banned">;

export interface AdminAuditEntry {
  auditId: string;
  action: "account_status_change";
  actorId: string;
  targetUserId: string;
  before: ManageableAccountStatus;
  after: ManageableAccountStatus;
  reason: string;
  createdAt: Date;
}

export class AccountAdministrationService {
  readonly auditLog: AdminAuditEntry[] = [];

  constructor(
    private readonly createAuditId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  changeStatus(
    account: UserAccount,
    actor: AdminActor,
    status: ManageableAccountStatus,
    reason: string,
  ): AdminAuditEntry {
    assertAccountWritable(account);
    if (actor.role !== "super_admin") throw new Error("Only super administrators can change account status");
    if (account.activeMatchId) throw new Error("Account status cannot change during an active match");
    if (account.status !== "active" && account.status !== "temporarily_banned" && account.status !== "permanently_banned") {
      throw new Error("Account status cannot be managed");
    }
    if (account.status === status) throw new Error("Account already has the requested status");
    if (!reason.trim()) throw new Error("Status change reason is required");
    const entry: AdminAuditEntry = {
      auditId: this.createAuditId(),
      action: "account_status_change",
      actorId: actor.adminId,
      targetUserId: account.userId,
      before: account.status,
      after: status,
      reason: reason.trim(),
      createdAt: this.now(),
    };
    account.status = status;
    this.auditLog.push(entry);
    return entry;
  }

  /**
   * Replaces the in-memory audit log with entries loaded from durable storage.
   *
   * Called once at startup so administrator operations stay traceable after a restart.
   * Entries must be supplied in ascending creation order.
   */
  restore(entries: readonly AdminAuditEntry[]): void {
    this.auditLog.length = 0;
    this.auditLog.push(...entries);
  }
}
