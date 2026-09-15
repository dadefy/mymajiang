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
    const group = [...this.groups.values()].find((candidate) => candidate.groupNo === groupNo);
    if (!group) throw new Error("Group not found");
    if (group.members.has(account.userId)) return group;
    if (group.members.size >= GROUP_LIMITS.maximumMembers) throw new Error("Group is full");
    group.members.set(account.userId, { userId: account.userId, role: "member", joinedAt: this.now() });
    return group;
  }

  /** 我加入的群，最近有消息的排前面；没有消息的按建群时间。 */
  listFor(userId: string): ChatGroup[] {
    return [...this.groups.values()]
      .filter((group) => group.members.has(userId))
      .sort((left, right) => {
        const difference = lastActivityAt(right) - lastActivityAt(left);
        return difference !== 0 ? difference : right.createdAt.getTime() - left.createdAt.getTime();
      });
  }

  /**
   * 主动退群。
   *
   * 群主退出时把群主交给最早加入的剩余成员；最后一人退出时群直接解散，返回 `undefined`。
   */
  leaveGroup(groupId: string, userId: string): ChatGroup | undefined {
    const group = this.requireGroup(groupId);
    this.requireMember(group, userId);
    group.members.delete(userId);
    if (group.members.size === 0) {
      this.groups.delete(group.groupId);
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

  /** 解散群。只有群主可以，成员与消息随群一起消失。 */
  dissolveGroup(groupId: string, actorId: string): void {
    const group = this.requireGroup(groupId);
    if (actorId !== group.ownerId) throw new Error("Only the group owner can dissolve a group");
    this.groups.delete(group.groupId);
  }

  /**
   * 邀请好友入群。
   *
   * 已有成员会被原样返回（重复邀请不算失败）；超出人数上限、不是好友、被邀请人已封号都会被拒绝。
   */
  inviteMember(input: InviteMemberInput): GroupMember {
    this.assertActive(input.invitee);
    const group = this.requireGroup(input.groupId);
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
    const group = this.requireGroup(groupId);
    if (actorId !== group.ownerId) throw new Error("Only the group owner can manage administrators");
    if (memberId === group.ownerId) throw new Error("Owner role cannot be changed");
    const member = this.requireMember(group, memberId);
    member.role = enabled ? "admin" : "member";
  }

  transferOwnership(groupId: string, actorId: string, memberId: string): void {
    const group = this.requireGroup(groupId);
    if (actorId !== group.ownerId) throw new Error("Only the group owner can transfer ownership");
    const nextOwner = this.requireMember(group, memberId);
    const currentOwner = this.requireMember(group, actorId);
    currentOwner.role = "member";
    nextOwner.role = "owner";
    group.ownerId = memberId;
  }

  setAllMuted(groupId: string, actorId: string, enabled: boolean): void {
    const group = this.requireGroup(groupId);
    this.assertManager(group, actorId);
    group.allMuted = enabled;
  }

  muteMember(groupId: string, actorId: string, memberId: string, until: Date): void {
    const group = this.requireGroup(groupId);
    this.assertManager(group, actorId);
    const target = this.requireMember(group, memberId);
    if (target.role === "owner") throw new Error("Group owner cannot be muted");
    target.mutedUntil = until;
  }

  removeMember(groupId: string, actorId: string, memberId: string): void {
    const group = this.requireGroup(groupId);
    this.assertManager(group, actorId);
    const actor = this.requireMember(group, actorId);
    const target = this.requireMember(group, memberId);
    if (target.role === "owner") throw new Error("Group owner cannot be removed");
    if (actor.role === "admin" && target.role === "admin") throw new Error("Administrator cannot remove another administrator");
    group.members.delete(memberId);
  }

  updateNotice(groupId: string, actorId: string, notice: string): void {
    const group = this.requireGroup(groupId);
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
    const group = this.requireGroup(input.groupId);
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
    return message;
  }

  recall(groupId: string, actorId: string, messageId: string, userRecallEnabled = true): StoredGroupMessage {
    const group = this.requireGroup(groupId);
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

  private assertActive(account: UserAccount): void {
    if (account.status !== "active") throw new Error("Only active accounts can use groups");
  }

  private requireGroup(groupId: string): ChatGroup {
    const group = this.groups.get(groupId);
    if (!group) throw new Error("Group not found");
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

/** 群列表排序依据：最后一条消息的时间；还没有消息就用建群时间。 */
function lastActivityAt(group: ChatGroup): number {
  return group.messages.at(-1)?.sentAt.getTime() ?? group.createdAt.getTime();
}

