import { randomInt, randomUUID } from "node:crypto";
import {
  GroupService,
  type ChatGroup,
  type GroupMember,
  type GroupMessageType,
  type GroupRole,
  type InviteMemberInput,
  type StoredGroupMessage,
  type UserAccount,
} from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresWriteQueue, type SqlStatement } from "./postgres-write-queue.js";

interface GroupRow {
  group_id: string;
  group_no: string;
  name: string;
  owner_id: string;
  notice: string;
  all_muted: boolean;
  created_at: Date;
  dissolved_at: Date | null;
}

interface MemberRow {
  group_id: string;
  user_id: string;
  role: GroupRole;
  muted_until: Date | null;
  joined_at: Date;
}

interface MessageRow {
  message_id: string;
  group_id: string;
  sender_id: string;
  message_type: GroupMessageType;
  content: string;
  voice_seconds: number | null;
  sent_at: Date;
  recalled_at: Date | null;
  recalled_by: string | null;
}

export interface GroupIdGenerators {
  createGroupId: () => string;
  createGroupNo: () => string;
  createMessageId: () => string;
}

const UPSERT_GROUP_SQL = `INSERT INTO chat_groups (
    group_id, group_no, name, owner_id, notice, all_muted, created_at, dissolved_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (group_id) DO UPDATE SET
    name = EXCLUDED.name, owner_id = EXCLUDED.owner_id,
    notice = EXCLUDED.notice, all_muted = EXCLUDED.all_muted,
    dissolved_at = EXCLUDED.dissolved_at`;

const UPSERT_MEMBER_SQL = `INSERT INTO group_members (
    group_id, user_id, role, muted_until, joined_at
  ) VALUES ($1,$2,$3,$4,$5)
  ON CONFLICT (group_id, user_id) DO UPDATE SET
    role = EXCLUDED.role, muted_until = EXCLUDED.muted_until`;

const DELETE_MEMBER_SQL = `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`;

// 解散是软删除：群、成员与消息都留在库里，只把 dissolved_at 打上时间戳，
// 历史消息因此仍可被原成员读回。没有任何一条「解散」路径会再删行。

// Only the recall fields are mutable; content and sender are immutable once stored.
const UPSERT_MESSAGE_SQL = `INSERT INTO group_messages (
    message_id, group_id, sender_id, message_type, content, voice_seconds,
    sent_at, recalled_at, recalled_by
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (message_id) DO UPDATE SET
    recalled_at = EXCLUDED.recalled_at, recalled_by = EXCLUDED.recalled_by`;

const DEFAULT_GENERATORS: GroupIdGenerators = {
  createGroupId: randomUUID,
  createGroupNo: () => String(randomInt(10_000_000, 100_000_000)),
  createMessageId: randomUUID,
};

/**
 * Chat groups, members and messages backed by PostgreSQL.
 *
 * The in-memory maps stay authoritative for the domain rules; every mutation also queues a durable
 * write on the shared write queue. Group settings and the membership row they affect are written in
 * one transaction, so a group can never claim a role it does not have in `group_members`.
 *
 * Every message ever sent is loaded back at startup to keep behaviour identical to the in-memory
 * service. Bounding that load is tracked as follow-up work.
 */
export class PostgresGroupStore extends GroupService {
  private constructor(private readonly queue: PostgresWriteQueue, generators: GroupIdGenerators) {
    super(generators.createGroupId, generators.createGroupNo, generators.createMessageId);
  }

