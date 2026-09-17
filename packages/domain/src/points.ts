import { assertAccountWritable, type UserAccount } from "./accounts.js";

export type AdminRole = "super_admin" | "review_admin";

export interface AdminActor {
  adminId: string;
  role: AdminRole;
}

export interface PointLedgerEntry {
  ledgerId: string;
  userId: string;
  type: "admin_adjustment" | "admin_reversal" | "match_settlement";
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  actorId: string;
  /** Set on `match_settlement` rows: the room whose result produced this change. */
  roomId?: string;
  createdAt: Date;
  reversalOf?: string;
}

export class PointService {
  readonly ledger: PointLedgerEntry[] = [];

  constructor(
    private readonly createLedgerId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  adjustByAdmin(account: UserAccount, actor: AdminActor, delta: number, reason: string): PointLedgerEntry {
    assertAccountWritable(account);
    if (actor.role !== "super_admin") throw new Error("Only super administrators can adjust points");
    if (account.activeMatchId) throw new Error("Points cannot be adjusted during an active match");
    if (!Number.isSafeInteger(delta) || delta === 0) throw new Error("Point adjustment must be a non-zero integer");
    if (!reason.trim()) throw new Error("Adjustment reason is required");
    const balanceAfter = account.points + delta;
    if (balanceAfter < 0) throw new Error("Account points cannot become negative");

    const entry: PointLedgerEntry = {
      ledgerId: this.createLedgerId(),
      userId: account.userId,
      type: "admin_adjustment",
      delta,
      balanceBefore: account.points,
      balanceAfter,
      reason: reason.trim(),
      actorId: actor.adminId,
      createdAt: this.now(),
    };
    account.points = balanceAfter;
    this.ledger.push(entry);
    return entry;
  }

  reverseAdminAdjustment(
    account: UserAccount,
    actor: AdminActor,
    ledgerId: string,
    reason: string,
  ): PointLedgerEntry {
    assertAccountWritable(account);
    if (actor.role !== "super_admin") throw new Error("Only super administrators can reverse point adjustments");
    if (account.activeMatchId) throw new Error("Points cannot be adjusted during an active match");
    const original = this.ledger.find((entry) => entry.ledgerId === ledgerId && entry.userId === account.userId);
    if (!original || original.type !== "admin_adjustment") throw new Error("POINT_LEDGER_NOT_FOUND");
    if (this.ledger.some((entry) => entry.reversalOf === original.ledgerId)) throw new Error("Point adjustment is already reversed");
    if (!reason.trim()) throw new Error("Reversal reason is required");
    const delta = -original.delta;
    const balanceAfter = account.points + delta;
    if (balanceAfter < 0) throw new Error("Account points cannot become negative");
    const reversal: PointLedgerEntry = {
      ledgerId: this.createLedgerId(),
      userId: account.userId,
      type: "admin_reversal",
      delta,
      balanceBefore: account.points,
      balanceAfter,
      reason: reason.trim(),
      actorId: actor.adminId,
      createdAt: this.now(),
      reversalOf: original.ledgerId,
    };
    account.points = balanceAfter;
    this.ledger.push(reversal);
    return reversal;
  }

  /** Isolated staging service; shares only the ID/clock providers. */
  fork(): PointService {
    const service = new PointService(this.createLedgerId, this.now);
    service.restore(this.ledger);
    return service;
  }

  entriesFor(userId: string): PointLedgerEntry[] {
    return this.ledger
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  /**
   * Replaces the in-memory ledger with entries loaded from durable storage.
   *
   * Called once at startup so that reversal checks and ledger queries keep working after a
   * restart. Entries must be supplied in ascending creation order.
   */
  restore(entries: readonly PointLedgerEntry[]): void {
    this.ledger.length = 0;
    this.ledger.push(...entries);
  }
}

export function canEnterMatch(account: UserAccount, minimumEntryPoints = 500): boolean {
  assertAccountWritable(account);
  return account.status === "active" && !account.activeMatchId && account.points >= minimumEntryPoints;
}
