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

/**
 * 座位控制权：**谁在操作这个座位**。
 *
 * 任一时刻只有一个来源，这是「托管与人工不会同时出牌」的根本保证：
 *   * `human`   —— 玩家自己操作；
 *   * `trustee` —— 服务器按 `MahjongGame.autoAct()` 的确定性策略代打。
 *
 * 玩家点「退出游戏」：human → trustee（立刻，不用等 120 秒）。
 * 玩家点「重新接管」并通过服务端校验：trustee → human。
 *
 * 这个字段是**业务状态**，必须持久化 —— 服务重启后要能继续托管，
 * 否则没人连接的座位会停在等人工操作上，把整局卡死。
 */
export type SeatControl = "human" | "trustee";

/**
 * 座位在场状态。
 *
 * ⚠️ 这是**推导值，不单独存**（`presenceOf`）。三个维度各管各的：
 *   * `connected`（实时连接）—— 内存，重启后 socket 本来就不存在；
 *   * `away`（暂离）        —— 持久化，返回大厅时为 true；
 *   * `control`（控制权）   —— 持久化，决定服务器代不代打。
 *
 * 合成一个 status 字段会出现"既是 away 又是 trustee"这种没法表达的组合，所以不合成。
 */
export type SeatPresence = "online" | "away" | "disconnected" | "trustee";

/**
 * 由三个维度推出在场状态。优先级有意如此：
 * 托管 > 暂离 > 断线 —— 座位被服务器接管时，"人在不在"已经不是重点，
 * 别人该看到的就是「这个座位在托管」，而不是「他去大厅了」。
 */
export function presenceOf(player: RoomPlayer): SeatPresence {
  if (player.control === "trustee") return "trustee";
  if (player.away) return "away";
  return player.connected ? "online" : "disconnected";
}

