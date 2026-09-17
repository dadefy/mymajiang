import { describe, expect, it } from "vitest";
import type { PostgresDatabase } from "./database.js";
import { PostgresAccountStore } from "./postgres-account-store.js";

function fakeDatabase(options: { users?: unknown[]; failWrites?: boolean } = {}) {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = [];
  const database = {
    pool: {
      async query(sql: string, parameters?: unknown[]) {
        statements.push({ sql, ...(parameters ? { parameters } : {}) });
        if (options.failWrites && sql.includes("INSERT INTO users")) throw new Error("database offline");
        if (sql === "SELECT * FROM users") return { rows: options.users ?? [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    },
  } as unknown as PostgresDatabase;
  return { database, statements };
}

describe("PostgresAccountStore", () => {
  it("hydrates accounts, then flushes queued writes", async () => {
    const { database, statements } = fakeDatabase({
      users: [{
        user_id: "1234567890",
        invitation_key_hash: "a".repeat(64),
        password_hash: "persisted-password-hash",
        nickname: "内测用户",
        avatar_url: "avatar",
        status: "active",
        points: "800",
        active_match_id: null,
        created_at: new Date("2026-09-15T00:00:00.000Z"),
      }],
    });

    const store = await PostgresAccountStore.load(database);
    const account = store.findAccountById("1234567890")!;
    expect(account.points).toBe(800);
    expect(account.passwordHash).toBe("persisted-password-hash");
    expect(account.invitationKeyHash).toBe("a".repeat(64));
    // 登录就是这一个查询：密钥哈希 → 账号。
    expect(store.findAccountByInvitationKeyHash("a".repeat(64))?.userId).toBe("1234567890");

    account.points = 900;
    store.saveAccount(account);
    await store.flush();
    const write = statements.find((entry) => entry.sql.includes("INSERT INTO users"));
    expect(write?.parameters).toContain(900);
    expect(write?.parameters).toContain("persisted-password-hash");
  });

  it("keeps the invitation binding out of the conflicting update", async () => {
    const { database, statements } = fakeDatabase();

    const store = await PostgresAccountStore.load(database);
    store.saveAccount({
      userId: "1234567890",
      nickname: "用户",
      avatarUrl: "avatar",
      status: "active",
      points: 0,
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
      invitationKeyHash: "a".repeat(64),
    });
    await store.flush();

    const write = statements.find((entry) => entry.sql.includes("INSERT INTO users"))!;
    expect(write.parameters).toContain("a".repeat(64));
    // 绑定是不可变的：冲突时只更新昵称、头像、状态、积分与对局，不碰密钥哈希。
    expect(write.sql.includes("invitation_key_hash = EXCLUDED.invitation_key_hash")).toBe(false);
  });

  it("surfaces a queued database write failure from flush", async () => {
    const { database } = fakeDatabase({ failWrites: true });
    const store = await PostgresAccountStore.load(database);
    store.saveAccount({
      userId: "1234567890",
      nickname: "用户",
      avatarUrl: "avatar",
      status: "active",
      points: 0,
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await expect(store.flush()).rejects.toThrow("database offline");
  });
});
