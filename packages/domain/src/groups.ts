import type { UserAccount } from "./accounts.js";
import { DEFAULT_RECALL_POLICY, canRecallMessage, recallMessage, type GroupMessage, type GroupRole } from "./chat.js";

export const GROUP_LIMITS = {
  maximumMembers: 200,
  maximumOwnedGroups: 10,
  messageRetentionDays: 180,
  maximumVoiceSeconds: 60,
} as const;

export type GroupMessageType = "text" | "image" | "voice" | "emoji" | "room_invite" | "system";

export interface GroupMember {
  userId: string;
  role: GroupRole;
  joinedAt: Date;
  mutedUntil?: Date;
}

export interface StoredGroupMessage extends GroupMessage {
  type: GroupMessageType;
  content: string;
  voiceSeconds?: number;
}

export interface ChatGroup {
  groupId: string;
  groupNo: string;
  name: string;
  ownerId: string;
  notice: string;
  allMuted: boolean;
  members: Map<string, GroupMember>;
  messages: StoredGroupMessage[];
  createdAt: Date;
  /**
   * 解散时间；`undefined` 表示群还在。
   *
   * 解散是软删除：群、成员与消息都留在原处，只是从这一刻起不再出现在群列表里，
   * 也不能再进人、发言或做任何管理操作。保留成员行的意义在于历史消息仍可被原成员读到。
   */
  dissolvedAt?: Date;
  /**
   * 群内最后一条消息的发送时间，用于群列表排序。
   *
   * 与 `messages` 分开存：PostgreSQL 版不在启动时把全部消息载入内存，
   * 所以不能用 `messages.at(-1)` 推断；这里单独记录，量级是「每群一个时间戳」。
   */
  lastMessageAt?: Date;
}

export interface InviteMemberInput {
  groupId: string;
  actorId: string;
  invitee: UserAccount;
  /**
   * 邀请人的好友集合。
   *
   * 好友关系属于另一个聚合，所以由调用方把集合传进来；「只能邀请好友」这条判断仍然留在这里，
   * 这样规则本身可以被单独测试。
   */
  friendIds: ReadonlySet<string>;
}

/** 群消息翻页的默认与上限；与 `/v1/matches` 的游标分页保持一致的分页尺寸约定。 */
export const DEFAULT_MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE_SIZE = 200;

/**
 * 群消息翻页的不透明游标。编码了排序键（`sentAt` + `messageId`），
 * 这样「下一页」不受中间插入/删除影响，也不会重复或漏掉。
 */
export interface MessageCursor {
  /** ISO 8601 字符串，即消息的 `sentAt`。 */
  sentAt: string;
  messageId: string;
}

const MESSAGE_CURSOR_MARKER = "g1:";