export interface RoomPlayer {
  account: UserAccount;
  joinedAt: Date;
  ready: boolean;
  connected: boolean;
  /** Fixed at match start, densely from join order. Absent while the room is still waiting. */
  seat?: number;
  disconnectedAt?: Date;
  reconnectDeadline?: Date;
  /** 控制权（持久化）。见 {@link SeatControl}。 */
  control: SeatControl;
  /** 暂离：返回了大厅但仍在房间里（持久化）。只影响展示，不影响牌局归属。 */
  away: boolean;
  /** 控制权最近一次变更的时刻，供排查与界面展示用。 */
  controlChangedAt?: Date;
  /**
   * 「这个玩家**当前仍处于**一次明确的主动退出状态」（持久化，migration 012）。
   *
   * ⚠️ 它是**状态**，不是历史记录 —— 「这个人曾经点过退出」：
   *   * `quitToTrustee()`（WS quit 帧）置 true：这是唯一把座位标记成"主动放弃"的路径；
   *   * 120 秒保护期到期转托管置 false：网络断线不等价于主动退出；
   *   * `resumeControl()`（重新接管）置 false；
   *   * `reconnect()`（真人重新进入牌局/重建连接）置 false —— 即使 control 仍是 trustee，
   *     人回来了就不能再被视为"放弃了这场比赛"（否则 4 人 quit 后有人回来看看，
   *     会被误判进"全员主动放弃"而提前终局）。
   *
   * `markAway` / `disconnect` **有意不碰它**：暂离与断线都不改变"是否主动放弃"。
   */
  renounced: boolean;
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
  /**
   * 本场（一整局 8 小场）**开始**的时刻：四家都准备好、房主点开局的那一刻。
   *
   * 与 `createdAt` 不是一回事：房间可以先建着等人，等十几分钟才开局。
   * 结算界面要显示的「本场游戏开始时间」是后者，用 `createdAt` 会多算等人的时间。
   * 等待中的房间（还没 `start()`）没有这个值。
   */
  startedAt?: Date;
  /**
   * 结算（`finalize()`）发生的时刻。只有 `completed` / `dissolved` 之后才有。
   *
   * 与 `startedAt` 一起算出「本局耗时」——那是玩家判断「这局打得久不久」的唯一依据，
   * 事后从别处推不出来（`completedRounds` 不携带任何时长信息）。
   */
  finishedAt?: Date;

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
      control: "human",
      away: false,
      renounced: false,
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
      control: "human",
      away: false,
      renounced: false,
    });
  }

  leave(userId: string): void {
    // 只挡**正在打**的房间：waiting 能退（原有规则），
    // finished / dissolved 是已经结束的房间，人必须能正常离开——
    // 「大局打完点退出房间被『开局之后不能退出』挡住」是实测过的缺陷：
    // 打满 8 小场后 status = finished，旧判据 `!== "waiting"` 把它一并拦了。
    // playing 中的退出仍然只能走「退出游戏 → 托管」（quitToTrustee），不走这里。
    if (this.status === "playing") throw new Error("Players cannot leave after the match starts");
    if (!this.players.delete(userId)) throw new Error("Player is not in the room");
    this.dissolveVotes.delete(userId);
    if (this.players.size === 0) {
      // 只把**等待中**的空房标记为解散。finished / dissolved 的房间本来就结束了：
      // 再降级会把 finished 的战绩语义抹掉（PostgresMatchRoom.leave 只在
      // dissolved 时写 finished_at，等于把真实结算时刻顶掉）。
      if (this.status === "waiting") this.status = "dissolved";
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

  /**
   * 连接断开。
   *
   * 120 秒保留期的含义（2026-09-17 重新定义）：**这是"人工控制权还给你留着"的期限，
   * 不是"禁止重新进入"的期限**。到期后座位转成托管（见 {@link expireReconnectWindow}
   * 与 {@link reconnect}），但人依然能回到这局，回来后点「重新接管」即可。
   *
   * **两种断开都不排保留期**：
   *
   *   1. 座位已经是托管 —— 操作权本来就不在玩家手上，没有"保留人工控制权"这回事。
   *   2. **暂离（返回大厅）** —— 暂离与"异常断线"是两件不同的事，**不能被混为一谈**：
   *      * 暂离的人**明确表示过**自己还在这一局（他只是离开了牌桌界面）；
   *      * 异常断线的人只是连接没了，我们不知道他还会不会回来。
   *
   *      给暂离排保留期，等于 120 秒后把他变成"托管中" —— 那正是明令禁止的
   *      「返回大厅 → 被识别成托管」。所以暂离期间这一座始终是**人工控制**，
   *      轮到它时走的是**普通的 15 秒倒计时 + 超时自动操作**（不会卡住牌局），
   *      而玩家随时回来就能直接接着打，不需要「重新接管」。
   *
   * ⚠️ `reconnectDeadline` 是**绝对时刻，且会持久化**（migration 011）。
   *    这一点是"墙钟语义"的全部意义：服务重启后它还在库里，所以停机期间照样在流逝，
   *    **重启不会白送一个新的 120 秒**。内存定时器只是"到点了提醒我去看一眼"的
   *    调度手段，它不是真相来源 —— 真相是库里这个时刻。
   */
  disconnect(userId: string, reconnectWindowMs = 120_000): void {
    const player = this.requirePlayer(userId);
    player.connected = false;
    if (player.control === "trustee" || player.away) {
      delete player.disconnectedAt;
      delete player.reconnectDeadline;
      return;
    }
    const disconnectedAt = this.now();
    player.disconnectedAt = disconnectedAt;
    player.reconnectDeadline = new Date(disconnectedAt.getTime() + reconnectWindowMs);
  }

  /**
   * 回到房间／重新打开页面。
   *
   * ⚠️ 与旧版的差别：**不再抛 `RECONNECT_WINDOW_EXPIRED`**。
   *
   * 旧语义是"掉线超过 2 分钟就再也进不来"——那与"座位保留到本场结束"直接冲突：
   * 座位会继续被代打到第 8 局，而人永远回不到自己的位子上。
   * 新语义是"超过 2 分钟就把控制权交给服务器，但人随时能回来，回来后再点『重新接管』"。
   *
   * 因此这里在窗口已过时**就地转为托管**，并返回"控制权变了吗"让调用方落库与广播；
   * 正常情况下窗口到期由实时层的定时器先触发，这一段是兜底（服务刚重启、定时器还没排上等）。
   *
   * ⚠️ renounced 在这里清成 false：auth 建立牌局连接就是「真人重新进入牌局」这一明确事件
   * （`reconnect` 只被 WS auth 调用）。quit 后原地留在牌桌的人不会走到这里 —— 他的
   * socket 一直开着，没有新连接，"主动放弃"的标记原样保留。
   * control **不因进入而改变**：回来先看到「托管中 + 重新接管」，要人工操作必须显式接管。
   *
   * @returns 控制权是否因此次进入而改变（true = 已转托管，调用方需要持久化）
   */
  reconnect(userId: string): boolean {
    const player = this.requirePlayer(userId);
    let controlChanged = false;
    if (
      this.status === "playing" &&
      player.control === "human" &&
      player.reconnectDeadline &&
      this.now().getTime() > player.reconnectDeadline.getTime()
    ) {
      this.setControl(player, "trustee");
      controlChanged = true;
    }
    player.connected = true;
    player.renounced = false;
    delete player.disconnectedAt;
    delete player.reconnectDeadline;
    return controlChanged;
  }

  /**
   * 120 秒窗口到期：把人工控制权交还给服务器。
   *
   * 实时层在窗口到期时调用（抛错/返回 false 都只是"无事可做"，幂等）。
   *
   * @returns 是否真的发生了 human → trustee（true = 调用方要落库并广播）
   */
  expireReconnectWindow(userId: string): boolean {
    const player = this.players.get(userId);
    if (!player || this.status !== "playing") return false;
    if (player.control !== "human") return false;
    if (!player.reconnectDeadline || player.reconnectDeadline.getTime() > this.now().getTime()) return false;
    this.setControl(player, "trustee");
    // 120 秒到期转托管 ≠ 主动退出：renounced 必须回到 false，
    // 否则网络断线会被误判成"放弃比赛"，提前终局条件就会被掉线触发。
    player.renounced = false;
    return true;
  }

  /**
   * 整房结算：把所有**保护期已过**的座位一次性交给服务器。
   *
   * 判据是数据库里的绝对时刻（{@link RoomPlayer.reconnectDeadline}），不是内存定时器：
   * 定时器到点只是"提醒我去看一眼"，服务一重启它就不存在了，而库里那个时刻还在。
   * 所以每一次"这一局被加载 / 有人进来 / 有人操作"都按墙钟重新判一次 ——
   * 这样 20:00 断线、20:00:30 停机、20:10 恢复时，判出来的答案是"20:02 已过期"，
   * 而不是"重启了，重新给 120 秒"。
   *
   * **幂等**：已经托管的、没有 deadline 的、还没到点的，一律跳过。
   * 于是 timer / reconnect / room load 三个入口**同时**发现过期也只有一个会真正转换，
   * 其余拿到空数组 ⇒ **不会重复产生游戏动作**（比如同一座被代打两次）。
   *
   * @returns 这次真正被转成托管的用户 id（调用方据此落库 + 广播 + 作废在途定时器）
   */
  expireOverdueControl(): string[] {
    if (this.status !== "playing") return [];
    const now = this.now().getTime();
    const changed: string[] = [];
    for (const [userId, player] of this.players) {
      if (player.control !== "human") continue;
      if (player.reconnectDeadline === undefined) continue;
      if (player.reconnectDeadline.getTime() > now) continue;
      this.setControl(player, "trustee");
      // 同 expireReconnectWindow：到期转托管不是主动退出。
      player.renounced = false;
      changed.push(userId);
    }
    return changed;
  }

  /**
   * 主动退出：把座位交给服务器托管。
   *
   * **不删玩家、不删座位、不动手牌、不动积分、不改大局归属** —— 只是控制权交出去。
   * 立刻生效，不需要等 120 秒（那是异常断线的口径）。
   *
   * @returns 是否真的发生了 human → trustee（已是托管时为 false，幂等）
   */
  quitToTrustee(userId: string): boolean {
    const player = this.requirePlayer(userId);
    if (this.status !== "playing") throw new Error("Room is not playing");
    if (player.control === "trustee") return false;
    this.setControl(player, "trustee");
    // 主动退出：座位进入「明确的主动放弃」状态（migration 012）。
    // 这是 renounced=true 的唯一写入点 —— 网络断线的托管化走不到这里。
    player.renounced = true;
    // 退出的人不在大厅，暂离标记一并清掉（presence 由 control 主导，这里只是不留脏数据）
    player.away = false;
    // 主动退出不走「异常断线 120 秒」那条路：残留的保护期必须清掉，
    // 否则先掉线、又在半开连接上补发 quit 的座位会带着一个旧 deadline，
    // 窗口定时器到点会去转一个已经托管的座位（expireReconnectWindow 幂等返回 false，
    // 但库里残留的旧时刻会让墙钟判定读到脏数据）。
    delete player.reconnectDeadline;
    return true;
  }

  /**
   * 重新接管：把控制权拿回人工。
   *
   * **幂等** —— 已经是人工时返回 false 而不是抛错：玩家重复点、或断网重发，都不该看到报错。
   * 是否**允许**接管由实时层校验（token、座位归属、大局仍 active），域层只负责状态转换。
   *
   * @returns 是否真的发生了 trustee → human
   */
  resumeControl(userId: string): boolean {
    const player = this.requirePlayer(userId);
    if (this.status !== "playing") return false;
    if (player.control === "human") return false;
    this.setControl(player, "human");
    // 重新接管 = 回到人工：自然不再处于"主动放弃"状态。
    player.renounced = false;
    player.away = false;
    return true;
  }

  /**
   * 「这一局已经打不下去了吗」—— 提前终局的**唯一判据**（migration 012 配套）。
   *
   * 每个座位必须都已失去有效在线参与，满足**任一**条即算该座出局：
   *   * `renounced` —— 明确的主动退出（quit）。**socket 还连着也算**：
   *     4 个人都点了退出、人都还挂在牌桌上看，也已经没有人参与这一局，
   *     不该再由 4 个托管自动打到第 7/8 局（真实测试暴露的问题）；
   *   * 失联且保护期已过：`!connected && !away && (已托管 || 墙钟 deadline 已过)`。
   *     异常断线仍尊重 120 秒窗口；暂离（away）**明确不算**。
   *
   * 幂等、纯读；终局动作见 {@link abortAbandonedMatch}。
   */
  matchAbandoned(): boolean {
    if (this.status !== "playing") return false;
    const now = this.now().getTime();
    for (const player of this.players.values()) {
      if (player.renounced) continue;
      if (player.away) return false;
      if (player.connected) return false;
      if (player.control !== "trustee") {
        // 还在人工的失联座位：保护期没过就不算（120 秒窗口内不终止）。
        if (!player.reconnectDeadline || player.reconnectDeadline.getTime() > now) return false;
      }
    }
    return true;
  }

  /**
   * 提前终局：当前小局作废，大局按**已完成的小局**结算收尾。
   *
   *   * **绝不调用** `recordCompletedRound()` —— 当前小局的 events 只存在于
   *     引擎内存与 `match_round_states` 快照里，从未进过任何永久账
   *     （`match_rounds` / `point_ledger` / `raw_delta` / 账号积分），
   *     所以作废实现就是"丢弃引擎 + 清快照"，无需任何积分冲正；
   *     `rawDeltas` 结构上只含已完成局（它唯一的写点就是 `recordCompletedRound`）。
   *   * 复用 `finalize("dissolved")`：status → dissolved、清 activeMatchId、
   *     入账与 ledger 全部走现有结算链（`PostgresMatchRoom.finalize` 覆写自动落库），
   *     `final_reason='dissolved'` + `completed_rounds<8` 即可在战绩里识别"提前结束"。
   *   * **幂等**：`status !== "playing"` 直接返回 undefined —— 重复触发、多路触发
   *     （quit、window 定时器、settleExpiredSeats、断线回调）只有第一次真正结算。
   *
   * 0 局完成场景：`rawDeltas` 全 0 → `accountDeltas` 全 0 → 不写任何 ledger，余额不动。
   */
  abortAbandonedMatch(): RoomResult | undefined {
    if (this.status !== "playing") return undefined;
    return this.finalize("dissolved");
  }

  /**
   * 暂离（返回大厅）/ 回到牌桌。
   *
   * **只影响在场状态的显示，不影响控制权与座位归属** —— 暂离的人随时回来就能直接接着打。
   *
   * @returns 是否真的发生了变化（调用方据此决定要不要落库、要不要广播给另外三家）
   */
  markAway(userId: string, away: boolean): boolean {
    const player = this.requirePlayer(userId);
    if (player.away === away) return false;
    player.away = away;
    if (away) {
      // 暂离的人**明确表示过**自己还在这一局，这一座就不该走"异常断线 120 秒"那条路。
      // 清掉可能已经开始的保留期（例如先掉线进了窗口、又从另一台设备回了大厅）；
      // 已经排好的定时器到点会去问 {@link expireReconnectWindow}，那里因为没有
      // `reconnectDeadline` 会直接返回 false，所以这个定时器**不会**把座位变成托管。
      delete player.disconnectedAt;
      delete player.reconnectDeadline;
    }
    return true;
  }

  private setControl(player: RoomPlayer, control: SeatControl): void {
    if (player.control === control) return;
    player.control = control;
    player.controlChangedAt = this.now();
    if (control === "trustee") {
      // 交给服务器之后，"保留人工控制权"的窗口就不存在了
      delete player.disconnectedAt;
      delete player.reconnectDeadline;
    }
  }

  start(requesterId: string): void {
    if (this.status !== "waiting") throw new Error("Room is not waiting to start");
    if (requesterId !== this.ownerId) throw new Error("Only the room owner can start the match");
    if (this.players.size !== MIANYANG_XZ_1_0.playerCount) throw new Error("Four players are required");
    // 四人入座后房主直接开局，不再要求逐个准备。

    // Seats are fixed at start, densely from join order, so the table layout never shifts afterwards.
    const ordered = [...this.players.values()]
      .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime());
    // Validate everyone before mutating any seat or balance.
    for (const player of ordered) this.assertCanJoin(player.account);
    ordered.forEach((player, seat) => {
      this.openingBalances.set(player.account.userId, player.account.points);
      this.rawDeltas.set(player.account.userId, 0);
      player.seat = seat;
      player.account.activeMatchId = this.roomId;
    });
    // 开局时刻记在这里（**校验全过之后**）：上面几条都可能抛错，抛了就不算开局。
    this.startedAt = this.now();
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
      // 大局结束 ⇒ 托管与暂离关系一并作废（需求七：不能让已结束的大局还能"重新接管"）。
      // 房间对象还留在内存里，不复位的话会带着 trustee 残留到下一次读取。
      player.control = "human";
      player.away = false;
      player.renounced = false;
      delete player.controlChangedAt;
      delete player.disconnectedAt;
      delete player.reconnectDeadline;
    }

    this.status = reason === "completed" ? "finished" : "dissolved";
    // 结算时刻：与 `startedAt` 配对算耗时。放在入账之后，
    // 因为上面的入账校验（积分不能为负）抛错时这一局并没有结算成功。
    this.finishedAt = this.now();
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
