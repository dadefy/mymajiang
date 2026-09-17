/**
 * 服务端 REST 响应与 WebSocket 帧的类型镜像。
 *
 * 这些形状必须与 `apps/server` 一一对应；服务端改字段时这里是第一个要改的地方，
 * 客户端的测试会因此失败 —— 这是有意的：两端协议漂移要在编译和测试阶段暴露。
 */

export type Suit = "wan" | "tong" | "tiao";
export type Tile = number;

export interface SessionView {
  userId: string;
  nickname: string;
  avatarUrl: string;
  status: "active" | "temporarily_banned" | "permanently_banned" | "deleted";
  points: number;
  /**
   * 进行中的对局；没有对局、或那一局已经打完时为 null。
   *
   * 服务端只在这间房**还能回去**（waiting / playing，且房间还在）时才给 ——
   * 客户端不必自己判断，直接据此显示「回到房间」入口。
   */
  activeRoom: ActiveRoomView | null;
  token: string;
}

/**
 * `GET /v1/me`：当前账号的最新状态。与登录返回的 `SessionView` 同形，只是不带令牌。
 *
 * 存在的理由是**积分**：账号积分只在整局结算那一刻改，而客户端手里的 session 是开局前
 * 登录那一刻的快照 —— 打完一整局回首页，不重新拉一次就还是旧余额，看着像「分没进账」。
 */
export type MeView = Omit<SessionView, "token">;

/** 账号上挂着的、还能回去的那一局。 */
export interface ActiveRoomView {
  roomId: string;
  /** 6 位数字房间号：显示给人看、让人念的就是它。 */
  roomNo: string;
  status: "waiting" | "playing";
  playerCount: number;
}

export interface PublicUser {
  userId: string;
  nickname: string;
  avatarUrl: string;
  /** 只有精确搜索会带：none / pending / friends。 */
  relationship?: string;
}

