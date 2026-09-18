import { randomInt } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import {
  MIANYANG_XZ_1_0,
  MahjongGame,
  type ClaimAction,
  type Suit,
  type Tile,
} from "@mianyang-mahjong/rules";
import { presenceOf, type MatchRoom, type RoomResult, type SeatControl } from "@mianyang-mahjong/domain";
import type { AppDependencies } from "./app.js";
import type { StoredRoundState } from "./game-state-store.js";
import type { GroupEvent } from "./group-events.js";
import { maskMelds } from "./meld-visibility.js";
import type { SeatEvent } from "./seat-events.js";
import { WebSocketConnection, WebSocketServer, type WsMessage } from "./ws.js";

interface ActiveMatch {
  room: MatchRoom;
  game: MahjongGame;
  seatsByUser: Map<string, number>;
  roundNumber: number;
  actionDeadlineAt?: number;
  deadlineGame?: MahjongGame;
  deadlinePhase?: MahjongGame["phase"];
  /** 快照节流：上次真正落盘的时间；undefined 表示还没写过。 */
  lastSavedAt?: number;
  /** 快照节流：距上次落盘之后状态又变过，尚未写盘。 */
  stateDirty?: boolean;
  /**
   * 每个座位的**控制权世代**：控制权每变一次就 +1。
   *
   * 为什么必须有它：`setTimeout` 一旦到点，回调就已经排进事件循环队列，
   * 这时候 `clearTimeout` 是**取消不掉**的。于是会出现这样一条真实路径 ——
   * 托管定时器到点（回调入队）→ 玩家的 `request_takeover` 先被处理（控制权转人工、重排定时器）
   * → 那个已经在队列里的回调接着执行 → 替一个已经回到人工的座位又出了一张牌。
   *
   * 定时器在挂表时捕获当时的世代，开火时对不上就放弃。这是"同一个座位任何时刻
   * 只有一个控制来源"的兜底保证（光靠 `clearActionTimers` 是挡不住这条路径的）。
   */
  seatEpoch: Map<number, number>;
  /**
   * 提前终局进行中 / 已完成（migration 012 配套「全员放弃提前终局」）。
   *
   * 终局可由多条路径触发（quit、断线回调、120 秒窗口定时器、墙钟结算、局间停留），
   * 且定时器回调一旦排进事件队列就撤不干净 —— 这个标志保证**只有第一次真正结算**，
   * 后续触发（包括已经在飞的 `broadcastState`）看到它就直接返回。
   */
  terminating?: boolean;
}

export interface RealtimeOptions {
  playTimeoutMs?: number;
  claimTimeoutMs?: number;
  /**
   * 一小场打完到开下一小场之间的**停留**（毫秒），默认 3000。
   *
   * 留这段时间只是给四家看清「这一小场各赢输多少」那四个数字 ——
   * 不加停留时服务端在同一轮广播里就开了下一小场，局间只有几十毫秒，数字一闪而过。
   * 3 秒是玩法定的（客户端那边也靠这个数决定数字什么时候收）。
   * 设 0 表示立刻开下一小场（测试用，避免每个跨局用例白等 3 秒）。
   */
  interRoundPauseMs?: number;
  /** 快照落盘的最小间隔（毫秒）。同一时间窗内的多次行动合并成一次写；默认 2000。 */
  saveIntervalMs?: number;
  /**
   * 异常断线后「人工控制权还留着」的时长（毫秒），默认 120000。
   *
   * 到期后这一座自动转托管（并落库、广播），**但不是禁止进入** ——
   * 玩家之后任何时候回来都能进这一局，只是进来要先把控制权点回来（「重新接管」）。
   * 测试里设小值，省得每个跨断线用例白等两分钟。
   */
  reconnectWindowMs?: number;
}

/** 每个 active match 的 seat -> connection 映射。 */
const seatConnections = new Map<ActiveMatch, Map<number, WebSocketConnection>>();
const connectionsByRoom = new Map<string, Map<string, WebSocketConnection>>();

function roomConnections(roomId: string): Map<string, WebSocketConnection> {
  let map = connectionsByRoom.get(roomId);
  if (!map) {
    map = new Map();
    connectionsByRoom.set(roomId, map);
  }
  return map;
}

function sendError(connection: WebSocketConnection, message: string): void {
  connection.send({ type: "error", message });
}

/**
 * 一位玩家在**本小场**（这一局）事件账本上的净输赢。换一小场就归零。
 *
 * 事件账本是「这一局里谁付给谁多少」的流水，所以只有本小场的信息 ——
 * 头像上要显示的是**整局**累计，那是 `matchTotal`。
 */
function roundNet(game: MahjongGame, playerId: string): number {
  return game.events.reduce(
    (total, event) => total + (event.payee === playerId ? event.points : 0) - (event.payer === playerId ? event.points : 0),
    0,
  );
}

/**
 * 一位玩家**整局**（打满 8 小场）的净输赢累计。
 *
 * 两截相加是必须的，缺一段就会错：
 *   * `room.rawDeltas` 由 `recordCompletedRound` 在**小场结算时**才累加 ——
 *     只看它，正打着的这一小场不进去，头像上的数字要等下一小场开始才动；
 *   * 只看事件账本（`roundNet`），换一小场就归零 ——
 *     那正是「头像下面记的是本小场、不是一整局」这个缺陷本身。
 *
 * 换局后新引擎的 `events` 是空的，`rawDeltas` 正好接上前几小场，两段不会重复计。
 */
function matchTotal(room: MatchRoom, game: MahjongGame, playerId: string): number {
  return (room.rawDeltas?.get(playerId) ?? 0) + roundNet(game, playerId);
}

/** 单个玩家的脱敏视图（含自己的手牌，不含他人手牌）。 */
export function playerSnapshot(game: MahjongGame, seat: number, room: MatchRoom, roundNumber: number, actionDeadlineAt?: number): object {
  const player = game.players[seat]!;
  // `players` 用可选链：这个函数也被只关心牌面、不搭房间的调用方用着（见 round-settlement.test.ts）。
  const mine = room.players?.get(player.id);
  return {
    roomId: room.roomId,
    roundNumber,
    /** 一整局共几小场（8）。客户端显示「第 N/8 小场」用，省得两边各写一个 8。 */
    totalRounds: MIANYANG_XZ_1_0.rounds,
    actionDeadlineAt,
    seat,
    /**
     * 我这一座的**权威控制权**，每帧都带。
     *
     * 客户端据此决定显示牌桌还是"你的牌局正在托管中 + 重新接管"。
     * 每帧都带而不是只在变化时推一次：F5、断网重连、切前后台之后客户端手上那帧可能是旧的，
     * 权威值随帧下发，客户端就永远不需要"猜自己现在是人还是托管"。
     */
    control: mine?.control ?? "human",
    /** 我是不是从大厅回来的（暂离标记）。 */
    away: mine?.away ?? false,
    phase: game.phase,
    dealerSeat: game.dealerSeat,
    currentPlayerSeat: game.currentPlayerSeat,
    tilesLeft: game.tilesLeft,
    hand: [...(player.won ? player.winningHand : player.hand)],
    melds: [...player.melds],
    missingSuit: player.missingSuit,
    discards: [...player.discards],
    won: player.won,
    players: game.players.map((other) => {
      const roomPlayer = room.players?.get(other.id);
      return {
        seat: other.seat,
        avatarUrl: roomPlayer?.account.avatarUrl,
        /** 在场状态（online / away / disconnected / trustee），给头像上那行小字用。 */
        presence: roomPlayer ? presenceOf(roomPlayer) : undefined,
        /** 本小场（这一局）的净输赢；换一小场归零，只给结算界面用。 */
        roundDelta: roundNet(game, other.id),
        /** 整局累计净输赢 —— 头像下面显示的就是它，跨 8 小场连续累加。 */
        matchDelta: matchTotal(room, game, other.id),
        handSize: other.won ? other.winningHand.length : other.handSize,
        // 别人的暗杠是扣着的，牌值不下发（见 meld-visibility.ts）——
        // 否则任何打开开发者工具的人都能读出对手暗杠的是哪张牌。
        melds: maskMelds(other.melds, other.seat === seat),
        discards: [...other.discards],
        won: other.won,
        missingSuit: other.missingSuit,
      };
    }),
    ...(game.result ? { result: game.result } : {}),
  };
}

