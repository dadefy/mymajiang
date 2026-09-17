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
import type { MatchRoom, RoomResult } from "@mianyang-mahjong/domain";
import type { AppDependencies } from "./app.js";
import type { StoredRoundState } from "./game-state-store.js";
import type { GroupEvent } from "./group-events.js";
import { maskMelds } from "./meld-visibility.js";
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
  return {
    roomId: room.roomId,
    roundNumber,
    /** 一整局共几小场（8）。客户端显示「第 N/8 小场」用，省得两边各写一个 8。 */
    totalRounds: MIANYANG_XZ_1_0.rounds,
    actionDeadlineAt,
    seat,
    phase: game.phase,
    dealerSeat: game.dealerSeat,
    currentPlayerSeat: game.currentPlayerSeat,
    tilesLeft: game.tilesLeft,
    hand: [...(player.won ? player.winningHand : player.hand)],
    melds: [...player.melds],
    missingSuit: player.missingSuit,
    discards: [...player.discards],
    won: player.won,
    players: game.players.map((other) => ({
      seat: other.seat,
      avatarUrl: room.players?.get(other.id)?.account.avatarUrl,
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
    })),
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
  /** 快照落盘的最小间隔；一个时间窗内的多次行动合并成一次写。 */
  const SAVE_INTERVAL_MS = options.saveIntervalMs ?? 2_000;

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

  // 订阅跟着进程（或测试里的依赖图）一起存活：事件总线本身是按依赖创建的一次性对象。
  dependencies.groupEvents.subscribe(broadcastGroupEvent);

  function clearActionTimers(active: ActiveMatch): void {
    for (const timer of actionTimers.get(active)?.values() ?? []) clearTimeout(timer);
    actionTimers.delete(active);
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
      const delay = Math.max(0, active.actionDeadlineAt! - Date.now());
      const timer = setTimeout(() => {
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
      const player = game.players[seat]!;
      connection.send({ type: "game", state: playerSnapshot(game, seat, active.room, active.roundNumber, active.actionDeadlineAt) });
      connection.send({ type: "actions", actions: game.allowedActions(player.id) });
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
    const active: ActiveMatch = { room, game, seatsByUser, roundNumber: room.completedRounds + 1 };
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
    const active: ActiveMatch = { room, game, seatsByUser, roundNumber: stored.roundNumber };
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
      try {
        room.reconnect(userId);
      } catch (error) {
        delete connection.userId;
        delete connection.roomId;
        return sendError(connection, error instanceof Error ? error.message : String(error));
      }
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
        connection.send({ type: "game", state: playerSnapshot(active.game, seat, room, active.roundNumber, active.actionDeadlineAt) });
        connection.send({ type: "actions", actions: active.game.allowedActions(active.game.players[seat]!.id) });
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
    const game = active.game;
    const seat = active.seatsByUser.get(connection.userId);
    if (seat === undefined) return sendError(connection, "Not seated in this match");
    const player = game.players[seat]!;

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

  return new WebSocketServer({
    onMessage: handleMessage,
    onClose(connection) {
      unsubscribeAllGroups(connection);
      if (!connection.userId || !connection.roomId) return;
      const roomMap = roomConnections(connection.roomId);
      if (roomMap.get(connection.userId) !== connection) return;
      roomMap.delete(connection.userId);
      dependencies.roomStore.get(connection.roomId)?.disconnect(connection.userId);
      const active = activeMatches.get(connection.roomId);
      if (active) {
        const seat = active.seatsByUser.get(connection.userId);
        if (seat !== undefined) seatConnections.get(active)?.delete(seat);
      }
    },
  }, mode);
}
