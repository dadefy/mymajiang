import { describe, expect, it } from "vitest";
import { AccountAdministrationService, PointService, type UserAccount } from "./index.js";

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

describe("administration", () => {
  it("audits account bans and unbans", () => {
    let sequence = 0;
    const service = new AccountAdministrationService(() => `audit-${++sequence}`);
    const user = account();
    const banned = service.changeStatus(user, { adminId: "admin", role: "super_admin" }, "temporarily_banned", "违规");
    expect(banned).toMatchObject({ before: "active", after: "temporarily_banned", reason: "违规" });
    expect(user.status).toBe("temporarily_banned");
    service.changeStatus(user, { adminId: "admin", role: "super_admin" }, "active", "复核通过");
    expect(service.auditLog).toHaveLength(2);
  });

  it("prevents reviewers and active matches from changing status", () => {
    const service = new AccountAdministrationService(() => "audit-1");
    const user = account();
    expect(() => service.changeStatus(user, { adminId: "reviewer", role: "review_admin" }, "temporarily_banned", "违规"))
      .toThrow("Only super administrators");
    user.activeMatchId = "room-1";
    expect(() => service.changeStatus(user, { adminId: "admin", role: "super_admin" }, "temporarily_banned", "违规"))
      .toThrow("active match");
  });

  it("records and reverses administrator point adjustments", () => {
    let sequence = 0;
    const service = new PointService(() => `ledger-${++sequence}`);
    const user = account();
    const adjustment = service.adjustByAdmin(user, { adminId: "admin", role: "super_admin" }, 200, "补发");
    const reversal = service.reverseAdminAdjustment(
      user,
      { adminId: "admin", role: "super_admin" },
      adjustment.ledgerId,
      "操作错误",
    );
    expect(reversal).toMatchObject({ delta: -200, balanceAfter: 500, reversalOf: adjustment.ledgerId });
    expect(service.entriesFor(user.userId)).toHaveLength(2);
    expect(() => service.reverseAdminAdjustment(user, { adminId: "admin", role: "super_admin" }, adjustment.ledgerId, "再次撤销"))
      .toThrow("already reversed");
  });

  it("restores the point ledger from durable history", () => {
    const service = new PointService(() => "ledger-new");
    const user = account();
    service.restore([
      {
        ledgerId: "ledger-old-1",
        userId: user.userId,
        type: "admin_adjustment",
        delta: 300,
        balanceBefore: 500,
        balanceAfter: 800,
        reason: "补发",
        actorId: "admin",
        createdAt: new Date("2026-09-15T01:00:00.000Z"),
      },
      {
        ledgerId: "ledger-old-2",
        userId: user.userId,
        type: "admin_reversal",
        delta: -300,
        balanceBefore: 800,
        balanceAfter: 500,
        reason: "撤销",
        actorId: "admin",
        createdAt: new Date("2026-09-15T02:00:00.000Z"),
        reversalOf: "ledger-old-1",
      },
    ]);

    const entries = service.entriesFor(user.userId);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.ledgerId).toBe("ledger-old-2");
    expect(() => service.reverseAdminAdjustment(user, { adminId: "admin", role: "super_admin" }, "ledger-old-1", "再次撤销"))
      .toThrow("already reversed");
  });

  it("restores the administrator audit log from durable history", () => {
    const service = new AccountAdministrationService(() => "audit-new");
    service.restore([
      {
        auditId: "audit-old",
        action: "account_status_change",
        actorId: "admin",
        targetUserId: "1234567890",
        before: "active",
        after: "temporarily_banned",
        reason: "违规",
        createdAt: new Date("2026-09-15T01:00:00.000Z"),
      },
    ]);

    expect(service.auditLog).toHaveLength(1);
    expect(service.auditLog[0]).toMatchObject({ auditId: "audit-old", after: "temporarily_banned" });
  });
});
