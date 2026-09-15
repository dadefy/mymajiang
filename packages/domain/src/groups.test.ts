import { describe, expect, it } from "vitest";
import { GroupService, isDissolved, type UserAccount } from "./index.js";

function account(userId: string, status: UserAccount["status"] = "active"): UserAccount {
  return {
    userId,
    nickname: userId,
    avatarUrl: `avatar-${userId}`,
    status,
    points: 0,
    createdAt: new Date(),
  };
}

function serviceAt(times: string[]): GroupService {
  let groupSequence = 0;
  let messageSequence = 0;
  let timeIndex = 0;
  return new GroupService(
    () => `group-${++groupSequence}`,
    () => String(10000000 + groupSequence),
    () => `message-${++messageSequence}`,
    () => new Date(times[Math.min(timeIndex++, times.length - 1)]!),
  );
}

describe("group chat", () => {
  it("allows only active users to create and join private-number groups", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z"]);
    const group = service.createGroup(account("owner"), "牌友群");
    expect(group.groupNo).toMatch(/^\d{8}$/);
    service.joinByGroupNo(account("member"), group.groupNo);
    expect(group.members.size).toBe(2);
    expect(() => service.joinByGroupNo(account("banned", "permanently_banned"), group.groupNo))
      .toThrow("Only active accounts");
  });

  it("supports owner-managed administrators and ownership transfer", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z"]);
    const group = service.createGroup(account("owner"), "群");
    service.joinByGroupNo(account("member"), group.groupNo);
    service.setAdministrator(group.groupId, "owner", "member", true);
    expect(group.members.get("member")?.role).toBe("admin");
    service.transferOwnership(group.groupId, "owner", "member");
    expect(group.ownerId).toBe("member");
  });

  it("enforces all-member mute while allowing managers to speak", () => {
    const service = serviceAt([
      "2026-09-15T00:00:00.000Z",
      "2026-09-15T00:00:01.000Z",
      "2026-09-15T00:00:02.000Z",
    ]);
    const owner = account("owner");
    const member = account("member");
    const group = service.createGroup(owner, "群");
    service.joinByGroupNo(member, group.groupNo);
    service.setAllMuted(group.groupId, "owner", true);
    expect(() => service.sendMessage({ groupId: group.groupId, sender: member, type: "text", content: "你好" }))
      .toThrow("Group is muted");
    expect(service.sendMessage({ groupId: group.groupId, sender: owner, type: "text", content: "公告" }).content)
      .toBe("公告");
  });

  it("limits voice messages to sixty seconds", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z", "2026-09-15T00:00:01.000Z"]);
    const owner = account("owner");
    const group = service.createGroup(owner, "群");
    expect(() => service.sendMessage({
      groupId: group.groupId,
      sender: owner,
      type: "voice",
      content: "voice-key",
      voiceSeconds: 61,
    })).toThrow("between 1 and 60 seconds");
  });

  it("allows the sender to recall within two minutes", () => {
    const service = serviceAt([
      "2026-09-15T00:00:00.000Z",
      "2026-09-15T00:00:10.000Z",
      "2026-09-15T00:01:59.000Z",
    ]);
    const owner = account("owner");
    const group = service.createGroup(owner, "群");
    const message = service.sendMessage({ groupId: group.groupId, sender: owner, type: "text", content: "可撤回" });
    expect(service.recall(group.groupId, owner.userId, message.messageId).recalledAt).toBeDefined();
  });

  it("lists only my groups, most recently active first", () => {
    const service = serviceAt([
      "2026-09-15T00:00:00.000Z",
      "2026-09-15T00:00:01.000Z",
      "2026-09-15T00:00:02.000Z",
      "2026-09-15T00:00:03.000Z",
    ]);
    const owner = account("owner");
    const member = account("member");
    const first = service.createGroup(owner, "甲群");
    const second = service.createGroup(owner, "乙群");
    service.joinByGroupNo(member, second.groupNo);
    service.sendMessage({ groupId: second.groupId, sender: owner, type: "text", content: "刚说的" });

    // 乙群刚有消息，排在甲群前面。
    expect(service.listFor(owner.userId).map((group) => group.groupId)).toEqual([second.groupId, first.groupId]);
    expect(service.listFor(member.userId).map((group) => group.groupId)).toEqual([second.groupId]);
  });

  it("hands the group over when the owner leaves, and dissolves it when the last one leaves", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z", "2026-09-15T00:00:01.000Z"]);
    const owner = account("owner");
    const member = account("member");
    const group = service.createGroup(owner, "群");
    service.joinByGroupNo(member, group.groupNo);

    const afterLeave = service.leaveGroup(group.groupId, "owner");
    expect(afterLeave?.ownerId).toBe("member");
    expect(afterLeave?.members.get("member")?.role).toBe("owner");

    expect(service.leaveGroup(group.groupId, "member")).toBeUndefined();
    // 软删除：群记录还在，只是被标成已解散。
    expect(isDissolved(service.groups.get(group.groupId)!)).toBe(true);
    expect(service.listFor(owner.userId)).toEqual([]);
  });

  it("only the owner may dissolve a group", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z"]);
    const group = service.createGroup(account("owner"), "群");
    service.joinByGroupNo(account("member"), group.groupNo);

    expect(() => service.dissolveGroup(group.groupId, "member")).toThrow("Only the group owner");
    service.dissolveGroup(group.groupId, "owner");
    expect(isDissolved(service.groups.get(group.groupId)!)).toBe(true);
  });

  it("keeps a dissolved group's messages but refuses every further write", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z", "2026-09-15T00:00:01.000Z"]);
    const owner = account("owner");
    const member = account("member");
    const group = service.createGroup(owner, "群");
    service.joinByGroupNo(member, group.groupNo);
    service.sendMessage({ groupId: group.groupId, sender: owner, type: "text", content: "散伙前最后一句" });

    service.dissolveGroup(group.groupId, "owner");

    // 历史留得住 —— 这就是软删除的全部意义。
    expect(group.messages.map((message) => message.content)).toEqual(["散伙前最后一句"]);
    expect(group.members.size).toBe(2);

    // 但解散之后这个群对外就是死的：发言、改公告、拉人、管理、退群全部拒绝。
    expect(() => service.sendMessage({ groupId: group.groupId, sender: owner, type: "text", content: "还能说话吗" }))
      .toThrow("Group has been dissolved");
    expect(() => service.updateNotice(group.groupId, "owner", "新公告")).toThrow("Group has been dissolved");
    expect(() => service.setAllMuted(group.groupId, "owner", true)).toThrow("Group has been dissolved");
    expect(() => service.removeMember(group.groupId, "owner", "member")).toThrow("Group has been dissolved");
    expect(() => service.leaveGroup(group.groupId, "owner")).toThrow("Group has been dissolved");
    expect(() => service.inviteMember({
      groupId: group.groupId,
      actorId: "owner",
      invitee: account("friend"),
      friendIds: new Set(["friend"]),
    })).toThrow("Group has been dissolved");
    expect(() => service.recall(group.groupId, "owner", group.messages[0]!.messageId))
      .toThrow("Group has been dissolved");
  });

  it("cannot be rejoined by its number once dissolved, and dissolving twice is refused", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z"]);
    const owner = account("owner");
    const group = service.createGroup(owner, "群");
    const groupNo = group.groupNo;

    service.dissolveGroup(group.groupId, "owner");

    // 对外它就是不存在的：查号进不去，也进不了第二次。
    expect(() => service.joinByGroupNo(account("新人"), groupNo)).toThrow("Group not found");
    expect(() => service.dissolveGroup(group.groupId, "owner")).toThrow("Group has been dissolved");
  });

  it("allows inviting friends only, and treats a repeat invite as a no-op", () => {
    const service = serviceAt(["2026-09-15T00:00:00.000Z"]);
    const group = service.createGroup(account("owner"), "群");
    const friend = account("friend");
    const friends = new Set(["friend"]);

    expect(() => service.inviteMember({
      groupId: group.groupId,
      actorId: "owner",
      invitee: account("stranger"),
      friendIds: friends,
    })).toThrow("Only friends can be invited");

    expect(service.inviteMember({ groupId: group.groupId, actorId: "owner", invitee: friend, friendIds: friends }).role)
      .toBe("member");
    expect(service.inviteMember({ groupId: group.groupId, actorId: "owner", invitee: friend, friendIds: friends }).userId)
      .toBe("friend");
    expect(group.members.size).toBe(2);

    expect(() => service.inviteMember({
      groupId: group.groupId,
      actorId: "stranger",
      invitee: friend,
      friendIds: friends,
    })).toThrow("not a group member");
    expect(() => service.inviteMember({
      groupId: group.groupId,
      actorId: "owner",
      invitee: account("banned", "permanently_banned"),
      friendIds: new Set(["banned"]),
    })).toThrow("Only active accounts");
  });
});