/**
 * 只允许已结束的本局公开四家牌面。
 *
 * 同时把**整局累计**一并带上（`players[].matchDelta`）：局间停留期间服务端不再发对局帧，
 * 客户端手里那帧是这一小场最后一次动作**之前**的，累计分差着最后一个事件
 * （真发生过：结算一看，头像上的数字与结算面板对不上）。这里给一份权威值。
 */
export function roundSettlement(
  game: MahjongGame,
  context: { room?: MatchRoom; roundNumber?: number } = {},
) {
  if (game.phase !== "finished" || !game.result) throw new Error("Round has not finished");
  const result = game.result;
  const room = context.room;
  return {
    ...result,
    /** 这是第几小场（从 1 起）；调用方没给时不带这个字段。 */
    roundNumber: context.roundNumber,
    /** 一整局共几小场（8）。 */
    totalRounds: MIANYANG_XZ_1_0.rounds,
    deltas: game.players.map((player) => ({
      playerId: player.id,
      delta: result.deltas.find((entry) => entry.playerId === player.id)?.delta ?? 0,
    })),
    players: game.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      won: player.won,
      hand: [...(player.won ? player.winningHand : player.hand)],
      melds: player.melds.map((meld) => ({ ...meld })),
      /** 含本小场在内的整局累计净输赢。没有房间上下文时不给（见 `matchTotal`）。 */
      matchDelta: room ? matchTotal(room, game, player.id) : undefined,
    })),
  };
}

/**
 * 整局结算帧的载荷：在域层的 `RoomResult` 之上补三样**只有服务端这一侧拿得到**的东西。
 *
 *   ① `startedAt` / `finishedAt`（毫秒时间戳）—— 结算记录顶部那行「开始 … 耗时 …」的来源。
 *      用毫秒数字而不是 `Date`：帧要过 JSON，数字没有序列化歧义。
 *      `finishedAt` 兜底用当前时刻，`startedAt` 没有就不给（客户端据此整行不显示）。
 *   ② `players`：**四行玩家明细**（头像、昵称、10 位 id 号、本局积分变化、入账分、余额）。
 *      头像与昵称在房间成员上，入账分在 `matchResult` 里，余额要等 `finalize()` 写完账号 ——
 *      客户端手里的 session 是**开局前**那次登录的快照，这四行它自己拼不出来。
 *   ③ 座位顺序：`seat` 是开局时按加入顺序定死的，在这里排好，
 *      免得三个客户端各排一遍、排法还不一致（`seat` 理论上缺失时按 0 兜底）。
 *
 * 单独成函数是为了能直接断言这四行与两个时间戳 —— 它在 `broadcastState` 深处，
 * 只有真打完一整局（8 小场）才会走到，而那一局要跑十几分钟。
 */
export function matchSettlement(room: MatchRoom, matchResult: RoomResult) {
  const rawDeltas = new Map(matchResult.rawDeltas.map((entry) => [entry.playerId, entry.delta]));
  const accountDeltas = new Map(matchResult.accountDeltas.map((entry) => [entry.playerId, entry.delta]));
  return {
    ...matchResult,
    startedAt: room.startedAt?.getTime(),
    finishedAt: room.finishedAt?.getTime() ?? Date.now(),
    players: [...room.players.values()]
      .sort((left, right) => (left.seat ?? 0) - (right.seat ?? 0))
      .map((player) => ({
        /** 10 位数字 id 号：账号的唯一标识，界面上给人核对自己是哪一行用的。 */
        playerId: player.account.userId,
        nickname: player.account.nickname,
        avatarUrl: player.account.avatarUrl,
        seat: player.seat ?? 0,
        /** 本局（整场 8 小场）未封顶的净输赢。 */
        delta: rawDeltas.get(player.account.userId) ?? 0,
        /** 实际写入账号的分；与 `delta` 不同说明触发了封顶或负分保护。 */
        accountDelta: accountDeltas.get(player.account.userId) ?? 0,
        /** 入账之后的账号余额。 */
        balance: player.account.points,
      })),
  };
}

/** 独立监听一个端口。测试与非共用端口的部署用；生产推荐共用端口（见 createAttachedWebSocketServer）。 */
export function createWebSocketServer(
  dependencies: AppDependencies,
  port: number,
  options: RealtimeOptions = {},
  /** 绑定地址。要让局域网/公网连上必须传 0.0.0.0。 */
  bindHost = "127.0.0.1",
): Promise<WebSocketServer> {
  const wss = buildRealtimeServer(dependencies, options, "standalone");
  return wss.listen(port, bindHost).then(() => wss);
}

/**
 * 让实时通道与 HTTP **共用同一个端口**：挂在同一个 HTTP 服务的 `upgrade` 事件上。
 *
 * 这是公网部署的默认方式，因为：
 *   * 内网穿透与反向代理通常只给一个入口，两个端口就意味着两个公网地址；
 *   * 页面一旦走 HTTPS，浏览器会拦截 `ws://`，只能用 `wss://` —— 而 `wss://`
 *     要求 TLS 终止点与页面同一个入口。共用一个端口后这件事自动成立。
 */
export function createAttachedWebSocketServer(
  httpServer: HttpServer,
  dependencies: AppDependencies,
  options: RealtimeOptions = {},
): WebSocketServer {
  const wss = buildRealtimeServer(dependencies, options, "attached");
  // `upgrade` 事件把 socket 声明成 Duplex，运行时给的其实就是 net.Socket
  // （HTTP 升级发生在 TCP 连接上），所以这里收窄一次是安全的。
  httpServer.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket as Socket, head));
  return wss;
}

