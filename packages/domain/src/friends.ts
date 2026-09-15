import type { UserAccount } from "./accounts.js";

export type FriendRequestStatus = "pending" | "accepted" | "rejected";
export type FriendRelationship = "self" | "friends" | "incoming_pending" | "outgoing_pending" | "none";

export interface FriendRequest {
  requestId: string;
  requesterId: string;
  targetId: string;
  status: FriendRequestStatus;
  createdAt: Date;
  respondedAt?: Date;
}

export class FriendService {
  readonly requests = new Map<string, FriendRequest>();

  constructor(
    private readonly createRequestId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  sendRequest(requester: UserAccount, target: UserAccount): FriendRequest {
    this.assertActive(requester);
    this.assertActive(target);
    if (requester.userId === target.userId) throw new Error("Cannot add yourself as a friend");
    const relationship = this.relationship(requester.userId, target.userId);
    if (relationship === "friends") throw new Error("Users are already friends");
    if (relationship === "incoming_pending" || relationship === "outgoing_pending") {
      throw new Error("Friend request is already pending");
    }
    const request: FriendRequest = {
      requestId: this.createRequestId(),
      requesterId: requester.userId,
      targetId: target.userId,
      status: "pending",
      createdAt: this.now(),
    };
    this.requests.set(request.requestId, request);
    return request;
  }

  respond(requestId: string, actorId: string, accept: boolean): FriendRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error("FRIEND_REQUEST_NOT_FOUND");
    if (request.targetId !== actorId) throw new Error("Only the recipient can respond to a friend request");
    if (request.status !== "pending") throw new Error("Friend request has already been handled");
    request.status = accept ? "accepted" : "rejected";
    request.respondedAt = this.now();
    return request;
  }

  pendingFor(userId: string): FriendRequest[] {
    return [...this.requests.values()]
      .filter((request) => request.targetId === userId && request.status === "pending")
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  friendIds(userId: string): string[] {
    return [...new Set(
      [...this.requests.values()]
        .filter((request) => request.status === "accepted" && (request.requesterId === userId || request.targetId === userId))
        .map((request) => request.requesterId === userId ? request.targetId : request.requesterId),
    )];
  }

  relationship(userId: string, otherId: string): FriendRelationship {
    if (userId === otherId) return "self";
    const request = [...this.requests.values()]
      .filter((candidate) =>
        (candidate.requesterId === userId && candidate.targetId === otherId) ||
        (candidate.requesterId === otherId && candidate.targetId === userId),
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .find((candidate) => candidate.status !== "rejected");
    if (!request) return "none";
    if (request.status === "accepted") return "friends";
    return request.requesterId === userId ? "outgoing_pending" : "incoming_pending";
  }

  removeFriend(userId: string, friendId: string): void {
    const accepted = [...this.requests.values()].find((request) =>
      request.status === "accepted" &&
      ((request.requesterId === userId && request.targetId === friendId) ||
        (request.requesterId === friendId && request.targetId === userId)),
    );
    if (!accepted) throw new Error("Users are not friends");
    this.requests.delete(accepted.requestId);
  }

  private assertActive(account: UserAccount): void {
    if (account.status !== "active") throw new Error("Only active accounts can use friends");
  }
}