  /** Loads persisted groups, members and messages. Pass the queue shared with the other repositories. */
  static async load(
    database: PostgresDatabase,
    queue: PostgresWriteQueue = new PostgresWriteQueue(database),
    generators: GroupIdGenerators = DEFAULT_GENERATORS,
  ): Promise<PostgresGroupStore> {
    const store = new PostgresGroupStore(queue, generators);
    const [groups, members, messages] = await Promise.all([
      database.pool.query<GroupRow>("SELECT * FROM chat_groups ORDER BY created_at ASC, group_id ASC"),
      database.pool.query<MemberRow>("SELECT * FROM group_members ORDER BY joined_at ASC, user_id ASC"),
      database.pool.query<MessageRow>("SELECT * FROM group_messages ORDER BY sent_at ASC, message_id ASC"),
    ]);

    for (const row of groups.rows) {
      store.groups.set(row.group_id, {
        groupId: row.group_id,
        groupNo: row.group_no.trim(),
        name: row.name,
        ownerId: row.owner_id.trim(),
        notice: row.notice,
        allMuted: row.all_muted,
        members: new Map<string, GroupMember>(),
        messages: [],
        createdAt: row.created_at,
        ...(row.dissolved_at ? { dissolvedAt: row.dissolved_at } : {}),
      });
    }
    for (const row of members.rows) {
      const group = store.groups.get(row.group_id);
      if (!group) throw new Error(`group_members references unknown group ${row.group_id}`);
      const userId = row.user_id.trim();
      group.members.set(userId, {
        userId,
        role: row.role,
        joinedAt: row.joined_at,
        ...(row.muted_until ? { mutedUntil: row.muted_until } : {}),
      });
    }
    for (const row of messages.rows) {
      const group = store.groups.get(row.group_id);
      if (!group) throw new Error(`group_messages references unknown group ${row.group_id}`);
      group.messages.push({
        messageId: row.message_id,
        groupId: row.group_id,
        senderId: row.sender_id.trim(),
        sentAt: row.sent_at,
        type: row.message_type,
        content: row.content,
        ...(row.voice_seconds === null ? {} : { voiceSeconds: row.voice_seconds }),
        ...(row.recalled_at ? { recalledAt: row.recalled_at } : {}),
        ...(row.recalled_by ? { recalledBy: row.recalled_by } : {}),
      });
    }
    return store;
  }

  override createGroup(owner: UserAccount, name: string): ChatGroup {
    const group = super.createGroup(owner, name);
    this.queue.enqueueTransaction([
      { sql: UPSERT_GROUP_SQL, parameters: groupParameters(group) },
      { sql: UPSERT_MEMBER_SQL, parameters: memberParameters(group.groupId, memberOf(group, owner.userId)) },
    ]);
    return group;
  }

  override joinByGroupNo(account: UserAccount, groupNo: string): ChatGroup {
    const group = super.joinByGroupNo(account, groupNo);
    // Idempotent upsert: joining twice is a no-op in the domain and a no-op in the database.
    this.queue.enqueue(UPSERT_MEMBER_SQL, memberParameters(group.groupId, memberOf(group, account.userId)));
    return group;
  }

  override setAdministrator(groupId: string, actorId: string, memberId: string, enabled: boolean): void {
    super.setAdministrator(groupId, actorId, memberId, enabled);
    this.saveMember(groupId, memberId);
  }

  override inviteMember(input: InviteMemberInput): GroupMember {
    const member = super.inviteMember(input);
    this.queue.enqueue(UPSERT_MEMBER_SQL, memberParameters(input.groupId, member));
    return member;
  }

  override leaveGroup(groupId: string, userId: string): ChatGroup | undefined {
    const group = super.leaveGroup(groupId, userId);
    if (!group) {
      // 最后一人退群 → 群软解散，写时间戳而不是删行。
      this.saveGroup(groupId);
      return undefined;
    }
    const statements: SqlStatement[] = [
      { sql: DELETE_MEMBER_SQL, parameters: [groupId, userId] },
      { sql: UPSERT_GROUP_SQL, parameters: groupParameters(group) },
    ];
    // 群主退出会把身份交给别人，那条成员行的角色也要跟着写回去。
    if (group.ownerId !== userId) {
      statements.push({ sql: UPSERT_MEMBER_SQL, parameters: memberParameters(groupId, memberOf(group, group.ownerId)) });
    }
    this.queue.enqueueTransaction(statements);
    return group;
  }

