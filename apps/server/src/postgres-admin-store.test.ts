import { describe, expect, it } from "vitest";
import type { AdminAuditEntry, PointLedgerEntry, UserAccount } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresAccountStore } from "./postgres-account-store.js";
import { PostgresAdminStore } from "./postgres-admin-store.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface RecordedQuery {
  channel: "pool" | "tx";
  sql: string;
  parameters: unknown[];
}

function fakeDatabase(options: { ledgerRows?: unknown[]; auditRows?: unknown[]; failOn?: string } = {}) {
  const timeline: RecordedQuery[] = [];

  const client = {
    async query(sql: string, parameters: unknown[] = []) {
      timeline.push({ channel: "tx", sql, parameters });
      if (options.failOn && sql.includes(options.failOn)) throw new Error("database offline");
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };

  const pool = {
    async query(sql: string, parameters: unknown[] = []) {
      timeline.push({ channel: "pool", sql, parameters });
      if (sql.includes("FROM point_ledger")) return { rows: options.ledgerRows ?? [], rowCount: 1 };
      if (sql.includes("FROM admin_audit_log")) return { rows: options.auditRows ?? [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    async connect() {
      return client;
    },
  };

  return { database: { pool } as unknown as PostgresDatabase, timeline };
}

/** Collapses a statement into a short label so assertions stay readable. */
function label(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed.startsWith("INSERT INTO users")) return "users";
  if (trimmed.startsWith("INSERT INTO point_ledger")) return "point_ledger";
  if (trimmed.startsWith("INSERT INTO admin_audit_log")) return "admin_audit_log";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

function writes(timeline: RecordedQuery[]): string[] {
  return timeline
    .filter((entry) => ["BEGIN", "COMMIT", "ROLLBACK", "users", "point_ledger", "admin_audit_log"].includes(label(entry.sql)))
    .map((entry) => label(entry.sql));
}

function account(): UserAccount {
  return {
    userId: "1234567890",
    nickname: "用户",
    avatarUrl: "avatar",
    status: "active",
    points: 500,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
  };
}

function adjustment(): PointLedgerEntry {
  return {
    ledgerId: "00000000-0000-0000-0000-0000000000ab",
    userId: "1234567890",
    type: "admin_adjustment",
    delta: 500,
    balanceBefore: 0,
    balanceAfter: 500,
    reason: "补发",
    actorId: "developer",
    createdAt: new Date("2026-09-15T01:00:00.000Z"),
  };
}

function banAudit(): AdminAuditEntry {
  return {
    auditId: "00000000-0000-0000-0000-0000000000cd",
    action: "account_status_change",
    actorId: "developer",
    targetUserId: "1234567890",
    before: "active",
    after: "temporarily_banned",
    reason: "违规",
    createdAt: new Date("2026-09-15T02:00:00.000Z"),
  };
}

describe("PostgresAdminStore", () => {
  it("loads persisted ledger and audit history in creation order", async () => {
    const { database } = fakeDatabase({
      ledgerRows: [
        {
          ledger_id: "00000000-0000-0000-0000-0000000000ab",
          user_id: "1234567890",
          entry_type: "admin_adjustment",
          delta: "500",
          balance_before: "0",
          balance_after: "500",
          reason: "补发",
          actor_id: "developer",
          room_id: "00000000-0000-0000-0000-0000000000aa",
          reversal_of: null,
          created_at: new Date("2026-09-15T01:00:00.000Z"),
        },
        {
          ledger_id: "00000000-0000-0000-0000-0000000000ef",
          user_id: "1234567890",
          entry_type: "admin_reversal",
          delta: "-500",
          balance_before: "500",
          balance_after: "0",
          reason: "撤销",
          actor_id: "developer",
          room_id: null,
          reversal_of: "00000000-0000-0000-0000-0000000000ab",
          created_at: new Date("2026-09-15T02:00:00.000Z"),
        },
      ],
      auditRows: [
        {
          audit_id: "00000000-0000-0000-0000-0000000000cd",
          action: "account_status_change",
          actor_id: "developer",
          target_user_id: "1234567890",
          before_value: "active",
          after_value: "temporarily_banned",
          reason: "违规",
          created_at: new Date("2026-09-15T03:00:00.000Z"),
        },
      ],
    });

    const store = await PostgresAdminStore.load(database);

    expect(store.ledgerEntries).toHaveLength(2);
    expect(store.ledgerEntries[0]).toMatchObject({
      ledgerId: "00000000-0000-0000-0000-0000000000ab",
      userId: "1234567890",
      type: "admin_adjustment",
      delta: 500,
      balanceBefore: 0,
      balanceAfter: 500,
      roomId: "00000000-0000-0000-0000-0000000000aa",
    });
    expect(store.ledgerEntries[0]).not.toHaveProperty("reversalOf");
    expect(store.ledgerEntries[1]).toMatchObject({
      type: "admin_reversal",
      delta: -500,
      reversalOf: "00000000-0000-0000-0000-0000000000ab",
    });
    expect(store.ledgerEntries[1]).not.toHaveProperty("roomId");
    expect(store.auditEntries).toHaveLength(1);
    expect(store.auditEntries[0]).toMatchObject({
      action: "account_status_change",
      targetUserId: "1234567890",
      before: "active",
      after: "temporarily_banned",
      reason: "违规",
    });
  });

  it("rejects a ledger row that cannot be trusted", async () => {
    const { database } = fakeDatabase({
      ledgerRows: [
        {
          ledger_id: "00000000-0000-0000-0000-0000000000ab",
          user_id: "1234567890",
          entry_type: "admin_adjustment",
          delta: "not-a-number",
          balance_before: "0",
          balance_after: "500",
          reason: "补发",
          actor_id: "developer",
          reversal_of: null,
          created_at: new Date("2026-09-15T01:00:00.000Z"),
        },
      ],
    });

    await expect(PostgresAdminStore.load(database)).rejects.toThrow("Unsafe integer");
  });

  it("commits the account balance and its ledger entry inside one transaction", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresAdminStore.load(database);

    store.commitPointAdjustment(account(), adjustment());
    await store.flush();

    expect(writes(timeline)).toEqual(["BEGIN", "users", "point_ledger", "COMMIT"]);
    const ledgerWrite = timeline.find((entry) => label(entry.sql) === "point_ledger")!;
    expect(ledgerWrite.parameters).toEqual([
      "00000000-0000-0000-0000-0000000000ab",
      "1234567890",
      "admin_adjustment",
      500,
      0,
      500,
      "补发",
      "developer",
      null,
      null,
      expect.any(Date),
    ]);
  });

  it("commits the account status and its audit entry inside one transaction", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresAdminStore.load(database);

    store.commitAccountStatusChange(account(), banAudit());
    await store.flush();

    expect(writes(timeline)).toEqual(["BEGIN", "users", "admin_audit_log", "COMMIT"]);
    const auditWrite = timeline.find((entry) => label(entry.sql) === "admin_audit_log")!;
    expect(auditWrite.parameters).toEqual([
      "00000000-0000-0000-0000-0000000000cd",
      "account_status_change",
      "developer",
      "1234567890",
      '"active"',
      '"temporarily_banned"',
      "违规",
      expect.any(Date),
    ]);
  });

  it("rolls back and reports the failure when a ledger write fails", async () => {
    const { database, timeline } = fakeDatabase({ failOn: "INSERT INTO point_ledger" });
    const store = await PostgresAdminStore.load(database);

    store.commitPointAdjustment(account(), adjustment());
    await expect(store.flush()).rejects.toThrow("database offline");
    expect(writes(timeline)).toEqual(["BEGIN", "users", "point_ledger", "ROLLBACK"]);
  });

  it("keeps writes from every repository in request order on a shared queue", async () => {
    const { database, timeline } = fakeDatabase();
    const queue = new PostgresWriteQueue(database);
    const accountStore = await PostgresAccountStore.load(database, queue);
    const adminStore = await PostgresAdminStore.load(database, queue);
    const user = account();

    accountStore.saveAccount(user);
    adminStore.commitPointAdjustment(user, adjustment());
    accountStore.saveAccount(user);
    await accountStore.flush();

    expect(writes(timeline)).toEqual([
      "users",
      "BEGIN",
      "users",
      "point_ledger",
      "COMMIT",
      "users",
    ]);
  });
});
