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
  result: RoomResult | null;
}

export interface RoomResult {
  reason: "three-winners" | "wall-exhausted" | "dissolved";
  deltas: Array<{ playerId: string; delta: number }>;
  winnerSeats: number[];
  nextDealerSeat: number;
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
  members: Array<{ userId: string; role: "owner" | "admin" | "member" }>;
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

/** 一局进行中，服务端只发给本人的脱敏快照（见 ws-server.ts 的 playerSnapshot）。 */
export interface MatchState {
  roomId: string;
  roundNumber: number;
  seat: number;
  phase: "swapping" | "missing" | "playing" | "claiming" | "finished";
  currentPlayerSeat: number | null;
  tilesLeft: number;
  hand: Tile[];
  melds: Array<{ kind: "pong" | "kong"; tile: Tile; concealed?: boolean }>;
  missingSuit: Suit | null;
  discards: Tile[];
  won: boolean;
  players: Array<{
    seat: number;
    handSize: number;
    melds: Array<{ kind: "pong" | "kong"; tile: Tile; concealed?: boolean }>;
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
  | { type: "round-finished"; roundNumber: number; result: RoomResult }
  | { type: "match-finished"; result: RoomResult }
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
