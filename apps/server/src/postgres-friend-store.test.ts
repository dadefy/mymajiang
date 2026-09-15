import { describe, expect, it } from "vitest";
import type { UserAccount } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresFriendStore } from "./postgres-friend-store.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface RecordedQuery {
  channel: "pool" | "tx";
  sql: string;
  parameters: unknown[];
}

function fakeDatabase(options: { rows?: unknown[]; failOn?: string } = {}) {
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
      if (sql.includes("FROM friend_requests")) return { rows: options.rows ?? [], rowCount: 1 };
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

describe("PostgresFriendStore", () => {
  it("loads persisted friend requests including the response time", async () => {
    const { database } = fakeDatabase({
      rows: [
        {
          request_id: "00000000-0000-0000-0000-000000000001",
          requester_id: "1234567890",
          target_id: "1234567891",
          status: "accepted",
          created_at: new Date("2026-09-15T01:00:00.000Z"),
          responded_at: new Date("2026-09-15T02:00:00.000Z"),
        },
        {
          request_id: "00000000-0000-0000-0000-000000000002",
          requester_id: "1234567892",
          target_id: "1234567890",
          status: "pending",
          created_at: new Date("2026-09-15T03:00:00.000Z"),
          responded_at: null,
        },
      ],
    });

    const store = await PostgresFriendStore.load(database);

    expect(store.friendIds("1234567890")).toEqual(["1234567891"]);
    expect(store.relationship("1234567890", "1234567892")).toBe("incoming_pending");
    expect(store.pendingFor("1234567890")).toHaveLength(1);
    const accepted = store.requests.get("00000000-0000-0000-0000-000000000001");
    expect(accepted?.respondedAt).toEqual(new Date("2026-09-15T02:00:00.000Z"));
    expect(store.requests.get("00000000-0000-0000-0000-000000000002")).not.toHaveProperty("respondedAt");
  });

  it("persists a new friend request", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresFriendStore.load(database, undefined, () => "request-1");

    const request = store.sendRequest(account("1234567890", "甲"), account("1234567891", "乙"));
    await store.flush();

    expect(writes(timeline)).toEqual(["insert:friend_requests"]);
    const write = timeline.find((entry) => label(entry.sql) === "insert:friend_requests")!;
    expect(write.parameters).toEqual([
      request.requestId,
      "1234567890",
      "1234567891",
      "pending",
      expect.any(Date),
      null,
    ]);
  });

  it("writes the accepted request and its friendship in one transaction", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresFriendStore.load(database, undefined, () => "request-1");
    const request = store.sendRequest(account("1234567899", "甲"), account("1234567891", "乙"));
    await store.flush();
    timeline.length = 0;

    store.respond(request.requestId, "1234567891", true);
    await store.flush();

    expect(writes(timeline)).toEqual([
      "BEGIN",
      "insert:friend_requests",
      "insert:friendships",
      "COMMIT",
    ]);
    const friendship = timeline.find((entry) => label(entry.sql) === "insert:friendships")!;
    // The schema requires user_low_id < user_high_id, so the pair is ordered, not request-ordered.
    expect(friendship.parameters).toEqual(["1234567891", "1234567899", request.requestId, expect.any(Date)]);
  });

  it("writes only the request when a friend request is rejected", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresFriendStore.load(database, undefined, () => "request-1");
    const request = store.sendRequest(account("1234567890", "甲"), account("1234567891", "乙"));
    await store.flush();
    timeline.length = 0;

    store.respond(request.requestId, "1234567891", false);
    await store.flush();

    expect(writes(timeline)).toEqual(["BEGIN", "insert:friend_requests", "COMMIT"]);
  });

  it("removes the friendship before its source request in one transaction", async () => {
    const { database, timeline } = fakeDatabase();
    const store = await PostgresFriendStore.load(database, undefined, () => "request-1");
    const request = store.sendRequest(account("1234567890", "甲"), account("1234567891", "乙"));
    store.respond(request.requestId, "1234567891", true);
    await store.flush();
    timeline.length = 0;

    store.removeFriend("1234567890", "1234567891");
    await store.flush();

    // Order matters: friendships references friend_requests, so the child row goes first.
    expect(writes(timeline)).toEqual([
      "BEGIN",
      "delete:friendships",
      "delete:friend_requests",
      "COMMIT",
    ]);
    expect(store.friendIds("1234567890")).toEqual([]);
  });

  it("rolls back and reports the failure when a friendship write fails", async () => {
    const { database, timeline } = fakeDatabase({ failOn: "INSERT INTO friendships" });
    const store = await PostgresFriendStore.load(database, undefined, () => "request-1");
    const request = store.sendRequest(account("1234567890", "甲"), account("1234567891", "乙"));

    store.respond(request.requestId, "1234567891", true);
    await expect(store.flush()).rejects.toThrow("database offline");
    expect(writes(timeline)).toEqual([
      "insert:friend_requests",
      "BEGIN",
      "insert:friend_requests",
      "insert:friendships",
      "ROLLBACK",
    ]);
  });

  it("shares one queue with the other repositories", async () => {
    const { database, timeline } = fakeDatabase();
    const queue = new PostgresWriteQueue(database);
    const store = await PostgresFriendStore.load(database, queue, () => "request-1");

    store.sendRequest(account("1234567890", "甲"), account("1234567891", "乙"));
    await store.flush();

    expect(writes(timeline)).toEqual(["insert:friend_requests"]);
  });
});