function buildRealtimeServer(
  dependencies: AppDependencies,
  options: RealtimeOptions = {},
  mode: "standalone" | "attached",
): WebSocketServer {
  const activeMatches = new Map<string, ActiveMatch>();
  const actionTimers = new Map<ActiveMatch, Map<number, ReturnType<typeof setTimeout>>>();
  /** 快照节流：每个进行中对局的"延迟落盘"定时器，到点把最新状态写一次。 */
  const saveTimers = new Map<ActiveMatch, ReturnType<typeof setTimeout>>();
  const playTimeoutMs = options.playTimeoutMs ?? 15_000;
  const claimTimeoutMs = options.claimTimeoutMs ?? 8_000;
  /** 局间停留：一局打完到开下一局之间留给结算展示的时间。 */
  const interRoundPauseMs = options.interRoundPauseMs ?? 3_000;
  /** 每个进行中对局的"局间停留"定时器。至多一个 —— 它同时是 reentry 的保护。 */
  const interRoundTimers = new Map<ActiveMatch, ReturnType<typeof setTimeout>>();
  /**
   * 每个「异常断线、还在 120 秒保留期里」的座位一个定时器，到点把控制权交给服务器。
   *
   * 120 秒是**保留人工控制权**的期限，不是禁止进入的期限 —— 到期后玩家依然能回来，
   * 只是回来时看到的先是「正在托管中 + 重新接管」。
   */
  const windowTimers = new Map<ActiveMatch, Map<number, ReturnType<typeof setTimeout>>>();
  /** 快照落盘的最小间隔；一个时间窗内的多次行动合并成一次写。 */
  const SAVE_INTERVAL_MS = options.saveIntervalMs ?? 2_000;
  /** 断线后人工控制权保留多久，到期自动转托管。 */
  const reconnectWindowMs = options.reconnectWindowMs ?? 120_000;

  // 群聊订阅：一个连接可以同时订阅多个群，一个群也可以有多个连接。
  const groupSubscribers = new Map<string, Set<WebSocketConnection>>();
  const subscriptionsByConnection = new Map<WebSocketConnection, Set<string>>();

  function subscribeToGroup(connection: WebSocketConnection, groupId: string): void {
    let subscribers = groupSubscribers.get(groupId);
    if (!subscribers) {
      subscribers = new Set();
      groupSubscribers.set(groupId, subscribers);
    }
    subscribers.add(connection);
    let groups = subscriptionsByConnection.get(connection);
    if (!groups) {
      groups = new Set();
      subscriptionsByConnection.set(connection, groups);
    }
    groups.add(groupId);
  }

  function unsubscribeFromGroup(connection: WebSocketConnection, groupId: string): void {
    groupSubscribers.get(groupId)?.delete(connection);
    subscriptionsByConnection.get(connection)?.delete(groupId);
  }

  function unsubscribeAllGroups(connection: WebSocketConnection): void {
    for (const groupId of subscriptionsByConnection.get(connection) ?? []) {
      groupSubscribers.get(groupId)?.delete(connection);
    }
    subscriptionsByConnection.delete(connection);
  }

  /**
   * 把群聊变化推给订阅了该群的在线成员。
   *
   * 每次广播都重新确认成员身份，而不是只信订阅那一刻：被移出群的人即便还没来得及退订，
   * 也不会再收到任何消息。
   */
  function broadcastGroupEvent(event: GroupEvent): void {
    if (event.type === "dissolved") {
      // 群已解散（软删除，记录还在但对外不再存在），所有订阅一起作废；
      // 复制一份再遍历，边退订边遍历才安全。
      for (const connection of [...(groupSubscribers.get(event.groupId) ?? [])]) {
        connection.send({ type: "group-dissolved", groupId: event.groupId });
        unsubscribeFromGroup(connection, event.groupId);
      }
      groupSubscribers.delete(event.groupId);
      return;
    }
    if (event.type === "member-removed") {
      for (const connection of [...(groupSubscribers.get(event.groupId) ?? [])]) {
        if (connection.userId !== event.userId) continue;
        unsubscribeFromGroup(connection, event.groupId);
        connection.send({ type: "group-removed", groupId: event.groupId });
      }
      return;
    }
    const group = dependencies.groupService.groups.get(event.groupId);
    if (!group) return;
    for (const connection of groupSubscribers.get(event.groupId) ?? []) {
      if (!connection.userId || !group.members.has(connection.userId)) continue;
      if (event.type === "message") {
        connection.send({ type: "group-message", groupId: event.groupId, message: event.message });
        continue;
      }
      if (event.type === "recalled") {
        connection.send({ type: "group-message-recalled", groupId: event.groupId, message: event.message });
        continue;
      }
      connection.send({
        type: "group-updated",
        groupId: event.groupId,
        ...(event.notice === undefined ? {} : { notice: event.notice }),
        ...(event.allMuted === undefined ? {} : { allMuted: event.allMuted }),
      });
    }
  }

  /**
   * 座位在场状态变了（目前只有 `POST /v1/rooms/:roomId/seat/presence` 会发）。
   *
   * 事件只带"谁在哪一间房变了"，权威状态回房间现读 —— 这里只负责让四家看到。
   * 复用 `broadcastState` 而不是新造一个"轻量帧"，是因为它顺带会重排这一局的自动定时器：
   * 从大厅回到牌桌的那一刻，这一座的节奏就从"断开的座位"恢复成正常的等待，
   * 不需要额外写一遍定时器管理。多带一帧对局数据，不值得为省这点带宽引入第二条广播路径。
   */
  function broadcastSeatEvent(event: SeatEvent): void {
    const active = activeMatches.get(event.roomId);
    if (!active) return;
    // REST 层已经把对局收尾（三票解散）：补发 match-finished、摘除对局，**不要**再广播对局帧。
    if (event.matchClosed) {
      closeFinalizedMatch(active);
      return;
    }
    void broadcastState(active).catch(() => undefined);
  }

  // 订阅跟着进程（或测试里的依赖图）一起存活：事件总线本身是按依赖创建的一次性对象。
  dependencies.groupEvents.subscribe(broadcastGroupEvent);
  dependencies.seatEvents.subscribe(broadcastSeatEvent);

  function clearActionTimers(active: ActiveMatch): void {
    for (const timer of actionTimers.get(active)?.values() ?? []) clearTimeout(timer);
    actionTimers.delete(active);
  }

  /** 撤掉某个座位的"120 秒保留期"定时器（人回来了、或者已经转托管了都不需要它了）。 */
  function clearWindowTimer(active: ActiveMatch, seat: number): void {
    const timers = windowTimers.get(active);
    const timer = timers?.get(seat);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers!.delete(seat);
  }

  /** 整场结束、房间消失时把这一局的所有保留期定时器一起撤掉。 */
  function clearWindowTimers(active: ActiveMatch): void {
    for (const timer of windowTimers.get(active)?.values() ?? []) clearTimeout(timer);
    windowTimers.delete(active);
  }

  function seatEpochOf(active: ActiveMatch, seat: number): number {
    return active.seatEpoch.get(seat) ?? 0;
  }

  /**
   * 这一座现在归谁控制。
   *
   * 从**房间**读（持久化过的权威值），而不是从实时层的任何副本读 ——
   * 服务重启后控制权只能来自数据库，这是"重启后继续托管"成立的唯一依据。
   */
  function controlOf(active: ActiveMatch, seat: number): SeatControl {
    const userId = active.game.players[seat]?.id;
    return (userId ? active.room.players.get(userId)?.control : undefined) ?? "human";
  }

  /**
   * 控制权变了：作废在途的自动定时器，并把新状态发给所有人。
   *
   * ⚠️ 必须在**同一个同步块**里调用，且调用前不要有 `await`：
   * `handleMessage` 是 async，`await verifyUserToken()` 之类会让出事件循环，
   * 状态改到一半就被别的回调插进来，正是"托管与人工同时出牌"的温床。
   */
  async function announceControlChange(active: ActiveMatch, seat: number): Promise<void> {
    // 世代 +1：任何已经排进事件循环队列的自动定时器回调开火时会发现自己过期，直接放弃。
    active.seatEpoch.set(seat, seatEpochOf(active, seat) + 1);
    // `broadcastState` 会重排全部定时器（按新的控制权决定"立刻"还是"15 秒"），
    // 并把带新 control / presence 的权威帧发给四家。
    await broadcastState(active);
  }

  /**
   * 按**墙钟**把保护期已过的座位交给服务器。
   *
   * 内存定时器（`scheduleWindowExpiry`）只是调度手段：它到点提醒我们看一眼，
   * 服务一重启它就不存在了。真正的依据是数据库里的绝对时刻
   * （`reconnect_deadline`，migration 011）—— 所以每次"这一局被加载 / 有人进来 /
   * 有人操作"都重新判一次，答案在任何进程里都一样：
   *
   *   20:00 断线 → deadline = 20:02 → 20:10 才恢复 ⇒ 认定 20:02 已过期，
   *   **不因为"刚重启过"再送一个 120 秒**。
   *
   * **幂等**：域层只返回这次真正被转换的人；没变化时拿到空数组 ⇒ 这里直接返回，
   * **连广播都不发**（否则每次消息都重排一次定时器，等于变相刷新操作超时）。
   * 因此 timer / auth / 操作三个入口同时发现过期也只有一个会真正执行，
   * 不会重复产生游戏动作。
   *
   * @returns 是否真的发了广播（调用方据此省掉紧随其后的那一次重复广播）
   */
  async function settleExpiredSeats(active: ActiveMatch): Promise<boolean> {
    const expired = active.room.expireOverdueControl();
    if (expired.length === 0) return false;
    for (const userId of expired) {
      const seat = active.seatsByUser.get(userId);
      if (seat === undefined) continue;
      // 世代 +1：任何已经排进事件循环队列的自动定时器回调开火时会发现自己过期而放弃，
      // 加上它才不会出现"同一座被代打两次"。
      active.seatEpoch.set(seat, seatEpochOf(active, seat) + 1);
      clearWindowTimer(active, seat);
    }
    await broadcastState(active);
    // 墙钟结算可能正好凑齐提前终局条件（服务重启后恢复的对局尤其靠这里补判 ——
    // 定时器没了，只有按数据库里的绝对时刻重判这一条路）。
    if (abandonmentReached(active)) await terminateAbandonedMatch(active);
    return true;
  }

  /**
   * 提前终局的**唯一判定入口**：判据在域层（`MatchRoom.matchAbandoned`，migration 012），
   * 这里只做守卫拼接 —— 幂等标志、房间还在进行中，两者都满足才继续。
   * 纯读、无副作用，多路调用安全。
   */
  function abandonmentReached(active: ActiveMatch): boolean {
    return !active.terminating && active.room.status === "playing" && active.room.matchAbandoned();
  }

  /**
   * 全员失去有效在线参与时的提前终局动作（migration 012 配套）。
   *
   *   * 全部座位世代 +1 —— 任何已排进事件循环的自动出牌 / 托管回调开火时都会发现自己过期；
   *   * 撤掉这一局的全部定时器（动作 / 120 秒保留期 / 局间停留 / 延迟落盘）；
   *   * `room.abortAbandonedMatch()` → `finalize("dissolved")`：当前小局作废
   *     （**不**走 `recordCompletedRound`，不写积分账、不记 completedRounds），
   *     大局按已完成的小局结算，`PostgresMatchRoom.finalize` 覆写自动落库；
   *   * 给还连着的四家发 `match-finished`（复用整场结算帧的拼装 `matchSettlement`）；
   *   * 清掉这一局的快照（`match_round_states`）、把对局从 `activeMatches` 摘除。
   *
   * 进入即置 `terminating`：从置位到 `abortAbandonedMatch()` 之间没有任何 `await`，
   * 这一段是原子的；之后的重复触发（多路判定、在途回调）都被标志挡住。
   */
  async function terminateAbandonedMatch(active: ActiveMatch): Promise<void> {
    if (active.terminating) return;
    active.terminating = true;
    for (const seat of active.seatsByUser.values()) {
      active.seatEpoch.set(seat, seatEpochOf(active, seat) + 1);
    }
    clearActionTimers(active);
    clearWindowTimers(active);
    clearInterRoundTimer(active);
    cancelSaveTimer(active);
    const matchResult = active.room.abortAbandonedMatch();
    if (!matchResult) return;
    for (const player of active.room.players.values()) dependencies.accountStore.saveAccount(player.account);
    await dependencies.accountStore.flush?.();
    for (const connection of seatConnections.get(active)?.values() ?? []) {
      connection.send({ type: "match-finished", result: matchSettlement(active.room, matchResult) });
    }
    dependencies.gameStateStore?.clear(active.room.roomId);
    activeMatches.delete(active.room.roomId);
    seatConnections.delete(active);
  }

  /**
   * REST 层已把对局 finalize（三票解散），实时层补发终局帧并摘除对局。
   *
   * `voteDissolve` 直接在域层把房间打成 dissolved（积分已结、activeMatchId 已清、
   * 控制权已作废），实时层对这一切一无所知 —— activeMatches 与动作/保留期/局间/落盘
   * 定时器原样残留，托管的 0ms autoAct 会继续推进一个已解散的牌局并反复广播过期帧，
   * 小局打完时更会撞 `recordCompletedRound` 的 "Room is not playing"。
   *
   * 与 {@link terminateAbandonedMatch} 的差别：域层终态**已经就绪**，这里绝不再碰房间，
   * 只清实时层的残留、给还连着的客户端补发 `match-finished`（载荷用房间现成的 `result`）。
   */
  function closeFinalizedMatch(active: ActiveMatch): void {
    if (active.terminating) return;
    active.terminating = true;
    for (const seat of active.seatsByUser.values()) {
      active.seatEpoch.set(seat, seatEpochOf(active, seat) + 1);
    }
    clearActionTimers(active);
    clearWindowTimers(active);
    clearInterRoundTimer(active);
    cancelSaveTimer(active);
    const result = active.room.result;
    if (result) {
      for (const connection of seatConnections.get(active)?.values() ?? []) {
        connection.send({ type: "match-finished", result: matchSettlement(active.room, result) });
      }
    }
    dependencies.gameStateStore?.clear(active.room.roomId);
    activeMatches.delete(active.room.roomId);
    seatConnections.delete(active);
  }

  /** 给一个连接发"我这一座"的完整视角：对局帧 + 当前可用操作。 */
  function sendPlayerState(
    connection: WebSocketConnection,
    active: ActiveMatch,
    seat: number,
  ): void {
    const trustee = controlOf(active, seat) === "trustee";
    connection.send({
      type: "game",
      state: playerSnapshot(active.game, seat, active.room, active.roundNumber, active.actionDeadlineAt),
    });
    // 托管中的座位，对"人工"而言不存在任何可用操作 —— 服务端的动作闸门本来就会拒绝它们
    // （见 handleMessage 里的 SEAT_UNDER_TRUSTEE）。这里直接发空数组，
    // 让两个客户端都不必各自再判一次控制权，也就不会出现"按钮亮着但点了报错"。
    connection.send({
      type: "actions",
      actions: trustee ? [] : active.game.allowedActions(active.game.players[seat]!.id),
    });
  }

  /** 撤掉局间停留的定时器（整场结束、房间被删时用，免得 5 秒后又去广播一个已消失的对局）。 */
  function clearInterRoundTimer(active: ActiveMatch): void {
    const timer = interRoundTimers.get(active);
    if (timer !== undefined) {
      clearTimeout(timer);
      interRoundTimers.delete(active);
    }
  }

  function scheduleAutoActions(active: ActiveMatch): void {
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const game = active.game;
    // 同一局的并行选择阶段共用固定截止时间，某一家提交不延长其他家的时间。
    const preserveDeadline = active.deadlineGame === game
      && active.deadlinePhase === game.phase
      && (game.phase === "swapping" || game.phase === "missing")
      && active.actionDeadlineAt !== undefined;
    if (!preserveDeadline) {
      active.actionDeadlineAt = Date.now() + (game.phase === "claiming" ? claimTimeoutMs : playTimeoutMs);
    }
    active.deadlineGame = game;
    active.deadlinePhase = game.phase;
    for (const player of game.players) {
      const actions = game.allowedActions(player.id);
      if (actions.length === 0) continue;
      // 托管座位**立刻**出牌，不让另外三家白等 15 秒 —— 这是"8 小局不因一人退出而拖延"的关键。
      // 人类座位维持原有超时（15 秒行牌 / 8 秒响应），现有体验一点不变。
      const trustee = controlOf(active, player.seat) === "trustee";
      const delay = trustee ? 0 : Math.max(0, active.actionDeadlineAt! - Date.now());
      // 挂表时记下世代，开火时对不上就放弃（见 ActiveMatch.seatEpoch 的注释）。
      const armedEpoch = seatEpochOf(active, player.seat);
      const timer = setTimeout(() => {
        if (seatEpochOf(active, player.seat) !== armedEpoch) return;
        if (active.game !== game || game.allowedActions(player.id).length === 0) return;
        try {
          game.autoAct(player.id);
          void broadcastState(active).catch(() => undefined);
        } catch {
          // 状态已由另一操作推进时忽略过期定时器。
        }
      }, delay);
      timer.unref();
      timers.set(player.seat, timer);
    }
    actionTimers.set(active, timers);
  }

  /**
   * 座位断线：排一个定时器，到点把这**一座**交给服务器。
   *
   * 只在域层真的排了保留期（`reconnectDeadline`）时才排 —— 已经托管或暂离的座位没有保留期。
   * 到点先问域层"还该转吗"（人可能已经回来了、或者已经主动退出），
   * 域层返回 true 才广播；因此这个定时器**重复触发也无害**。
   *
   * ⚠️ 它是**调度手段，不是真相来源**。真相是数据库里的绝对时刻
   * （`reconnect_deadline`，migration 011）：服务一重启这个定时器就不存在了，
   * 而那个时刻还在 —— 所以另有 `settleExpiredSeats()` 在"有人进来 / 有人操作"时按墙钟重判。
   * 两条路径走的是同一个域层判断，因此不会打架、也不会重复动作。
   */
  /**
   * 窗口定时器到点的一次判定。被 {@link scheduleWindowExpiry} 与它的重试定时器共用。
   *
   * 域层返回 true（真的转了托管）才广播并顺带判一次提前终局；
   * 返回 false 时分两种情况：
   *   * 座位已不可转（人回来了 / 已托管 / 对局已结束）→ 静默退出，什么都不做；
   *   * 座位**仍该转**（人工 + 有保留期 + 对局中）→ 这是定时器与墙钟的错位：
   *     定时器按单调钟计时，域层按墙钟（`reconnectDeadline`）判死线，NTP 微调/步进
   *   会让两者错开约 1ms，到点瞬间墙钟可能还没到 deadline。补一个短重试定时器
   *   （10ms，幂等），直到墙钟追上或座位不再该转为止 —— 否则这个座位会永远卡在
   *   人工控制上（四人全断线时没有任何消息会再触发墙钟重判，对局就此挂死）。
   */
  function windowExpiryTick(active: ActiveMatch, seat: number, userId: string): void {
    windowTimers.get(active)?.delete(seat);
    if (!active.room.expireReconnectWindow(userId)) {
      const player = active.room.players.get(userId);
      if (player && active.room.status === "playing"
        && player.control === "human" && player.reconnectDeadline) {
        const retry = setTimeout(() => windowExpiryTick(active, seat, userId), 10);
        retry.unref();
        let timers = windowTimers.get(active);
        if (!timers) {
          timers = new Map();
          windowTimers.set(active, timers);
        }
        timers.set(seat, retry);
      }
      return;
    }
    active.seatEpoch.set(seat, seatEpochOf(active, seat) + 1);
    void broadcastState(active).catch(() => undefined);
    // 最后一个保护期到点 = 条件 B（全员失联且都已过保护期 / 已退出）可能成立的时刻。
    // 判据仍是域层墙钟；没凑齐时这里是无副作用的纯读。
    if (abandonmentReached(active)) {
      void terminateAbandonedMatch(active).catch(() => undefined);
    }
  }

  function scheduleWindowExpiry(active: ActiveMatch, seat: number, userId: string): void {
    clearWindowTimer(active, seat);
    const deadline = active.room.players.get(userId)?.reconnectDeadline;
    if (!deadline) return;
    const timer = setTimeout(() => windowExpiryTick(active, seat, userId),
      Math.max(0, deadline.getTime() - Date.now()));
    timer.unref();
    let timers = windowTimers.get(active);
    if (!timers) {
      timers = new Map();
      windowTimers.set(active, timers);
    }
    timers.set(seat, timer);
  }

  /**
   * 保存这一局的快照，供进程重启后接着打。
   *
   * 快照含牌墙与全部手牌，只留在服务端。写入走共享写队列，所以 WS 操作本身不等落盘；
   * REST 请求结束时的 flush 会把队列里积压的快照一并排干。
   *
   * 节流：每次行动都写盘是几十次/局的写放大，而快照只在「进程崩溃」那一刻才被读到。
   * 所以按时间窗合并 —— 距上次落盘不足 {@link SAVE_INTERVAL_MS} 就只标脏，由延迟定时器
   * 到点补写；最后一把手最迟一个时间窗后也会落盘，重启不会丢超过这一步的进度。
   */
  function saveRoundState(active: ActiveMatch): void {
    const store = dependencies.gameStateStore;
    if (!store) return;
    const now = Date.now();
    active.stateDirty = true;
    const elapsed = active.lastSavedAt === undefined ? Infinity : now - active.lastSavedAt;
    if (elapsed >= SAVE_INTERVAL_MS) {
      flushRoundState(active);
      return;
    }
    if (!saveTimers.has(active)) {
      const timer = setTimeout(() => {
        saveTimers.delete(active);
        if (active.stateDirty) flushRoundState(active);
      }, SAVE_INTERVAL_MS - elapsed);
      timer.unref();
      saveTimers.set(active, timer);
    }
  }

  /** 立即把当前状态写盘，并清掉节流状态。对局结束等「必须落盘」的时刻用它。 */
  function flushRoundState(active: ActiveMatch): void {
    const store = dependencies.gameStateStore;
    if (!store) return;
    const pending = saveTimers.get(active);
    if (pending) {
      clearTimeout(pending);
      saveTimers.delete(active);
    }
    active.stateDirty = false;
    active.lastSavedAt = Date.now();
    store.save(active.room.roomId, active.roundNumber, active.game.serialize());
  }

  /** 取消进行中对局的延迟落盘定时器；对局结束时调用，避免定时器写进一个已结束的对局。 */
  function cancelSaveTimer(active: ActiveMatch): void {
    const pending = saveTimers.get(active);
    if (pending) {
      clearTimeout(pending);
      saveTimers.delete(active);
    }
    active.stateDirty = false;
  }

  async function broadcastState(active: ActiveMatch): Promise<void> {
    // 提前终局后的在途回调（托管定时器、断线广播、群/座位事件）到这里一律直接返回：
    // 对局已从 activeMatches 摘除，再广播只会发出一个已 dissolved 房间的过期帧。
    if (active.terminating) return;
    clearActionTimers(active);
    const seatMap = seatConnections.get(active);
    const game = active.game;
    if (game.phase === "finished" && game.result) {
      // ⚠️ 幂等闸：局间停留期间 `active.game` **仍然是刚结束的那一局**，
      // 而「剩余动作 / 托管定时器 / 重连」都还会再走到这里 —— 没有这道闸就会重复发
      // round-finished、重复 +1 completedRounds、并开出好几局新牌。
      if (interRoundTimers.has(active)) return;
      const roundResult = roundSettlement(game, { room: active.room, roundNumber: active.roundNumber });
      for (const connection of seatMap?.values() ?? []) {
        connection.send({
          type: "round-finished",
          roundNumber: active.roundNumber,
          result: roundResult,
          // 告诉客户端还要等多久才开下一局 —— 结算界面据此显示倒计时。
          // 不能只让客户端硬编码 5 秒：停留时长是服务端的配置（测试里是 0）。
          nextRoundInMs: interRoundPauseMs,
        });
      }
      const matchResult = active.room.recordCompletedRound({ ...roundResult, events: [...game.events] });
      if (matchResult) {
        for (const player of active.room.players.values()) dependencies.accountStore.saveAccount(player.account);
        await dependencies.accountStore.flush?.();
        for (const connection of seatMap?.values() ?? []) {
          // 载荷的拼装在 `matchSettlement`（那里排好座位、补上时间戳与四行明细）。
          connection.send({ type: "match-finished", result: matchSettlement(active.room, matchResult) });
        }
        dependencies.gameStateStore?.clear(active.room.roomId);
        clearInterRoundTimer(active);
        cancelSaveTimer(active);
        clearWindowTimers(active);
        activeMatches.delete(active.room.roomId);
        seatConnections.delete(active);
        return;
      }
      active.roundNumber += 1;
      // 旧局已结算，其存档不再有意义；取消悬挂的延迟写，交给新局重新安排。
      cancelSaveTimer(active);
      const nextDealerSeat = roundResult.nextDealerSeat;

      // 局间停留：先把这一局的结算看清楚，再开下一局。
      //
      // 不在这里 `await sleep` —— `broadcastState` 被多方调用（每次动作、每个托管定时器），
      // 睡在里面会把整个房间的响应一起拖住。改成定时器，并用「每个对局至多一个定时器」
      // （就是上面那道闸）保证重入幂等。
      if (interRoundPauseMs <= 0) {
        // 测试路径：与加停留之前完全一致，立刻开下一局。
        // 但开之前先看一眼终局条件 —— 停留（哪怕 0 毫秒）期间凑齐了全员放弃，就该收尾而不是开下一局。
        if (abandonmentReached(active)) {
          await terminateAbandonedMatch(active);
          return;
        }
        active.game = new MahjongGame(
          randomInt(0, 2 ** 31),
          [...active.seatsByUser.keys()] as [string, string, string, string],
          nextDealerSeat,
        );
        await broadcastState(active);
        return;
      }
      const timer = setTimeout(() => {
        interRoundTimers.delete(active);
        // 局间停留期间凑齐了终局条件（停留中最后一人退出/断线过保护期）：收尾，不开下一局。
        if (abandonmentReached(active)) {
          void terminateAbandonedMatch(active).catch(() => undefined);
          return;
        }
        active.game = new MahjongGame(
          randomInt(0, 2 ** 31),
          [...active.seatsByUser.keys()] as [string, string, string, string],
          nextDealerSeat,
        );
        void broadcastState(active).catch(() => undefined);
      }, interRoundPauseMs);
      timer.unref();
      interRoundTimers.set(active, timer);
      return;
    }
    scheduleAutoActions(active);
    for (const [seat, connection] of seatMap ?? []) {
      sendPlayerState(connection, active, seat);
    }
    saveRoundState(active);
  }

  async function startMatch(room: MatchRoom): Promise<void> {
    // Seats are owned by the room and fixed in `room.start()`, so the table layout the players see
    // is the one that gets persisted. The engine still needs them as a dense 0..3 tuple.
    const seated = [...room.players.values()].sort((left, right) => (left.seat ?? -1) - (right.seat ?? -1));
    if (seated.length !== 4 || seated.some((player) => player.seat === undefined)) {
      throw new Error("Every player must have a seat before the match starts");
    }
    const seatsByUser = new Map<string, number>();
    seated.forEach((player) => seatsByUser.set(player.account.userId, player.seat!));
    const game = new MahjongGame(
      randomInt(0, 2 ** 31),
      seated.map((player) => player.account.userId) as [string, string, string, string],
    );
    const active: ActiveMatch = { room, game, seatsByUser, roundNumber: room.completedRounds + 1, seatEpoch: new Map() };
    activeMatches.set(room.roomId, active);

    const seatMap = new Map<number, WebSocketConnection>();
    for (const [userId, connection] of roomConnections(room.roomId)) {
      const seat = seatsByUser.get(userId);
      if (seat !== undefined) seatMap.set(seat, connection);
    }
    seatConnections.set(active, seatMap);
    for (const player of room.players.values()) dependencies.accountStore.saveAccount(player.account);
    await dependencies.accountStore.flush?.();
    await broadcastState(active);
  }

  /**
   * 接手一个「状态是 playing、但内存里还没有对局」的房间。
   *
   * 出现这种情况要么是服务重启（房间从数据库恢复，引擎随内存一起没了），要么是房主刚通过
   * REST 开局、还没有人连上来。
   *
   * 有存档就接着打；没有存档、存档属于已经打完的上一局、或存档与房间对不上，就开下一局。
   * 累计分与已完成局数都在房间里，所以开下一局仍然是对的，只是正在打的那一局作废。
   */
  async function resumeMatch(room: MatchRoom): Promise<"restored" | "started"> {
    const stored = await dependencies.gameStateStore?.load(room.roomId);
    // 只有「正好是接下来要打的那一局」的存档能接上。上一局的存档必须忽略：接上去会把已经
    // 结算过的分数再算一遍，还会把同一局重复记进战绩。
    if (stored && stored.roundNumber === room.completedRounds + 1 && adoptStoredRound(room, stored)) {
      return "restored";
    }
    await startMatch(room);
    return "started";
  }

  /** 用存档重建引擎并挂进 `activeMatches`。存档不可用或与房间对不上时返回 false。 */
  function adoptStoredRound(room: MatchRoom, stored: StoredRoundState): boolean {
    let game: MahjongGame;
    try {
      game = MahjongGame.restore(stored.state);
    } catch {
      // 存档损坏：当作没有存档，由调用方开下一局。
      return false;
    }
    const seated = [...room.players.values()].sort((left, right) => (left.seat ?? -1) - (right.seat ?? -1));
    const sameTable = seated.length === 4
      && seated.every((player, seat) => player.seat === seat && game.players[seat]?.id === player.account.userId);
    if (!sameTable) return false;

    const seatsByUser = new Map<string, number>();
    seated.forEach((player) => seatsByUser.set(player.account.userId, player.seat!));
    const active: ActiveMatch = { room, game, seatsByUser, roundNumber: stored.roundNumber, seatEpoch: new Map() };
    activeMatches.set(room.roomId, active);

    const seatMap = new Map<number, WebSocketConnection>();
    for (const [userId, connection] of roomConnections(room.roomId)) {
      const seat = seatsByUser.get(userId);
      if (seat !== undefined) seatMap.set(seat, connection);
    }
    seatConnections.set(active, seatMap);
    return true;
  }

  async function handleMessage(connection: WebSocketConnection, message: WsMessage): Promise<void> {
    if (message.type === "auth") {
      const token = message.token as string;
      // `roomId` 可以省略：只想订阅群聊的连接不需要绑房间。
      const roomId = message.roomId as string | undefined;
      if (!token) return sendError(connection, "auth requires a token");
      let userId: string;
      try {
        userId = await dependencies.tokens.verifyUserToken(token);
      } catch {
        return sendError(connection, "INVALID_USER_TOKEN");
      }
      const account = dependencies.accountStore.findAccountById(userId);
      if (!account || account.status !== "active") return sendError(connection, "ACCOUNT_NOT_ACTIVE");
      if (!roomId) {
        // 只订阅群聊的连接：认证通过就够了，不需要房间。
        connection.userId = userId;
        connection.send({ type: "ready", userId });
        return;
      }
      const room = dependencies.roomStore.get(roomId);
      if (!room) return sendError(connection, "ROOM_NOT_FOUND");
      if (!room.players.has(userId)) return sendError(connection, "Player is not in the room");

      connection.userId = userId;
      connection.roomId = roomId;
      const beforeReconnect = activeMatches.get(roomId);
      const beforeSeat = beforeReconnect?.seatsByUser.get(userId);
      /** reconnect 是否就地转了托管（120 秒保留期已过的失联玩家）。 */
      let reconnected = false;
      try {
        // 返回值 = 120 秒保留期已过，控制权就地交给了服务器（域层同步落库）。
        reconnected = room.reconnect(userId);
        if (reconnected && beforeReconnect && beforeSeat !== undefined) {
          beforeReconnect.seatEpoch.set(beforeSeat, seatEpochOf(beforeReconnect, beforeSeat) + 1);
        }
      } catch (error) {
        delete connection.userId;
        delete connection.roomId;
        return sendError(connection, error instanceof Error ? error.message : String(error));
      }
      // 人回到牌桌了：清掉暂离标记（`presence` 立刻变回 online），保留期定时器也不再需要。
      const returnedFromLobby = room.markAway(userId, false);
      roomConnections(roomId).set(userId, connection);

      if (room.status === "playing" && !activeMatches.has(roomId)) {
        // 服务重启后进行中的对局会走到这里：先试着接手存档，接不上再开下一局。
        try {
          // `startMatch` 自己会向所有座位广播状态；接手存档则要继续往下走，把快照发给这个连接。
          if ((await resumeMatch(room)) === "started") return;
        } catch (error) {
          sendError(connection, error instanceof Error ? error.message : String(error));
          return;
        }
      }
      const active = activeMatches.get(roomId);
      if (active) {
        const seat = active.seatsByUser.get(userId)!;
        const seatMap = seatConnections.get(active) ?? new Map();
        seatMap.set(seat, connection);
        seatConnections.set(active, seatMap);
        clearWindowTimer(active, seat);
        // 整房按墙钟结算。服务重启后没人排得上定时器，这里就是补上它的地方：
        // 20:00 断线、deadline 20:02、20:10 才恢复 ⇒ 此刻就认定"已过期"，
        // 不因为"刚重启过"再送一个 120 秒。返回的 true 表示它已经广播过一次。
        const settled = await settleExpiredSeats(active);
        // 墙钟结算可能已触发提前终局：对局已摘除，match-finished 已发，不再发对局帧。
        if (active.terminating) return;
        sendPlayerState(connection, active, seat);
        // 另外三家也要立刻看到「暂离」消失 —— 上面那一发只发给回来的本人。
        // `reconnected`（失联超期、就地转托管）**同样必须全场广播**：广播是
        // `scheduleAutoActions` 的唯一入口，缺了它，被 epoch bump 作废的旧 action timer
        // 不会有新 timer 顶上 —— 该座位若正持有唯一待决动作（claiming 的 claimant /
        // playing 的当前出牌人），整局就停在"四家 actions 全空"上无人推进（真实卡死复现）。
        if ((returnedFromLobby || reconnected) && !settled) await broadcastState(active);
      } else {
        connection.send({ type: "room", status: room.status, playerCount: room.players.size });
      }
      return;
    }

    // 认证只在握手时做过一次，而账号可能在牌局中途被封禁或注销。
    // 每次操作都重新确认一次，否则「立即生效」只是句空话 —— socket 开着的人还能接着打。
    if (!connection.userId) return sendError(connection, "Not authenticated");
    const actor = dependencies.accountStore.findAccountById(connection.userId);
    if (!actor || actor.status !== "active") {
      sendError(connection, "ACCOUNT_NOT_ACTIVE");
      connection.close();
      return;
    }

    if (message.type === "group-subscribe") {
      if (!connection.userId) return sendError(connection, "Not authenticated");
      const groupId = message.groupId as string;
      if (!groupId) return sendError(connection, "group-subscribe requires groupId");
      const group = dependencies.groupService.groups.get(groupId);
      if (!group) return sendError(connection, "GROUP_NOT_FOUND");
      if (!group.members.has(connection.userId)) return sendError(connection, "User is not a group member");
      subscribeToGroup(connection, groupId);
      connection.send({ type: "group-subscribed", groupId });
      return;
    }

    if (message.type === "group-unsubscribe") {
      const groupId = message.groupId as string;
      if (!groupId) return sendError(connection, "group-unsubscribe requires groupId");
      unsubscribeFromGroup(connection, groupId);
      connection.send({ type: "group-unsubscribed", groupId });
      return;
    }

    if (message.type === "start") {
      if (!connection.userId || !connection.roomId) return sendError(connection, "Not authenticated");
      const room = dependencies.roomStore.get(connection.roomId);
      if (!room) return sendError(connection, "ROOM_NOT_FOUND");
      if (activeMatches.has(room.roomId)) return sendError(connection, "Match has already started");
      if (room.status === "waiting") {
        try {
          room.start(connection.userId);
        } catch (error) {
          return sendError(connection, error instanceof Error ? error.message : String(error));
        }
      } else if (room.status !== "playing") {
        return sendError(connection, "Room is not playable");
      }
      try {
        await startMatch(room);
      } catch (error) {
        return sendError(connection, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (!connection.userId || !connection.roomId) return sendError(connection, "Not authenticated");
    const active = activeMatches.get(connection.roomId);
    if (!active) return sendError(connection, "Match has not started");
    // 每一次操作前都按墙钟重判一次保护期。没过期时这是零副作用（连广播都不发），
    // 过期时这一座当场转托管，下面的控制权闸门随即拒绝它的动作 ——
    // 于是"到点了还没回来"在任何一条路径上都不会漏判，也不会重复判。
    await settleExpiredSeats(active);
    // 墙钟结算可能已触发提前终局：房间已 dissolved，后续动作一律不再受理
    // （match-finished 已经发出，客户端此刻应停在结算界面）。
    if (active.terminating) return;
    const game = active.game;
    const seat = active.seatsByUser.get(connection.userId);
    if (seat === undefined) return sendError(connection, "Not seated in this match");
    const player = game.players[seat]!;

    /**
     * 退出游戏：把这一座交给服务器托管。
     *
     * 与「返回大厅」的区别就在这里 —— 返回大厅只是暂离（presence = away，控制权还在玩家手上），
     * 退出游戏是 control 直接转 TRUSTEE，**不等 120 秒**（那是异常断线的口径）。
     * 不删玩家、不删座位、不动手牌与积分，大局归属也不变。
     *
     * 幂等：重复点（网络重发、手抖点两次）第二次返回 false，客户端照样收到当前状态。
     */
    if (message.type === "quit") {
      if (active.room.status !== "playing") return sendError(connection, "MATCH_NOT_ACTIVE");
      if (active.room.players.get(connection.userId)?.seat !== seat) {
        return sendError(connection, "SEAT_NOT_OWNED");
      }
      const quitChanged = active.room.quitToTrustee(connection.userId);
      if (quitChanged) clearWindowTimer(active, seat);
      // 全员放弃判定放在广播**之前**：第 4 个人点退出时不再走「广播新控制权 → 重排
      // 托管定时器 → 4 个托管自动打完剩下的局」，而是当场收尾发 match-finished。
      // 这正是真实测试暴露的问题（4 人全部退出后托管自动打到第 7/8 局）的修复点。
      if (abandonmentReached(active)) {
        await terminateAbandonedMatch(active);
        return;
      }
      if (quitChanged) await announceControlChange(active, seat);
      sendPlayerState(connection, active, seat);
      return;
    }

    /**
     * 重新接管：control 从 TRUSTEE 拿回 HUMAN。
     *
     * **进入房间 ≠ 接管** —— 握手成功只把 `connected` 置真，控制权仍在服务器手上；
     * 必须由玩家显式点「重新接管」才转换。所以这里是唯一能把座位交还人工的入口。
     *
     * 全部校验都由服务端自己做，客户端传什么都不作数：
     * token（外层已验过）、是这间房的玩家、座位归属没被改过、大局仍在进行、当前确实是托管。
     */
    if (message.type === "request_takeover") {
      if (active.room.status !== "playing") return sendError(connection, "MATCH_NOT_ACTIVE");
      const roomPlayer = active.room.players.get(connection.userId);
      if (!roomPlayer || roomPlayer.seat === undefined || roomPlayer.seat !== seat) {
        return sendError(connection, "SEAT_NOT_OWNED");
      }
      if (active.room.resumeControl(connection.userId)) {
        await announceControlChange(active, seat);
      }
      // 幂等回执：无论这次是否真的发生转换，都给请求者一份当前权威状态，
      // 免得它停在"点过了但界面没变"。局间停留阶段 `broadcastState` 会提前返回，这一发更必要。
      sendPlayerState(connection, active, seat);
      return;
    }

    /**
     * 控制权闸门：托管中的座位**只接受**「重新接管」，其余动作一律拒绝。
     *
     * 这是"同一个座位任何时刻只有一个控制来源"的业务侧保证 ——
     * 光靠前端把牌桌置灰不够，关掉前端照样能发帧。
     */
    if (controlOf(active, seat) === "trustee") {
      return sendError(connection, "SEAT_UNDER_TRUSTEE");
    }

    try {
      switch (message.type) {
        case "swap":
          game.submitSwap(player.id, message.tiles as Tile[]);
          break;
        case "auto-swap":
          game.autoSwap(player.id);
          break;
        case "missing":
          game.submitMissing(player.id, message.suit as Suit);
          break;
        case "auto-missing":
          game.autoMissing(player.id);
          break;
        case "discard":
          game.discard(player.id, message.tile as Tile);
          break;
        case "claim":
          game.claim(player.id, message.action as ClaimAction);
          break;
        case "self-draw":
          game.selfDrawWin(player.id);
          break;
        case "concealed-kong":
          game.concealedKong(player.id);
          break;
        case "added-kong":
          game.addedKong(player.id);
          break;
        default:
          return sendError(connection, `Unknown message type: ${message.type}`);
      }
    } catch (error) {
      return sendError(connection, error instanceof Error ? error.message : String(error));
    }

    await broadcastState(active);
  }

  const server = new WebSocketServer({
    onMessage: handleMessage,
    onClose(connection) {
      unsubscribeAllGroups(connection);
      if (!connection.userId || !connection.roomId) return;
      const roomMap = roomConnections(connection.roomId);
      if (roomMap.get(connection.userId) !== connection) return;
      roomMap.delete(connection.userId);
      const room = dependencies.roomStore.get(connection.roomId);
      room?.disconnect(connection.userId, reconnectWindowMs);
      const active = activeMatches.get(connection.roomId);
      if (active) {
        const seat = active.seatsByUser.get(connection.userId);
        if (seat !== undefined) seatConnections.get(active)?.delete(seat);
        // 域层只有在"人工控制且没有暂离"时才排了保留期；有保留期就排个定时器，
        // 到点把这一座交给服务器（120 秒是保留人工控制权的时间，不是禁止进入的时间）。
        if (seat !== undefined && connection.userId) {
          scheduleWindowExpiry(active, seat, connection.userId);
        }
        // 另外三家要看到这一座"人走了"：纯掉线显示「掉线」，暂离中的人断开仍显示「暂离」
        // （`presenceOf` 里暂离优先于连接状态 —— 他明确说过自己还会回来）。
        void broadcastState(active).catch(() => undefined);
        // 断开可能正好凑齐终局条件（例如「3 人已退出 + 第 4 人本就已托管后断开」）。
        // 刚掉线的人工座位带 120 秒保护期，域层判据会正确地暂不终止 —— 那要等
        // `scheduleWindowExpiry` 的定时器到点再判（条件 B 走的就是这条路）。
        if (abandonmentReached(active)) {
          void terminateAbandonedMatch(active).catch(() => undefined);
        }
      }
    },
  }, mode);

  // 进程要走了：把每局还没到点的延迟落盘立刻写掉（节流的补偿，不是持久化的替代）。
  server.flushRoundStates = () => {
    for (const active of activeMatches.values()) {
      if (active.stateDirty) flushRoundState(active);
    }
  };
  return server;
}