  override dissolveGroup(groupId: string, actorId: string): void {
    super.dissolveGroup(groupId, actorId);
    this.saveGroup(groupId);
  }

  override transferOwnership(groupId: string, actorId: string, memberId: string): void {
    super.transferOwnership(groupId, actorId, memberId);
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`GROUP_NOT_FOUND: ${groupId}`);
    this.queue.enqueueTransaction([
      { sql: UPSERT_GROUP_SQL, parameters: groupParameters(group) },
      { sql: UPSERT_MEMBER_SQL, parameters: memberParameters(groupId, memberOf(group, actorId)) },
      { sql: UPSERT_MEMBER_SQL, parameters: memberParameters(groupId, memberOf(group, memberId)) },
    ]);
  }

  override setAllMuted(groupId: string, actorId: string, enabled: boolean): void {
    super.setAllMuted(groupId, actorId, enabled);
    this.saveGroup(groupId);
  }

  override muteMember(groupId: string, actorId: string, memberId: string, until: Date): void {
    super.muteMember(groupId, actorId, memberId, until);
    this.saveMember(groupId, memberId);
  }

  override removeMember(groupId: string, actorId: string, memberId: string): void {
    super.removeMember(groupId, actorId, memberId);
    this.queue.enqueue(DELETE_MEMBER_SQL, [groupId, memberId]);
  }

  override updateNotice(groupId: string, actorId: string, notice: string): void {
    super.updateNotice(groupId, actorId, notice);
    this.saveGroup(groupId);
  }

  override sendMessage(input: {
    groupId: string;
    sender: UserAccount;
    type: Exclude<GroupMessageType, "system">;
    content: string;
    voiceSeconds?: number;
  }): StoredGroupMessage {
    const message = super.sendMessage(input);
    this.queue.enqueue(UPSERT_MESSAGE_SQL, messageParameters(message));
    return message;
  }

  override recall(groupId: string, actorId: string, messageId: string, userRecallEnabled = true): StoredGroupMessage {
    const message = super.recall(groupId, actorId, messageId, userRecallEnabled);
    this.queue.enqueue(UPSERT_MESSAGE_SQL, messageParameters(message));
    return message;
  }

  /**
   * Waits for every queued write. All repositories share one queue, so flushing any of them
   * drains the others too.
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }

  private saveGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`GROUP_NOT_FOUND: ${groupId}`);
    this.queue.enqueue(UPSERT_GROUP_SQL, groupParameters(group));
  }

  private saveMember(groupId: string, memberId: string): void {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`GROUP_NOT_FOUND: ${groupId}`);
    this.queue.enqueue(UPSERT_MEMBER_SQL, memberParameters(groupId, memberOf(group, memberId)));
  }
}

function groupParameters(group: ChatGroup): readonly unknown[] {
  return [
    group.groupId,
    group.groupNo,
    group.name,
    group.ownerId,
    group.notice,
    group.allMuted,
    group.createdAt,
    group.dissolvedAt ?? null,
  ];
}

function memberParameters(groupId: string, member: GroupMember): readonly unknown[] {
  return [groupId, member.userId, member.role, member.mutedUntil ?? null, member.joinedAt];
}

function messageParameters(message: StoredGroupMessage): readonly unknown[] {
  return [
    message.messageId,
    message.groupId,
    message.senderId,
    message.type,
    message.content,
    message.voiceSeconds ?? null,
    message.sentAt,
    message.recalledAt ?? null,
    message.recalledBy ?? null,
  ];
}

/** Fails loudly rather than silently skipping a write when a member vanished unexpectedly. */
function memberOf(group: ChatGroup, userId: string): GroupMember {
  const member = group.members.get(userId);
  if (!member) throw new Error(`Member ${userId} is missing from group ${group.groupId}`);
  return member;
}