export interface FriendRequestView {
  requestId: string;
  fromUserId: string;
  fromNickname: string;
  toUserId: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface RoomPlayerView {
  avatarUrl?: string;
  userId: string;
  nickname: string;
  points: number;
  ready: boolean;
  connected: boolean;
  disconnectedAt: string | null;
  reconnectDeadline: string | null;
}

export interface RoomSnapshot {
  roomId: string;
  /** 6 位数字房间号：界面上要显示、要转述的都是它，`roomId` 只是内部标识。 */
  roomNo: string;
  ruleVersion: string;
  status: "waiting" | "playing" | "finished" | "dissolved";
  ownerId: string;
  completedRounds: number;
  players: RoomPlayerView[];
  /**
   * 整场结果。**不是单局的那个 `RoomResult`** —— 服务端 `roomSnapshot()` 送的是
   * `room.result`，也就是域层的整场结果（`rawDeltas` + `accountDeltas`）。
   * 这里原先写成单局形状，属于协议漂移（同样是两个包各自命名 `RoomResult` 造成的）；
   * 目前没有调用方读它，所以改对不会牵动任何界面。
   */
  result: MatchResult | null;
}

/**
 * 一位赢家的明细：胡牌类型与是谁给的牌。形状来自 `packages/rules` 的 `WinDetail`。
 *
 * `wins` 是随单局结算一起下发的（服务端 `roundSettlement` 里 `...result` 展开），
 * 按**胡牌先后**排列 —— 血战到底一局可能有三家胡。流局时为空。
 */
export interface WinDetail {
  seat: number;
  method: "self-draw" | "discard";
  /** 点炮（放炮）者的座位；自摸时为 null。 */
  fromSeat: number | null;
  /** 胡的那张牌来自别人时给牌值；自摸为 null。 */
  fromTile: Tile | null;
  /** 番型明细，名字已是中文（「对对胡」「清一色」「自摸」「平胡」…）。 */
  items: Array<{ code: string; name: string; fan: number }>;
  /** 各番相加、未封顶的番数。 */
  rawFan: number;
  /** 封顶后的番数（封顶 4 番）。 */
  finalFan: number;
  paymentPerOpponent: number;
  /** 一共几家付了这份分（自摸时可能少于三家 —— 已胡的人不再付）。 */
  payerCount: number;
  /** 实收总分。 */
  points: number;
}

/** **单局**（一小场）结算。字段来自 `packages/rules` 的 `RoundResult`。 */
export interface RoomResult {
  /**
   * 这是第几小场（从 1 起）、一整局共几小场。
   * 一小场结束的弹窗要显示「第 3/8 小场」，所以得有这两个数。
   */
  roundNumber?: number;
  totalRounds?: number;
  /** 仅在本局结束后下发；旧服务端可能不提供。 */
  players?: Array<{
    playerId: string;
    seat: number;
    won: boolean;
    hand: Tile[];
    melds: Array<{ kind: "pong" | "kong"; tile: Tile; concealed?: boolean }>;
    /**
     * **含本小场在内**的整局累计净输赢。
     *
     * 局间停留时服务端不再发对局帧，客户端手上那帧的 `matchDelta` 差着本小场的最后一个
     * 事件（例如最后那家胡牌的收分），所以局间的头像要用这里的值。
     */
    matchDelta?: number;
  }>;
  /** 每位赢家胡了什么、谁给的牌；旧服务端可能不提供。 */
  wins?: WinDetail[];
  reason: "three-winners" | "wall-exhausted" | "dissolved";
  deltas: Array<{ playerId: string; delta: number }>;
  winnerSeats: number[];
  nextDealerSeat: number;
}

/**
 * **整场**结算。字段来自 `packages/domain` 的 `RoomResult` —— 与上面那个**同名但形状不同**。
 *
 * 两者是在不同层次各自命名的（一个在规则包、一个在域包），到了协议层撞在了一起。
 * 之前协议层只有单局那一个形状，`match-finished` 送来的整场结果被当成单局读，
 * `result.deltas` 取到 undefined —— 三个客户端**都在整场结束时抛异常**：
 * `/multi` 的中央区、`/debug` 的结算块、`/apk` 的结算浮层一起废掉。
 * 所以这里必须分成两个类型，由编译器挡住误用。
 */
/**
 * 结算记录里**一行玩家明细**（整局结束界面上那 4 行）。
 *
 * 形状在服务端拼好：昵称/头像在房间成员上、本局得失分在 `rawDeltas` 里、
 * 入账分与余额要等 `finalize()` 写完账号之后才有 —— 只有服务端那一侧能同时拿到，
 * 所以这 4 行**不经客户端拼装**，直接照着渲染（客户端手里的 session 是开局前的快照）。
 */
export interface MatchResultPlayer {
  /** 10 位数字 id 号。 */
  playerId: string;
  nickname: string;
  avatarUrl: string;
  /** 座位号 0..3，服务端已按它排好序（开局时按加入顺序定死）。 */
  seat: number;
  /** 本局（整场 8 小场）未封顶的净输赢。 */
  delta: number;
  /** 实际写入账号的分；与 `delta` 不同说明触发了封顶或负分保护。 */
  accountDelta: number;
  /** 入账之后的账号余额。 */
  balance: number;
}

export interface MatchResult {
  roomId: string;
  completedRounds: number;
  reason: "completed" | "dissolved";
  rawDeltas: Array<{ playerId: string; delta: number }>;
  accountDeltas: Array<{ playerId: string; delta: number }>;
  /**
   * 本场（一整局）**开局**时刻的毫秒时间戳，随 `match-finished` 帧下发。
   *
   * 是开局那一刻（四家准备好、房主点开始），**不是**建房时刻 —— 房间可以先建着等人。
   * 服务端没下发（旧服务端、或房间记录缺这个字段）时为 undefined。
   */
  startedAt?: number;
  /** 结算时刻的毫秒时间戳；与 `startedAt` 一起算「本局耗时」。 */
  finishedAt?: number;
  /**
   * 四位玩家的明细，已按座位排好序。
   *
   * 之所以要服务端给：客户端手里的 session 是开局前登录的快照，
   * 看不到入账后的余额，也拿不到已经结束的房间快照（房间已结束）。
   */
  players?: MatchResultPlayer[];
}

export interface MatchPlayerView {
  userId: string;
  nickname: string | null;
  seat: number;
  rawDelta: number;
  accountDelta: number;
}

export interface MatchSummary {
  roomId: string;
  ruleVersion: string;
  status: "finished" | "dissolved";
  completedRounds: number;
  finalReason: string;
  createdAt: string;
  finalizedAt: string;
  me: MatchPlayerView | null;
  players: MatchPlayerView[];
}

export interface MatchRoundView {
  roundId: string;
  roundNumber: number;
  finishReason: string;
  winnerSeats: number[];
  nextDealerSeat: number;
  deltas: Array<{ playerId: string; delta: number }>;
  events: Array<{
    eventId: string;
    type: string;
    payer: string | null;
    payee: string;
    points: number;
    note: string;
  }>;
  finishedAt: string;
}

export interface GroupSummary {
  groupId: string;
  groupNo: string;
  name: string;
  ownerId: string;
  notice: string;
  allMuted: boolean;
  memberCount: number;
  role: "owner" | "admin" | "member";
  createdAt: string;
  lastMessageAt: string | null;
}

export interface GroupMessageView {
  messageId: string;
  senderId: string;
  /** 发送者昵称，服务端用账号仓库补齐；账号查不到时缺省。 */
  senderNickname?: string;
  sentAt: string;
  /**
   * 消息类型。取值与 `packages/domain` 的 `GroupMessageType` 一一对应 ——
   * 这里曾经写成 `sticker` / `room-invite`，与服务端的 `emoji` / `room_invite` 不一致，
   * 属于协议漂移：类型对不上时，渲染层的分支会静默漏掉那两类消息。
   */
  type: "text" | "image" | "voice" | "emoji" | "room_invite" | "system";
  content: string;
  voiceSeconds?: number;
  recalledAt: string | null;
}

/** `GET /v1/groups/:groupId`：群详情。`role` 是调用者自己在这个群里的角色。 */
export interface GroupDetail {
  groupId: string;
  groupNo: string;
  name: string;
  ownerId: string;
  notice: string;
  allMuted: boolean;
  memberCount: number;
  role: "owner" | "admin" | "member";
  members: Array<{ userId: string; role: "owner" | "admin" | "member"; nickname?: string; avatarUrl?: string }>;
}

/** `GET /v1/groups/:groupId/messages`：一页消息，`messages` 按时间升序（旧 → 新）。 */
export interface GroupMessagePage {
  groupId: string;
  messages: GroupMessageView[];
  /** 取更早一页要带上的游标；已经是第一页时为 undefined。 */
  nextCursor?: string;
}

/**
 * `POST /v1/uploads` 的返回值：一个已经签好名的直传地址。
 *
 * `objectKey` 是之后发消息时要填进 `content` 的东西（归属与类型都写在键前缀里）；
 * `uploadUrl` / `method` / `headers` 原样用到直传请求上即可 —— 内容类型参与签名，
 * 拿到地址后换一种类型上传会被存储端拒绝。
 */
export interface UploadTicket {
  objectKey: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
}

/**
 * 牌桌上看得见的副露。
 *
 * **别人的暗杠 `tile` 是 `null`** —— 服务端在 `playerSnapshot` 里把它裁掉了
 * （见 `apps/server/src/meld-visibility.ts`）：真实牌桌上暗杠是扣着的，
 * 对手只知道「那里有四张牌」，不知道是哪一张。
 *
 * 判据用 `tile === null`，不要用 `concealed` —— 本人的暗杠也是 `concealed`，
 * 但自己看得见牌值。
 */
export interface VisibleMeld {
  kind: "pong" | "kong";
  tile: Tile | null;
  concealed?: boolean;
}

/** 一局进行中，服务端只发给本人的脱敏快照（见 ws-server.ts 的 playerSnapshot）。 */
export interface MatchState {
  dealerSeat?: number;
  /** 服务端当前操作的超时截止时间（Unix 毫秒）。 */
  actionDeadlineAt?: number;
  roomId: string;
  /** 正在打第几小场（从 1 起）。 */
  roundNumber: number;
  /** 一整局共几小场（8）。服务端下发，省得两端各硬编码一个 8。 */
  totalRounds?: number;
  seat: number;
  phase: "swapping" | "missing" | "playing" | "claiming" | "finished";
  currentPlayerSeat: number | null;
  tilesLeft: number;
  hand: Tile[];
  /** 我的副露：自己的牌值一定看得见，所以这里不是 `VisibleMeld`。 */
  melds: Array<{ kind: "pong" | "kong"; tile: Tile; concealed?: boolean }>;
  missingSuit: Suit | null;
  discards: Tile[];
  won: boolean;
  players: Array<{
    seat: number;
    handSize: number;
    /** 本小场事件账本累计净输赢，换一小场归零。不是账户余额。 */
    roundDelta?: number;
    /**
     * **整局累计**净输赢（跨 8 小场连续累加，换一小场不清零）。
     * 头像下面显示的就是它；也不是账户余额 —— 账号积分要到整局结算才动。
     */
    matchDelta?: number;
    avatarUrl?: string;
    melds: VisibleMeld[];
    discards: Tile[];
    won: boolean;
    missingSuit: Suit | null;
  }>;
  result?: RoomResult;
}

export type ServerFrame =
  | { type: "ready"; userId: string }
  | { type: "room"; status: string; playerCount: number }
  | { type: "game"; state: MatchState }
  | { type: "actions"; actions: string[] }
  | {
    type: "round-finished";
    roundNumber: number;
    result: RoomResult;
    /**
     * 这一局结算后，服务端还会停多久才开下一局（毫秒）。结算界面据此显示倒计时。
     * 0 或缺失表示不停留（立刻开下一局）。
     */
    nextRoundInMs?: number;
  }
  | { type: "match-finished"; result: MatchResult }
  | { type: "group-subscribed"; groupId: string }
  | { type: "group-unsubscribed"; groupId: string }
  | { type: "group-message"; groupId: string; message: GroupMessageView }
  | { type: "group-message-recalled"; groupId: string; message: GroupMessageView }
  | { type: "group-updated"; groupId: string; notice?: string; allMuted?: boolean }
  | { type: "group-removed"; groupId: string }
  | { type: "group-dissolved"; groupId: string }
  | { type: "error"; message: string };

export type ClientFrame =
  | { type: "auth"; token: string; roomId?: string }
  | { type: "start" }
  | { type: "swap"; tiles: Tile[] }
  | { type: "auto-swap" }
  | { type: "missing"; suit: Suit }
  | { type: "auto-missing" }
  | { type: "discard"; tile: Tile }
  | { type: "claim"; action: "hu" | "peng" | "kong" | "pass" }
  | { type: "self-draw" }
  | { type: "concealed-kong" }
  | { type: "added-kong" }
  | { type: "group-subscribe"; groupId: string }
  | { type: "group-unsubscribe"; groupId: string };
