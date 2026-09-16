import {
  MIANYANG_XZ_1_0,
  assertZeroSum,
  capLossesByOpeningBalance,
  mergeDeltas,
  type RoundResult,
  type ScoreDelta,
  type SettlementEvent,
} from "@mianyang-mahjong/rules";
import type { UserAccount } from "./accounts.js";
import { canEnterMatch } from "./points.js";

export type RoomStatus = "waiting" | "playing" | "finished" | "dissolved";

export interface RoomPlayer {
  account: UserAccount;
  joinedAt: Date;
  ready: boolean;
  connected: boolean;
  /** Fixed at match start, densely from join order. Absent while the room is still waiting. */
  seat?: number;
  disconnectedAt?: Date;
  reconnectDeadline?: Date;
}

/**
 * One finished round as produced by the rules engine, plus the settlement events behind it.
 *
 * `events` travel with the round because they cannot be recomputed later; replaying them is a
 * separate feature.
 */
export type RecordedRound = RoundResult & { events?: readonly SettlementEvent[] };

export interface RoomResult {
  roomId: string;
  completedRounds: number;
  reason: "completed" | "dissolved";
  rawDeltas: ScoreDelta[];
  accountDeltas: ScoreDelta[];
}

export class MatchRoom {
  readonly ruleVersion = MIANYANG_XZ_1_0.id;
  readonly players = new Map<string, RoomPlayer>();
  readonly rawDeltas = new Map<string, number>();
  readonly openingBalances = new Map<string, number>();
  readonly dissolveVotes = new Set<string>();
  readonly createdAt: Date;
  status: RoomStatus = "waiting";
  ownerId: string;
  completedRounds = 0;
  result?: RoomResult;

  constructor(
    readonly roomId: string,
    /**
     * 6 位数字房间号：**给人念、给人输的那串**。
     *
     * 与 `roomId`（内部 uuid）分开是有意的 —— 让人输入或口头转述一串 uuid 不现实，
     * 而房间号要能在微信里发一句话说清楚。群聊那边是同一套做法（8 位群号）。
     */
    readonly roomNo: string,
    owner: UserAccount,
    private readonly now: () => Date = () => new Date(),
    /**
     * `restore` 跳过入场校验。
     *
     * 「能不能入场」是入场那一刻的规则，由 `join()` 和 `start()` 把关；从存储重建房间时，
     * 房间里的人本来就已经在房间里了 —— 进行中对局的玩家还带着 `activeMatchId`，
     * 正是 `assertCanJoin` 要拒绝的状态。
     */
    mode: "create" | "restore" = "create",
  ) {
    this.createdAt = this.now();
    if (!/^\d{6}$/.test(roomNo)) throw new Error("Room number must contain exactly 6 digits");
    if (mode === "create") this.assertCanJoin(owner);
    this.ownerId = owner.userId;
    this.players.set(owner.userId, {
      account: owner,
      joinedAt: this.now(),
      ready: false,
      connected: true,
    });
  }

  join(account: UserAccount): void {
    if (this.status !== "waiting") throw new Error("Room has already started");
    if (this.players.has(account.userId)) throw new Error("Player is already in the room");
    if (this.players.size >= MIANYANG_XZ_1_0.playerCount) throw new Error("Room is full");
    this.assertCanJoin(account);
    this.players.set(account.userId, {
      account,
      joinedAt: this.now(),
      ready: false,
      connected: true,
    });
  }

