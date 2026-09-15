import { describe, expect, it } from "vitest";
import { FriendService, type UserAccount } from "./index.js";

function account(userId: string): UserAccount {
  return {
    userId,
    nickname: userId,
    avatarUrl: `avatar-${userId}`,
    status: "active",
    points: 0,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
  };
}

describe("friends", () => {
  it("supports request, acceptance, listing and removal", () => {
    let sequence = 0;
    const service = new FriendService(() => `request-${++sequence}`);
    const first = account("1234567890");
    const second = account("1234567891");

    const request = service.sendRequest(first, second);
    expect(service.relationship(first.userId, second.userId)).toBe("outgoing_pending");
    expect(service.relationship(second.userId, first.userId)).toBe("incoming_pending");
    expect(service.pendingFor(second.userId)).toEqual([request]);

    service.respond(request.requestId, second.userId, true);
    expect(service.friendIds(first.userId)).toEqual([second.userId]);
    expect(service.relationship(first.userId, second.userId)).toBe("friends");

    service.removeFriend(second.userId, first.userId);
    expect(service.friendIds(first.userId)).toEqual([]);
  });

  it("prevents self requests, duplicate pending requests and unauthorized responses", () => {
    const service = new FriendService(() => "request-1");
    const first = account("1234567890");
    const second = account("1234567891");
    const third = account("1234567892");
    expect(() => service.sendRequest(first, first)).toThrow("yourself");
    const request = service.sendRequest(first, second);
    expect(() => service.sendRequest(second, first)).toThrow("already pending");
    expect(() => service.respond(request.requestId, third.userId, true)).toThrow("Only the recipient");
  });

  it("allows a new request after rejection", () => {
    let sequence = 0;
    const service = new FriendService(() => `request-${++sequence}`);
    const first = account("1234567890");
    const second = account("1234567891");
    const rejected = service.sendRequest(first, second);
    service.respond(rejected.requestId, second.userId, false);
    expect(service.sendRequest(first, second).requestId).toBe("request-2");
  });
});
