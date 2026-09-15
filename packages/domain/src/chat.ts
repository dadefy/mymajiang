export type GroupRole = "owner" | "admin" | "member";

export interface GroupMessage {
  messageId: string;
  groupId: string;
  senderId: string;
  sentAt: Date;
  recalledAt?: Date;
  recalledBy?: string;
}

export interface RecallPolicy {
  userRecallEnabled: boolean;
  userRecallWindowMs: number;
}

export const DEFAULT_RECALL_POLICY: RecallPolicy = {
  userRecallEnabled: true,
  userRecallWindowMs: 2 * 60 * 1000,
};

export function canRecallMessage(input: {
  actorId: string;
  actorRole: GroupRole | "super_admin";
  message: GroupMessage;
  now: Date;
  policy?: RecallPolicy;
}): boolean {
  if (input.message.recalledAt) return false;
  if (input.actorRole === "super_admin" || input.actorRole === "owner" || input.actorRole === "admin") return true;

  const policy = input.policy ?? DEFAULT_RECALL_POLICY;
  if (!policy.userRecallEnabled || input.actorId !== input.message.senderId) return false;
  const age = input.now.getTime() - input.message.sentAt.getTime();
  return age >= 0 && age <= policy.userRecallWindowMs;
}

export function recallMessage(message: GroupMessage, actorId: string, recalledAt: Date): GroupMessage {
  if (message.recalledAt) throw new Error("Message is already recalled");
  return { ...message, recalledAt, recalledBy: actorId };
}