  leave(userId: string): void {
    if (this.status !== "waiting") throw new Error("Players cannot leave after the match starts");
    if (!this.players.delete(userId)) throw new Error("Player is not in the room");
    this.dissolveVotes.delete(userId);
    if (this.players.size === 0) {
      this.status = "dissolved";
      return;
    }
    if (this.ownerId === userId) {
      this.ownerId = [...this.players.values()]
        .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime())[0]!.account.userId;
    }
  }

  setReady(userId: string, ready: boolean): void {
    if (this.status !== "waiting") throw new Error("Ready state is locked after the match starts");
    this.requirePlayer(userId).ready = ready;
  }

  setConnected(userId: string, connected: boolean): void {
    if (connected) this.reconnect(userId);
    else this.disconnect(userId);
  }

  disconnect(userId: string, reconnectWindowMs = 120_000): void {
    const player = this.requirePlayer(userId);
    const disconnectedAt = this.now();
    player.connected = false;
    player.disconnectedAt = disconnectedAt;
    player.reconnectDeadline = new Date(disconnectedAt.getTime() + reconnectWindowMs);
  }

  reconnect(userId: string): void {
    const player = this.requirePlayer(userId);
    if (
      this.status === "playing" &&
      player.reconnectDeadline &&
      this.now().getTime() > player.reconnectDeadline.getTime()
    ) {
      throw new Error("RECONNECT_WINDOW_EXPIRED");
    }
    player.connected = true;
    delete player.disconnectedAt;
    delete player.reconnectDeadline;
  }

  start(requesterId: string): void {
    if (this.status !== "waiting") throw new Error("Room is not waiting to start");
    if (requesterId !== this.ownerId) throw new Error("Only the room owner can start the match");
    if (this.players.size !== MIANYANG_XZ_1_0.playerCount) throw new Error("Four players are required");
    if ([...this.players.values()].some((player) => !player.ready)) throw new Error("All players must be ready");

    // Seats are fixed at start, densely from join order, so the table layout never shifts afterwards.
    const ordered = [...this.players.values()]
      .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime());
    ordered.forEach((player, seat) => {
      this.assertCanJoin(player.account);
      this.openingBalances.set(player.account.userId, player.account.points);
      this.rawDeltas.set(player.account.userId, 0);
      player.seat = seat;
      player.account.activeMatchId = this.roomId;
    });
    this.status = "playing";
  }

  recordCompletedRound(round: RecordedRound): RoomResult | undefined {
    if (this.status !== "playing") throw new Error("Room is not playing");
    if (this.completedRounds >= MIANYANG_XZ_1_0.rounds) throw new Error("All rounds are already complete");
    assertZeroSum(round.deltas);
    const roundDeltas = mergeDeltas(round.deltas);
    for (const entry of roundDeltas) {
      if (!this.players.has(entry.playerId)) throw new Error(`Unknown room player: ${entry.playerId}`);
      this.rawDeltas.set(entry.playerId, (this.rawDeltas.get(entry.playerId) ?? 0) + entry.delta);
    }
    this.completedRounds += 1;
    if (this.completedRounds === MIANYANG_XZ_1_0.rounds) return this.finalize("completed");
    return undefined;
  }

  requestDissolve(userId: string): boolean {
    if (this.status === "waiting") {
      if (userId !== this.ownerId) throw new Error("Only the room owner can dissolve a waiting room");
      this.status = "dissolved";
      return true;
    }
    if (this.status !== "playing") throw new Error("Room cannot be dissolved now");
    this.requirePlayer(userId);
    this.dissolveVotes.clear();
    this.dissolveVotes.add(userId);
    return false;
  }

  voteDissolve(userId: string, agree: boolean): RoomResult | undefined {
    if (this.status !== "playing") throw new Error("Room is not playing");
    this.requirePlayer(userId);
    if (agree) this.dissolveVotes.add(userId);
    else this.dissolveVotes.delete(userId);
    if (this.dissolveVotes.size >= 3) return this.finalize("dissolved");
    return undefined;
  }

  /**
   * Settles the match: applies the capped deltas to every account and clears `activeMatchId`.
   *
   * Protected so a persistence layer can record the settlement after the rules have been applied;
   * the return value is the authoritative result either way.
   */
  protected finalize(reason: "completed" | "dissolved"): RoomResult {
    const rawDeltas = [...this.rawDeltas.entries()].map(([playerId, delta]) => ({ playerId, delta }));
    const openingBalances = Object.fromEntries(this.openingBalances);
    const accountDeltas = capLossesByOpeningBalance(rawDeltas, openingBalances);

    for (const player of this.players.values()) {
      const delta = accountDeltas.find((entry) => entry.playerId === player.account.userId)?.delta ?? 0;
      player.account.points += delta;
      if (player.account.points < 0) throw new Error("Account points cannot become negative");
      delete player.account.activeMatchId;
    }

    this.status = reason === "completed" ? "finished" : "dissolved";
    this.result = {
      roomId: this.roomId,
      completedRounds: this.completedRounds,
      reason,
      rawDeltas: mergeDeltas(rawDeltas),
      accountDeltas,
    };
    return this.result;
  }

  private assertCanJoin(account: UserAccount): void {
    // `canEnterMatch` 是三个条件的 AND（账号可用 + **没有进行中的对局** + 积分够），
    // 但它们原先共用一条消息，而那条消息只提「积分 500」——
    // 于是「已经有一局没打完」这种最常见的拒绝，看到的却是「积分不足」，
    // 排查时会被带到完全相反的方向（实测：账号还挂在上一局里时建房返回 409，
    // 消息是 `Active account with at least 500 points is required`）。
    // 这里把对局中这一条单独拆出来，其余仍旧走原来的判断。
    // 消息仍以 `Active account` 开头：与上一条同属一族，
    // `rooms.test.ts` 也是按这个前缀断言「入场校验拒绝了」的。
    if (account.activeMatchId) {
      throw new Error("Active account already has a match in progress");
    }
    if (!canEnterMatch(account, MIANYANG_XZ_1_0.minimumEntryPoints)) {
      throw new Error("Active account with at least 500 points is required");
    }
  }

  private requirePlayer(userId: string): RoomPlayer {
    const player = this.players.get(userId);
    if (!player) throw new Error("Player is not in the room");
    return player;
  }
}
