import { describe, expect, it } from "vitest";
import type { UserAccount } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresGroupStore, type GroupIdGenerators } from "./postgres-group-store.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface RecordedQuery {
  channel: "pool" | "tx";
  sql: string;
  parameters: unknown[];
}

function fakeDatabase(
  options: { groups?: unknown[]; members?: unknown[]; messages?: unknown[]; failOn?: string } = {},
) {
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
      if (sql.includes("FROM chat_groups")) return { rows: options.groups ?? [], rowCount: 1 };
      if (sql.includes("FROM group_members")) return { rows: options.members ?? [], rowCount: 1 };
      if (sql.includes("FROM group_messages")) return { rows: options.messages ?? [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    async connect() {
      return client;
    },
  };

  return { database: { pool } as unknown as PostgresDatabase, timeline };
}

/** Labels a statement so assertions read as a write list; SELECTs collapse to "other". */
function label(sql: string): string {
  const trimmed = sql.trim().replace(/\s+/g, " ");
  if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") return trimmed;
  const match = /^(INSERT INTO|DELETE FROM) (\w+)/.exec(trimmed);
  return match ? `${match[1] === "INSERT INTO" ? "insert" : "delete"}:${match[2]}` : "other";
}

function writes(timeline: RecordedQuery[]): string[] {
  return timeline.map((entry) => label(entry.sql)).filter((name) => name !== "other");
}

function parametersOf(timeline: RecordedQuery[], name: string, index = 0): unknown[] {
  const matches = timeline.filter((entry) => label(entry.sql) === name);
  return matches[index]!.parameters;
}

function generators(): GroupIdGenerators {
  let sequence = 0;
  return {
    // The domain asks for the number first, then the id, so one counter keeps both unique.
    createGroupNo: () => String(12_345_670 + (sequence += 1)),
    createGroupId: () => `group-${sequence}`,
    createMessageId: () => `message-${sequence}`,
  };
}

function account(userId: string, nickname: string): UserAccount {
  return {
    userId,
    nickname,
    avatarUrl: "avatar",
    status: "active",
    points: 0,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
  };
}

describe("PostgresGroupStore", () => {
  it("rebuilds groups, members and messages from storage", async () => {
    const { database } = fakeDatabase({
      groups: [
        {
          group_id: "group-1",
          group_no: "12345678",
          name: "测试群",
          owner_id: "1234567890",
          notice: "公告",
          all_muted: true,
          created_at: new Date("2026-09-15T00:00:00.000Z"),
        },
      ],
      members: [
        {
          group_id: "group-1",
          user_id: "1234567890",
          role: "owner",
          muted_until: null,
          joined_at: new Date("2026-09-15T00:00:00.000Z"),
        },
        {
          group_id: "group-1",
          user_id: "1234567891",
          role: "admin",
          muted_until: new Date("2026-09-15T05:00:00.000Z"),
          joined_at: new Date("2026-09-15T01:00:00.000Z"),
        },
      ],
      messages: [
        {
          message_id: "message-1",
          group_id: "group-1",
          sender_id: "1234567891",
          message_type: "voice",
          content: "https://example.invalid/voice.amr",
          voice_seconds: 12,
          sent_at: new Date("2026-09-15T02:00:00.000Z"),
          recalled_at: null,
          recalled_by: null,
        },
        {
          message_id: "message-2",
          group_id: "group-1",
          sender_id: "1234567890",
          message_type: "text",
          content: "被撤回的内容",
          voice_seconds: null,
          sent_at: new Date("2026-09-15T03:00:00.000Z"),
          recalled_at: new Date("2026-09-15T03:01:00.000Z"),
          recalled_by: "1234567890",
        },
      ],
    });

    const store = await PostgresGroupStore.load(database);
    const group = store.groups.get("group-1")!;

    expect(group).toMatchObject({ groupNo: "12345678", name: "测试群", ownerId: "1234567890", notice: "公告", allMuted: true });
    expect(group.members.get("1234567890")).toMatchObject({ role: "owner" });
    expect(group.members.get("1234567890")).not.toHaveProperty("mutedUntil");
    expect(group.members.get("1234567891")).toMatchObject({
      role: "admin",
      mutedUntil: new Date("2026-09-15T05:00:00.000Z"),
    });
    expect(group.messages).toHaveLength(2);
    expect(group.messages[0]).toMatchObject({ type: "voice", voiceSeconds: 12 });
    expect(group.messages[1]).toMatchObject({ recalledBy: "1234567890", recalledAt: new Date("2026-09-15T03:01:00.000Z") });
  });

  it("rejects rows that reference an unknown group", async () => {
    const { database } = fakeDatabase({
      groups: [
        {
          group_id: "group-1",
          group_no: "12345678",
          name: "测试群",
          owner_id: "1234567890",
          notice: "",
          all_muted: false,
          created_at: new Date("2026-09-15T00:00:00.000Z"),
        },
      ],
      messages: [
        {
          message_id: "message-1",
          group_id: "group-missing",
          sender_id: "1234567890",
          message_type: "text",
          content: "孤儿消息",
          voice_seconds: null,
          sent_at: new Date("2026-09-15T02:00:00.000Z"),
          recalled_at: null,
          recalled_by: null,
        },
      ],
    });

    await expect(PostgresGroupStore.load(database)).rejects.toThrow("unknown group");
  });

  it("writes the group and its owner membership in one transaction", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());

    const group = store.createGroup(account("1234567890", "甲"), "测试群");
    await store.flush();

    expect(writes(timeline)).toEqual(["BEGIN", "insert:chat_groups", "insert:group_members", "COMMIT"]);
    expect(parametersOf(timeline, "insert:chat_groups")).toEqual([
      group.groupId,
      "12345671",
      "测试群",
      "1234567890",
      "",
      false,
      expect.any(Date),
      null,
    ]);
    expect(parametersOf(timeline, "insert:group_members")).toEqual([
      group.groupId,
      "1234567890",
      "owner",
      null,
      expect.any(Date),
    ]);
  });

  it("persists membership, roles and mutes", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const member = account("1234567891", "乙");
    const group = store.createGroup(owner, "测试群");
    await store.flush();
    timeline.length = 0;

    store.joinByGroupNo(member, group.groupNo);
    await store.flush();
    expect(writes(timeline)).toEqual(["insert:group_members"]);
    expect(parametersOf(timeline, "insert:group_members")).toEqual([
      group.groupId,
      "1234567891",
      "member",
      null,
      expect.any(Date),
    ]);

    timeline.length = 0;
    store.setAdministrator(group.groupId, owner.userId, member.userId, true);
    await store.flush();
    expect(parametersOf(timeline, "insert:group_members")).toEqual([
      group.groupId,
      "1234567891",
      "admin",
      null,
      expect.any(Date),
    ]);

    timeline.length = 0;
    store.muteMember(group.groupId, owner.userId, member.userId, new Date("2026-09-15T06:00:00.000Z"));
    await store.flush();
    expect(parametersOf(timeline, "insert:group_members")).toEqual([
      group.groupId,
      "1234567891",
      "admin",
      new Date("2026-09-15T06:00:00.000Z"),
      expect.any(Date),
    ]);

    timeline.length = 0;
    store.removeMember(group.groupId, owner.userId, member.userId);
    await store.flush();
    expect(writes(timeline)).toEqual(["delete:group_members"]);
    expect(timeline[0]!.parameters).toEqual([group.groupId, "1234567891"]);
  });

  it("writes the group and both members when ownership is transferred", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const member = account("1234567891", "乙");
    const group = store.createGroup(owner, "测试群");
    store.joinByGroupNo(member, group.groupNo);
    await store.flush();
    timeline.length = 0;

    store.transferOwnership(group.groupId, owner.userId, member.userId);
    await store.flush();

    expect(writes(timeline)).toEqual([
      "BEGIN",
      "insert:chat_groups",
      "insert:group_members",
      "insert:group_members",
      "COMMIT",
    ]);
    expect(parametersOf(timeline, "insert:chat_groups")[3]).toBe("1234567891");
    expect(parametersOf(timeline, "insert:group_members", 0)[2]).toBe("member");
    expect(parametersOf(timeline, "insert:group_members", 1)[2]).toBe("owner");
  });

  it("persists messages and their recall state without rewriting the content", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const group = store.createGroup(owner, "测试群");
    await store.flush();
    timeline.length = 0;

    const message = store.sendMessage({
      groupId: group.groupId,
      sender: owner,
      type: "text",
      content: "  大家好  ",
    });
    await store.flush();
    expect(writes(timeline)).toEqual(["insert:group_messages"]);
    expect(parametersOf(timeline, "insert:group_messages")).toEqual([
      message.messageId,
      group.groupId,
      "1234567890",
      "text",
      "大家好",
      null,
      expect.any(Date),
      null,
      null,
    ]);

    timeline.length = 0;
    store.recall(group.groupId, owner.userId, message.messageId);
    await store.flush();
    const recallParams = parametersOf(timeline, "insert:group_messages");
    expect(recallParams[4]).toBe("大家好");
    expect(recallParams[7]).toEqual(expect.any(Date));
    expect(recallParams[8]).toBe("1234567890");
  });

  it("persists group notice and all-mute switches", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const group = store.createGroup(owner, "测试群");
    await store.flush();
    timeline.length = 0;

    store.updateNotice(group.groupId, owner.userId, " 今晚八点开局 ");
    store.setAllMuted(group.groupId, owner.userId, true);
    await store.flush();

    expect(writes(timeline)).toEqual(["insert:chat_groups", "insert:chat_groups"]);
    expect(parametersOf(timeline, "insert:chat_groups", 1).slice(4, 6)).toEqual(["今晚八点开局", true]);
  });

  it("rolls back and reports the failure when a membership write fails", async () => {
    const { database, timeline } = fakeDatabase({ failOn: "INSERT INTO group_members" });
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");

    store.createGroup(owner, "测试群");
    await expect(store.flush()).rejects.toThrow("database offline");
    expect(writes(timeline)).toEqual(["BEGIN", "insert:chat_groups", "insert:group_members", "ROLLBACK"]);
  });

  it("shares one queue with the other repositories", async () => {
    const { database, timeline } = fakeDatabase();
    const queue = new PostgresWriteQueue(database);
    const store = await PostgresGroupStore.load(database, queue, generators());

    store.createGroup(account("1234567890", "甲"), "测试群");
    await store.flush();

    expect(writes(timeline)).toEqual(["BEGIN", "insert:chat_groups", "insert:group_members", "COMMIT"]);
  });

  it("writes an invited member", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const group = store.createGroup(owner, "测试群");
    await store.flush();
    timeline.length = 0;

    store.inviteMember({
      groupId: group.groupId,
      actorId: owner.userId,
      invitee: account("1234567891", "乙"),
      friendIds: new Set(["1234567891"]),
    });
    await store.flush();

    expect(writes(timeline)).toEqual(["insert:group_members"]);
    expect(parametersOf(timeline, "insert:group_members")).toEqual([
      group.groupId,
      "1234567891",
      "member",
      null,
      expect.any(Date),
    ]);
  });

  it("hands ownership over in the database when the owner leaves", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const member = account("1234567891", "乙");
    const group = store.createGroup(owner, "测试群");
    store.inviteMember({
      groupId: group.groupId,
      actorId: owner.userId,
      invitee: member,
      friendIds: new Set([member.userId]),
    });
    await store.flush();
    timeline.length = 0;

    const remaining = store.leaveGroup(group.groupId, owner.userId);
    await store.flush();

    expect(remaining?.ownerId).toBe(member.userId);
    expect(writes(timeline)).toEqual([
      "BEGIN",
      "delete:group_members",
      "insert:chat_groups",
      "insert:group_members",
      "COMMIT",
    ]);
    expect(parametersOf(timeline, "insert:chat_groups")[3]).toBe(member.userId);
    expect(parametersOf(timeline, "insert:group_members")).toEqual([
      group.groupId,
      member.userId,
      "owner",
      null,
      expect.any(Date),
    ]);
  });

  it("dissolves a group by stamping dissolved_at instead of deleting its rows", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const group = store.createGroup(owner, "测试群");
    await store.flush();
    timeline.length = 0;

    store.dissolveGroup(group.groupId, owner.userId);
    await store.flush();

    // 软删除：只写回一行群记录（带 dissolved_at），成员与消息一概不动。
    expect(writes(timeline)).toEqual(["insert:chat_groups"]);
    expect(parametersOf(timeline, "insert:chat_groups")[7]).toBeInstanceOf(Date);
  });

  it("stamps dissolved_at when the last member walks out", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresGroupStore.load(database, undefined, generators());
    const owner = account("1234567890", "甲");
    const group = store.createGroup(owner, "测试群");
    await store.flush();
    timeline.length = 0;

    expect(store.leaveGroup(group.groupId, owner.userId)).toBeUndefined();
    await store.flush();

    expect(writes(timeline)).toEqual(["insert:chat_groups"]);
    expect(parametersOf(timeline, "insert:chat_groups")[7]).toBeInstanceOf(Date);
  });

  it("loads dissolved_at back so a restart does not resurrect a dissolved group", async () => {
    const dissolvedAt = new Date("2026-09-15T02:00:00.000Z");
    const { database } = fakeDatabase({
      groups: [{
        group_id: "group-1",
        group_no: "12345678",
        name: "散了的群",
        owner_id: "1234567890",
        notice: "",
        all_muted: false,
        created_at: new Date("2026-09-15T00:00:00.000Z"),
        dissolved_at: dissolvedAt,
      }],
      members: [{
        group_id: "group-1",
        user_id: "1234567890",
        role: "owner",
        muted_until: null,
        joined_at: new Date("2026-09-15T00:00:00.000Z"),
      }],
    });

    const store = await PostgresGroupStore.load(database, undefined, generators());
    const group = store.groups.get("group-1")!;

    expect(group.dissolvedAt).toEqual(dissolvedAt);
    // 重启后照样进不了列表 —— 这条断言正是「软删除不能漏成复活」的防线。
    expect(store.listFor("1234567890")).toEqual([]);
  });
});
