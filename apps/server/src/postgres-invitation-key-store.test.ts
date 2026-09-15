import { describe, expect, it } from "vitest";
import type { InvitationKey } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresInvitationKeyStore } from "./postgres-invitation-key-store.js";

function key(overrides: Partial<InvitationKey> = {}): InvitationKey {
  return {
    keyId: "00000000-0000-0000-0000-000000000001",
    keyHash: "a".repeat(64),
    keyHint: "MYMJ7K3M",
    note: "给张三",
    createdBy: "developer",
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeDatabase(rows: unknown[] = []) {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = [];
  const database = {
    pool: {
      async query(sql: string, parameters?: unknown[]) {
        statements.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("FROM invitation_keys")) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 1 };
      },
    },
  } as unknown as PostgresDatabase;
  return { database, statements };
}

describe("PostgresInvitationKeyStore", () => {
  it("启动时载入已签发的密钥", async () => {
    const { database } = fakeDatabase([
      {
        key_id: "00000000-0000-0000-0000-000000000001",
        key_hash: "a".repeat(64),
        key_hint: "MYMJ7K3M",
        note: "给张三",
        created_by: "developer",
        created_at: new Date("2026-09-15T00:00:00.000Z"),
        revoked_at: null,
        revoked_by: null,
      },
    ]);

    const store = await PostgresInvitationKeyStore.load(database);

    expect(store.listKeys()).toHaveLength(1);
    expect(store.findKeyByHash("a".repeat(64))?.note).toBe("给张三");
    expect(store.findKeyById("00000000-0000-0000-0000-000000000001")?.keyHint).toBe("MYMJ7K3M");
  });

  it("签发与撤销都落库，但不会改写密钥哈希", async () => {
    const { database, statements } = fakeDatabase();
    const store = await PostgresInvitationKeyStore.load(database);

    const record = key();
    store.saveKey(record);
    store.saveKey({ ...record, note: "给李四", revokedAt: new Date("2026-09-15T01:00:00.000Z"), revokedBy: "developer" });
    await store.flush();

    const writes = statements.filter((entry) => entry.sql.includes("INSERT INTO invitation_keys"));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.parameters).toEqual([
      record.keyId,
      record.keyHash,
      record.keyHint,
      "给张三",
      "developer",
      record.createdAt,
      null,
      null,
    ]);
    expect(writes[1]!.parameters?.[6]).toBeInstanceOf(Date);
    // 哈希是这把密钥的身份，冲突时不能被改写。
    expect(statements.some((entry) => entry.sql.includes("key_hash = EXCLUDED.key_hash"))).toBe(false);
  });

  it("启动时没有任何密钥也能正常工作", async () => {
    const { database } = fakeDatabase();

    const store = await PostgresInvitationKeyStore.load(database);

    expect(store.listKeys()).toEqual([]);
    expect(store.findKeyByHash("a".repeat(64))).toBeUndefined();
  });
});
