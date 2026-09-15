import { randomUUID } from "node:crypto";
import { FriendService, type FriendRequest, type UserAccount } from "@mianyang-mahjong/domain";
import type { PostgresDatabase } from "./database.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

interface FriendRequestRow {
  request_id: string;
  requester_id: string;
  target_id: string;
  status: FriendRequest["status"];
  created_at: Date;
  responded_at: Date | null;
}

const UPSERT_REQUEST_SQL = `INSERT INTO friend_requests (
    request_id, requester_id, target_id, status, created_at, responded_at
  ) VALUES ($1,$2,$3,$4,$5,$6)
  ON CONFLICT (request_id) DO UPDATE SET
    status = EXCLUDED.status, responded_at = EXCLUDED.responded_at`;

const INSERT_FRIENDSHIP_SQL = `INSERT INTO friendships (
    user_low_id, user_high_id, source_request_id, created_at
  ) VALUES ($1,$2,$3,$4)
  ON CONFLICT (user_low_id, user_high_id) DO NOTHING`;

const DELETE_FRIENDSHIP_SQL = `DELETE FROM friendships WHERE user_low_id = $1 AND user_high_id = $2`;

// Targets the single accepted request between a pair, so `removeFriend` needs no pre-read.
const DELETE_ACCEPTED_REQUEST_SQL = `DELETE FROM friend_requests
  WHERE status = 'accepted'
    AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1))`;

/**
 * Friend requests and friendships backed by PostgreSQL.
 *
 * The in-memory `requests` map stays authoritative for the domain rules; every mutation also
 * queues a durable write on the shared write queue. `friendships` is a denormalised index of
 * active pairs, written together with the accepted request in one transaction, so a friendship
 * can never exist without the request that produced it.
 */
export class PostgresFriendStore extends FriendService {
  private constructor(
    private readonly queue: PostgresWriteQueue,
    createRequestId: () => string,
  ) {
    super(createRequestId);
  }

  /** Loads every persisted friend request. Pass the queue shared with the other repositories. */
  static async load(
    database: PostgresDatabase,
    queue: PostgresWriteQueue = new PostgresWriteQueue(database),
    createRequestId: () => string = randomUUID,
  ): Promise<PostgresFriendStore> {
    const store = new PostgresFriendStore(queue, createRequestId);
    const { rows } = await database.pool.query<FriendRequestRow>(
      "SELECT * FROM friend_requests ORDER BY created_at ASC, request_id ASC",
    );
    for (const row of rows) {
      store.requests.set(row.request_id, {
        requestId: row.request_id,
        requesterId: row.requester_id.trim(),
        targetId: row.target_id.trim(),
        status: row.status,
        createdAt: row.created_at,
        ...(row.responded_at ? { respondedAt: row.responded_at } : {}),
      });
    }
    return store;
  }

  override sendRequest(requester: UserAccount, target: UserAccount): FriendRequest {
    const request = super.sendRequest(requester, target);
    this.queue.enqueue(UPSERT_REQUEST_SQL, requestParameters(request));
    return request;
  }

  override respond(requestId: string, actorId: string, accept: boolean): FriendRequest {
    const request = super.respond(requestId, actorId, accept);
    const statements = [{ sql: UPSERT_REQUEST_SQL, parameters: requestParameters(request) }];
    if (request.status === "accepted") {
      statements.push({
        sql: INSERT_FRIENDSHIP_SQL,
        parameters: [
          ...friendshipPair(request.requesterId, request.targetId),
          request.requestId,
          request.respondedAt ?? request.createdAt,
        ],
      });
    }
    this.queue.enqueueTransaction(statements);
    return request;
  }

  override removeFriend(userId: string, friendId: string): void {
    super.removeFriend(userId, friendId);
    this.queue.enqueueTransaction([
      { sql: DELETE_FRIENDSHIP_SQL, parameters: friendshipPair(userId, friendId) },
      { sql: DELETE_ACCEPTED_REQUEST_SQL, parameters: [userId, friendId] },
    ]);
  }

  /**
   * Waits for every queued write. All repositories share one queue, so flushing any of them
   * drains the others too.
   */
  async flush(): Promise<void> {
    await this.queue.flush();
  }
}

function requestParameters(request: FriendRequest): readonly unknown[] {
  return [
    request.requestId,
    request.requesterId,
    request.targetId,
    request.status,
    request.createdAt,
    request.respondedAt ?? null,
  ];
}

/** `friendships` stores each pair once, ordered by the schema's `user_low_id < user_high_id` check. */
function friendshipPair(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}
