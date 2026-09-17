import { type PointService, reserveAccountWrite, type PointLedgerEntry, type UserAccount } from "@mianyang-mahjong/domain";
import type { AppDependencies } from "./app.js";

/** Stage against copies; publish only after the balance and ledger transaction commits. */
export async function commitPointMutation(
  dependencies: AppDependencies,
  account: UserAccount,
  prepare: (service: PointService, draft: UserAccount) => PointLedgerEntry,
): Promise<PointLedgerEntry> {
  const release = reserveAccountWrite(account);
  try {
    const draft = { ...account };
    // Reuse the live service's ID/clock providers without changing its state.
    const service = dependencies.pointService.fork();
    const entry = prepare(service, draft);
    if (dependencies.adminStore) {
      try {
        await dependencies.adminStore.commitPointAdjustment(draft, entry);
      } catch (error) {
        // Drain the failed batch so a subsequent retry starts cleanly.
        await dependencies.adminStore.flush().catch(() => {});
        throw error;
      }
    } else {
      // In-memory mode has no I/O; no await between staging and publication.
      if (dependencies.accountStore.flush) throw new Error("Durable point changes require an admin store");
    }
    account.points = draft.points;
    dependencies.pointService.ledger.push(entry);
    return entry;
  } finally {
    release();
  }
}
