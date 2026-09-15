import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AccountService,
  DEFAULT_RECALL_POLICY,
  InMemoryAccountStore,
  InMemoryInvitationKeyStore,
  InvitationKeyService,
  PointService,
  canEnterMatch,
  canRecallMessage,
  type InvitationKeyCodec,
} from "./index.js";

const PREFIX = "MYMJ";
let keySequence = 0;

/** 与真实实现同一套规则（MYMJ + 16 位、无分隔符归一化、SHA-256），只是明文可预测。 */
const codec: InvitationKeyCodec = {
  generate: () => {
    const body = String((keySequence += 1)).padStart(16, "0");
    return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
  },
  normalize: (input) => {
    const canonical = input.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!canonical.startsWith(PREFIX) || canonical.length !== PREFIX.length + 16) {
      throw new Error("KEY_MALFORMED");
    }
    return canonical;
  },
  hash: (canonical) => createHash("sha256").update(canonical).digest("hex"),
  hint: (canonical) => canonical.slice(0, 8),
};

function invitationService() {
  const store = new InMemoryInvitationKeyStore();
  let sequence = 0;
  return { store, service: new InvitationKeyService(store, codec, () => `key-${(sequence += 1)}`) };
}

describe("invitation key activation", () => {
  it("首次使用密钥就建立账号并绑定", () => {
    const keys = invitationService();
    const issued = keys.service.issue({ count: 1, note: "给张三", actorId: "developer" })[0]!;
    const store = new InMemoryAccountStore();
    const accounts = new AccountService(store, keys.service, () => "1234567890");

    const account = accounts.activateWithKey({ key: issued.key, nickname: " 张三 ", avatarUrl: " file://a " });

    expect(account).toMatchObject({
      userId: "1234567890",
      nickname: "张三",
      avatarUrl: "file://a",
      status: "active",
      points: 0,
    });
    expect(account.invitationKeyHash).toBe(codec.hash(codec.normalize(issued.key)));
    expect(canEnterMatch(account)).toBe(false);

    // 明文不落库：密钥账目里只有哈希和管理员辨认用的提示位。
    const stored = [...keys.store.keys.values()][0]!;
    expect(stored.keyHash).toHaveLength(64);
    expect(stored.keyHint).toBe(codec.hint(codec.normalize(issued.key)));
    expect(JSON.stringify(stored)).not.toContain(codec.normalize(issued.key));
  });

  it("一把密钥只能建立一个账号", () => {
    const keys = invitationService();
    const issued = keys.service.issue({ count: 1, note: "", actorId: "developer" })[0]!;
    const store = new InMemoryAccountStore();
    const accounts = new AccountService(store, keys.service, () => "1234567890");

    accounts.activateWithKey({ key: issued.key, nickname: "张三", avatarUrl: "a" });

    expect(() => accounts.activateWithKey({ key: issued.key, nickname: "李四", avatarUrl: "b" }))
      .toThrow("KEY_ALREADY_ACTIVATED");
    expect(store.accounts.size).toBe(1);
  });

  it("拒绝格式不对、未知与已撤销的密钥", () => {
    const keys = invitationService();

    expect(() => keys.service.resolve("MYMJ-不是密钥")).toThrow("KEY_MALFORMED");
    expect(() => keys.service.resolve("MYMJ-0000-0000-0000-0000")).toThrow("KEY_INVALID");

    const issued = keys.service.issue({ count: 1, note: "", actorId: "developer" })[0]!;
    keys.service.revoke(issued.keyId, "developer", false);
    expect(() => keys.service.resolve(issued.key)).toThrow("KEY_REVOKED");
    expect(() => keys.service.revoke(issued.keyId, "developer", false)).toThrow("KEY_ALREADY_REVOKED");
  });

  it("已经绑定账号的密钥不允许撤销", () => {
    const keys = invitationService();
    const issued = keys.service.issue({ count: 1, note: "", actorId: "developer" })[0]!;

    // 撤销一把已绑定的密钥等于把用户锁在门外，只能改账号状态。
    expect(() => keys.service.revoke(issued.keyId, "developer", true)).toThrow("KEY_ALREADY_ACTIVATED");
    expect(() => keys.service.revoke("missing-key", "developer", false)).toThrow("KEY_NOT_FOUND");
  });

  it("一次签发的数量有上下限，备注会被保留", () => {
    const keys = invitationService();

    expect(() => keys.service.issue({ count: 0, note: "", actorId: "developer" })).toThrow("Between 1 and 100");
    expect(() => keys.service.issue({ count: 101, note: "", actorId: "developer" })).toThrow("Between 1 and 100");
    expect(keys.service.issue({ count: 2, note: " 给一群 ", actorId: "developer" })).toHaveLength(2);
    expect(keys.service.list().every((key) => key.note === "给一群")).toBe(true);
    expect(keys.service.list()).toHaveLength(2);
  });
});

describe("point administration", () => {
  it("allows only super administrators and never creates a negative balance", () => {
    const account = {
      userId: "1234567890",
      nickname: "用户",
      avatarUrl: "file://avatar",
      status: "active" as const,
      points: 0,
      createdAt: new Date(),
    };
    const service = new PointService(() => "ledger-1");
    expect(() => service.adjustByAdmin(account, { adminId: "reviewer", role: "review_admin" }, 500, "发放"))
      .toThrow("Only super administrators");
    const entry = service.adjustByAdmin(account, { adminId: "root", role: "super_admin" }, 500, "审核后发放");
    expect(entry.balanceAfter).toBe(500);
    expect(canEnterMatch(account)).toBe(true);
    expect(() => service.adjustByAdmin(account, { adminId: "root", role: "super_admin" }, -501, "扣减"))
      .toThrow("cannot become negative");
  });
});

describe("message recall", () => {
  const message = {
    messageId: "message-1",
    groupId: "group-1",
    senderId: "user-1",
    sentAt: new Date("2026-09-15T04:00:00.000Z"),
  };

  it("allows the sender to recall within two minutes", () => {
    expect(canRecallMessage({
      actorId: "user-1",
      actorRole: "member",
      message,
      now: new Date("2026-09-15T04:01:59.000Z"),
    })).toBe(true);
  });

  it("blocks the sender after two minutes or when user recall is disabled", () => {
    expect(canRecallMessage({
      actorId: "user-1",
      actorRole: "member",
      message,
      now: new Date("2026-09-15T04:02:01.000Z"),
    })).toBe(false);
    expect(canRecallMessage({
      actorId: "user-1",
      actorRole: "member",
      message,
      now: new Date("2026-09-15T04:01:00.000Z"),
      policy: { ...DEFAULT_RECALL_POLICY, userRecallEnabled: false },
    })).toBe(false);
  });

  it("allows group administrators to recall older messages", () => {
    expect(canRecallMessage({
      actorId: "admin-1",
      actorRole: "admin",
      message,
      now: new Date("2026-09-16T04:00:00.000Z"),
    })).toBe(true);
  });
});