export function encodeMessageCursor(cursor: MessageCursor): string {
  return MESSAGE_CURSOR_MARKER + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMessageCursor(value: string): MessageCursor {
  if (typeof value !== "string" || !value.startsWith(MESSAGE_CURSOR_MARKER)) throw new Error("INVALID_CURSOR");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(MESSAGE_CURSOR_MARKER.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof (parsed as { sentAt?: unknown }).sentAt !== "string" ||
    typeof (parsed as { messageId?: unknown }).messageId !== "string"
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return parsed as MessageCursor;
}

export interface GetMessagesOptions {
  limit?: number;
  /** 上一页返回的 `nextCursor`；提供时返回比它更旧的消息。 */
  before?: string;
}

export interface MessagePage {
  messages: StoredGroupMessage[];
  /** 翻到更旧一页的游标；已是最后一页时为 `undefined`。 */
  nextCursor?: string;
}

export class GroupService {
  readonly groups = new Map<string, ChatGroup>();

  constructor(
    private readonly createGroupId: () => string,
    private readonly createGroupNo: () => string,
    private readonly createMessageId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createGroup(owner: UserAccount, name: string): ChatGroup {
    this.assertActive(owner);
    const ownedCount = [...this.groups.values()].filter((group) => group.ownerId === owner.userId).length;
    if (ownedCount >= GROUP_LIMITS.maximumOwnedGroups) throw new Error("Owned group limit reached");

    let groupNo = this.createGroupNo();
    while ([...this.groups.values()].some((group) => group.groupNo === groupNo)) groupNo = this.createGroupNo();
    if (!/^\d{8}$/.test(groupNo)) throw new Error("Group number must contain exactly 8 digits");
    const createdAt = this.now();
    const group: ChatGroup = {
      groupId: this.createGroupId(),
      groupNo,
      name: name.trim() || `${owner.nickname}的群聊`,
      ownerId: owner.userId,
      notice: "",
      allMuted: false,
      members: new Map([[owner.userId, { userId: owner.userId, role: "owner", joinedAt: createdAt }]]),
      messages: [],
      createdAt,
    };
    this.groups.set(group.groupId, group);
    return group;
  }

  joinByGroupNo(account: UserAccount, groupNo: string): ChatGroup {
    this.assertActive(account);
    // 已解散的群查号进不去：对外它就是不存在的。
    const group = [...this.groups.values()].find((candidate) => candidate.groupNo === groupNo && !isDissolved(candidate));
    if (!group) throw new Error("Group not found");
    if (group.members.has(account.userId)) return group;
    if (group.members.size >= GROUP_LIMITS.maximumMembers) throw new Error("Group is full");
    group.members.set(account.userId, { userId: account.userId, role: "member", joinedAt: this.now() });
    return group;
  }

  /** 我加入的群，最近有消息的排前面；没有消息的按建群时间。已解散的群不在其中。 */
  listFor(userId: string): ChatGroup[] {
    return [...this.groups.values()]
      .filter((group) => !isDissolved(group) && group.members.has(userId))
      .sort((left, right) => {
        const difference = lastActivityAt(right) - lastActivityAt(left);
        return difference !== 0 ? difference : right.createdAt.getTime() - left.createdAt.getTime();
      });
  }

  /**
   * 主动退群。
   *
   * 群主退出时把群主交给最早加入的剩余成员；最后一人退出时群解散，返回 `undefined`。
   */
  leaveGroup(groupId: string, userId: string): ChatGroup | undefined {
    const group = this.requireLiveGroup(groupId);
    this.requireMember(group, userId);
    group.members.delete(userId);
    if (group.members.size === 0) {
      // 空群没有存在的意义，但同样是软删除：留个时间戳，消息仍可追溯到。
      group.dissolvedAt = this.now();
      return undefined;
    }
    if (group.ownerId === userId) {
      const nextOwner = [...group.members.values()]
        .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime())[0]!;
      nextOwner.role = "owner";
      group.ownerId = nextOwner.userId;
    }
    return group;
  }

  /**
   * 解散群。只有群主可以。
   *
   * 软删除：不删任何行，只记下解散时间。群从此不出现在任何人的群列表里，
   * 也不能再进人、发言或做管理操作；但原来的成员仍能读回历史消息。
   */
  dissolveGroup(groupId: string, actorId: string): void {
    const group = this.requireLiveGroup(groupId);
    if (actorId !== group.ownerId) throw new Error("Only the group owner can dissolve a group");
    group.dissolvedAt = this.now();
  }

  /**
   * 邀请好友入群。
   *
   * 已有成员会被原样返回（重复邀请不算失败）；超出人数上限、不是好友、被邀请人已封号都会被拒绝。
   */
  inviteMember(input: InviteMemberInput): GroupMember {
    this.assertActive(input.invitee);
    const group = this.requireLiveGroup(input.groupId);
    this.requireMember(group, input.actorId);
    if (!input.friendIds.has(input.invitee.userId)) throw new Error("Only friends can be invited");
    const existing = group.members.get(input.invitee.userId);
    if (existing) return existing;
    if (group.members.size >= GROUP_LIMITS.maximumMembers) throw new Error("Group is full");
    const member: GroupMember = { userId: input.invitee.userId, role: "member", joinedAt: this.now() };
    group.members.set(member.userId, member);
    return member;
  }

  setAdministrator(groupId: string, actorId: string, memberId: string, enabled: boolean): void {
    const group = this.requireLiveGroup(groupId);
    if (actorId !== group.ownerId) throw new Error("Only the group owner can manage administrators");
    if (memberId === group.ownerId) throw new Error("Owner role cannot be changed");
    const member = this.requireMember(group, memberId);
    member.role = enabled ? "admin" : "member";
  }

  transferOwnership(groupId: string, actorId: string, memberId: string): void {
    const group = this.requireLiveGroup(groupId);
    if (actorId !== group.ownerId) throw new Error("Only the group owner can transfer ownership");
    const nextOwner = this.requireMember(group, memberId);
    const currentOwner = this.requireMember(group, actorId);
    currentOwner.role = "member";
    nextOwner.role = "owner";
    group.ownerId = memberId;
  }

  setAllMuted(groupId: string, actorId: string, enabled: boolean): void {
    const group = this.requireLiveGroup(groupId);
    this.assertManager(group, actorId);
    group.allMuted = enabled;
  }

  muteMember(groupId: string, actorId: string, memberId: string, until: Date): void {
    const group = this.requireLiveGroup(groupId);
    this.assertManager(group, actorId);
    const target = this.requireMember(group, memberId);
    if (target.role === "owner") throw new Error("Group owner cannot be muted");
    target.mutedUntil = until;
  }

  removeMember(groupId: string, actorId: string, memberId: string): void {
    const group = this.requireLiveGroup(groupId);
    this.assertManager(group, actorId);
    const actor = this.requireMember(group, actorId);
    const target = this.requireMember(group, memberId);
    if (target.role === "owner") throw new Error("Group owner cannot be removed");
    if (actor.role === "admin" && target.role === "admin") throw new Error("Administrator cannot remove another administrator");
    group.members.delete(memberId);
  }

  updateNotice(groupId: string, actorId: string, notice: string): void {
    const group = this.requireLiveGroup(groupId);
    this.assertManager(group, actorId);
    group.notice = notice.trim();
  }

  sendMessage(input: {
    groupId: string;
    sender: UserAccount;
    type: Exclude<GroupMessageType, "system">;
    content: string;
    voiceSeconds?: number;
  }): StoredGroupMessage {
    this.assertActive(input.sender);
    const group = this.requireLiveGroup(input.groupId);
    const member = this.requireMember(group, input.sender.userId);
    const now = this.now();
    const isManager = member.role === "owner" || member.role === "admin";
    if (group.allMuted && !isManager) throw new Error("Group is muted");
    if (member.mutedUntil && member.mutedUntil.getTime() > now.getTime()) throw new Error("Member is muted");
    if (!input.content.trim()) throw new Error("Message content is required");
    if (input.type === "voice") {
      if (!Number.isInteger(input.voiceSeconds) || input.voiceSeconds! < 1 || input.voiceSeconds! > GROUP_LIMITS.maximumVoiceSeconds) {
        throw new Error("Voice message must be between 1 and 60 seconds");
      }
    }

    const message: StoredGroupMessage = {
      messageId: this.createMessageId(),
      groupId: group.groupId,
      senderId: input.sender.userId,
      sentAt: now,
      type: input.type,
      content: input.content.trim(),
      ...(input.voiceSeconds === undefined ? {} : { voiceSeconds: input.voiceSeconds }),
    };
    group.messages.push(message);
    group.lastMessageAt = message.sentAt;
    return message;
  }

  /**
   * 撤回一条消息。同步实现（内存版）直接在本进程的消息数组里定位；
   * PostgreSQL 版会按需从数据库取回不在内存的旧消息，因此整个方法定为 `async`。
   */
  async recall(groupId: string, actorId: string, messageId: string, userRecallEnabled = true): Promise<StoredGroupMessage> {
    const group = this.requireLiveGroup(groupId);
    const member = this.requireMember(group, actorId);
    const message = group.messages.find((candidate) => candidate.messageId === messageId);
    if (!message) throw new Error("Message not found");
    const now = this.now();
    if (!canRecallMessage({
      actorId,
      actorRole: member.role,
      message,
      now,
      policy: { ...DEFAULT_RECALL_POLICY, userRecallEnabled },
    })) {
      throw new Error("Message cannot be recalled");
    }
    const recalled = recallMessage(message, actorId, now) as StoredGroupMessage;
    Object.assign(message, recalled);
    return message;
  }

  /**
   * 拉取群消息（用于历史翻页）。内存版直接对 `messages` 数组做游标分页；
   * PostgreSQL 版由子类覆盖为键集分页查询。
   */
  async getMessages(groupId: string, options: GetMessagesOptions = {}): Promise<MessagePage> {
    const group = this.requireGroup(groupId);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE, 1), MAX_MESSAGE_PAGE_SIZE);
    const sorted = [...group.messages].sort(messageByNewest);
    let start = 0;
    if (options.before) {
      const cursor = decodeMessageCursor(options.before);
      const index = sorted.findIndex((message) => message.messageId === cursor.messageId);
      // 游标消息已被裁剪出内存时，从最旧处继续往前翻，避免卡住。
      start = index >= 0 ? index + 1 : sorted.length;
    }
    const page = sorted.slice(start, start + limit);
    const hasMore = start + limit < sorted.length;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? encodeMessageCursor({ sentAt: last.sentAt.toISOString(), messageId: last.messageId })
      : undefined;
    // tsconfig 开了 exactOptionalPropertyTypes，可选属性不能显式传 undefined。
    return nextCursor === undefined ? { messages: page } : { messages: page, nextCursor };
  }

  private assertActive(account: UserAccount): void {
    if (account.status !== "active") throw new Error("Only active accounts can use groups");
  }

  private requireGroup(groupId: string): ChatGroup {
    const group = this.groups.get(groupId);
    if (!group) throw new Error("Group not found");
    return group;
  }

  /**
   * 取一个「还在」的群，供所有写操作使用。
   *
   * 已解散的群仍然留在 `groups` 里（为了保留历史），所以每个写入口都必须显式挡住它，
   * 否则解散之后还能继续发言、改公告、拉人 —— 软删除就会漏成「解散了但还能用」。
   */
  private requireLiveGroup(groupId: string): ChatGroup {
    const group = this.requireGroup(groupId);
    if (isDissolved(group)) throw new Error("Group has been dissolved");
    return group;
  }

  private requireMember(group: ChatGroup, userId: string): GroupMember {
    const member = group.members.get(userId);
    if (!member) throw new Error("User is not a group member");
    return member;
  }

  private assertManager(group: ChatGroup, userId: string): void {
    const role = this.requireMember(group, userId).role;
    if (role !== "owner" && role !== "admin") throw new Error("Group manager permission is required");
  }
}

/** 群是否已解散。软删除之后群记录还在，所以这个判断必须由调用方显式做。 */
export function isDissolved(group: ChatGroup): boolean {
  return group.dissolvedAt !== undefined;
}

/** 群列表排序依据：最后一条消息的时间（单独记录的 `lastMessageAt`）；还没有消息就用建群时间。 */
function lastActivityAt(group: ChatGroup): number {
  return (group.lastMessageAt ?? group.createdAt).getTime();
}

/** 群消息按「最新在前」排序：`sentAt` 倒序，`sentAt` 相同时用 `messageId` 兜底。 */
function messageByNewest(left: StoredGroupMessage, right: StoredGroupMessage): number {
  const byTime = right.sentAt.getTime() - left.sentAt.getTime();
  if (byTime !== 0) return byTime;
  if (right.messageId < left.messageId) return -1;
  if (right.messageId > left.messageId) return 1;
  return 0;
}

