import type { HttpTransport, HttpRequest } from "./transport.js";
import type {
  FriendRequestView,
  GroupDetail,
  GroupMessagePage,
  GroupMessageView,
  GroupSummary,
  MatchRoundView,
  MatchSummary,
  MeView,
  PublicUser,
  RoomResult,
  RoomSnapshot,
  SessionView,
  UploadTicket,
} from "./protocol.js";

/** 服务端的稳定错误码，按语义分好类，界面代码按 `kind` 分支即可。 */
export type ApiErrorKind =
  | "auth" // 令牌缺失或失效、密钥不存在或已撤销
  | "input" // 参数格式不对
  | "forbidden" // 已认证但没有权限
  | "not-found"
  | "conflict" // 业务规则不允许当前操作
  | "unavailable" // 该能力需要数据库，服务端没配
  | "server" // 服务端异常
  | "network"; // 连不上服务端

export interface ApiError {
  status: number;
  /** 服务端返回的稳定错误码，例如 `KEY_ACTIVATION_REQUIRED`。 */
  code: string;
  kind: ApiErrorKind;
  message?: string;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

function kindFor(status: number, code: string): ApiErrorKind {
  if (status === 400) return "input";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 501) return "unavailable";
  // 认证类错误码即使在 4xx 之外也要按认证处理。
  if (code.startsWith("INVALID_") || code === "AUTH_REQUIRED") return "auth";
  if (status >= 500) return "server";
  return "conflict";
}

function errorFor(status: number, body: unknown, fallback: string): ApiError {
  const code = typeof body === "object" && body !== null && "code" in body && typeof (body as { code?: unknown }).code === "string"
    ? (body as { code: string }).code
    : fallback;
  const message = typeof body === "object" && body !== null && "message" in body && typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message
    : undefined;
  return { status, code, kind: kindFor(status, code), ...(message ? { message } : {}) };
}

/**
 * 服务端 REST 接口的类型化客户端。
 *
 * 所有调用都返回 `ApiResult` 而不是抛异常：界面代码要把「密钥还没绑定」「被踢下线」
 * 这类情况当成正常分支来画，用异常会漏掉其中一种。
 */
export class ApiClient {
  private bearer: string | undefined;

  constructor(
    private readonly transport: HttpTransport,
    token?: string,
  ) {
    this.bearer = token;
  }

  /** 当前会话令牌；未登录时为 undefined。实时通道建连时要带上它。 */
  get token(): string | undefined {
    return this.bearer;
  }

  /** 换一个已登录用户的令牌；登出时传 undefined。 */
  setToken(token: string | undefined): void {
    this.bearer = token;
  }

  private async call<T>(request: Omit<HttpRequest, "token">): Promise<ApiResult<T>> {
    try {
      const response = await this.transport.request<T>({
        ...request,
        ...(this.bearer ? { token: this.bearer } : {}),
      });
      if (response.status >= 200 && response.status < 300) return { ok: true, value: response.body };
      return { ok: false, error: errorFor(response.status, response.body, "UNKNOWN_ERROR") };
    } catch (cause) {
      return {
        ok: false,
        error: { status: 0, code: "NETWORK_ERROR", kind: "network", message: String(cause) },
      };
    }
  }

  // ---------- 认证 ----------

  /**
   * 首次使用邀请密钥：建号并登录。
   *
   * 成功后客户端会**自动持有**返回的令牌，后续调用不必再手动 setToken；
   * 这是故意的设计 —— 「登录了却忘了带令牌」是一类很难查的错。
   */
  async activate(key: string, nickname: string, avatarUrl: string): Promise<ApiResult<SessionView>> {
    const result = await this.call<SessionView>({
      method: "POST",
      path: "/v1/auth/activate",
      body: { key, nickname, avatarUrl },
    });
    if (result.ok) this.bearer = result.value.token;
    return result;
  }

  /** 之后每次登录：同一把密钥。成功后同样自动持有令牌。 */
  async login(key: string): Promise<ApiResult<SessionView>> {
    const result = await this.call<SessionView>({ method: "POST", path: "/v1/auth/login", body: { key } });
    if (result.ok) this.bearer = result.value.token;
    return result;
  }

  /**
   * 注销账号。立即生效且不可撤销。
   *
   * 成功后本地令牌也一并丢掉 —— 服务端已经把账号标成 `deleted`，这个令牌再也用不了，
   * 留着只会让界面以为还登着。
   */
  async deleteAccount(): Promise<ApiResult<null>> {
    const result = await this.call<null>({ method: "POST", path: "/v1/account/delete" });
    if (result.ok) this.bearer = undefined;
    return result;
  }

  /**
   * 当前账号的最新状态。
   *
   * 回首页时拉一次：**账号积分只在整局结算那一刻改**，不重新拉就永远显示开局前那个余额。
   */
  me(): Promise<ApiResult<MeView>> {
    return this.call({ method: "GET", path: "/v1/me" });
  }

  /** 精确搜索：返回用户资料与两人的关系状态。 */
  user(userId: string): Promise<ApiResult<PublicUser>> {
    return this.call({ method: "GET", path: `/v1/users/${encodeURIComponent(userId)}` });
  }

  // ---------- 好友 ----------

  searchUser(userId: string): Promise<ApiResult<PublicUser>> {
    return this.user(userId);
  }

  listFriendRequests(): Promise<ApiResult<{ requests: FriendRequestView[] }>> {
    return this.call({ method: "GET", path: "/v1/friends/requests" });
  }

  sendFriendRequest(targetUserId: string): Promise<ApiResult<FriendRequestView>> {
    return this.call({ method: "POST", path: "/v1/friends/requests", body: { targetUserId } });
  }

  respondFriendRequest(requestId: string, accept: boolean): Promise<ApiResult<unknown>> {
    return this.call({ method: "POST", path: `/v1/friends/requests/${encodeURIComponent(requestId)}/respond`, body: { accept } });
  }

  listFriends(): Promise<ApiResult<{ friends: PublicUser[] }>> {
    return this.call({ method: "GET", path: "/v1/friends" });
  }

  removeFriend(friendId: string): Promise<ApiResult<unknown>> {
    return this.call({ method: "DELETE", path: `/v1/friends/${encodeURIComponent(friendId)}` });
  }

  // ---------- 房间 ----------

  /** 建房。带上幂等键，超时重试才不会建出两间房。 */
  createRoom(idempotencyKey?: string): Promise<ApiResult<{ roomId: string; roomNo: string; status: string }>> {
    return this.call({ method: "POST", path: "/v1/rooms", ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  room(roomId: string): Promise<ApiResult<RoomSnapshot>> {
    return this.call({ method: "GET", path: `/v1/rooms/${encodeURIComponent(roomId)}` });
  }

  /**
   * 按 6 位房间号加入。
   *
   * 路径上没有房间号 —— 服务端对外只认房间号（内部 `roomId` 是它自己换回来的），
   * 与群聊的 `/v1/groups/join` 同一个做法。
   */
  joinRoom(roomNo: string): Promise<ApiResult<{ roomId: string; roomNo: string; status: string; playerCount: number }>> {
    return this.call({ method: "POST", path: "/v1/rooms/join", body: { roomNo } });
  }

  leaveRoom(roomId: string): Promise<ApiResult<unknown>> {
    return this.call({ method: "POST", path: `/v1/rooms/${encodeURIComponent(roomId)}/leave` });
  }

  setReady(roomId: string, ready: boolean): Promise<ApiResult<{ userId: string; ready: boolean }>> {
    return this.call({ method: "POST", path: `/v1/rooms/${encodeURIComponent(roomId)}/ready`, body: { ready } });
  }

  /**
   * REST 的开局：**只把房间状态改成 `playing`**，不会让实时层建局。
   *
   * 所以客户端不用它 —— 开局走实时通道的 `{type:"start"}`（见 `ClientFlow.startMatch`）。
   * 留着是为了让这个类型化客户端仍然覆盖完整的 REST 接口（脚本、排查用）。
   */
  startMatch(roomId: string): Promise<ApiResult<{ roomId: string; status: string; completedRounds: number }>> {
    return this.call({ method: "POST", path: `/v1/rooms/${encodeURIComponent(roomId)}/start` });
  }

  voteDissolve(roomId: string, agree: boolean): Promise<ApiResult<unknown>> {
    return this.call({ method: "POST", path: `/v1/rooms/${encodeURIComponent(roomId)}/dissolve/vote`, body: { agree } });
  }

  // ---------- 战绩 ----------

  matches(limit = 20, cursor?: string): Promise<ApiResult<{ matches: MatchSummary[]; nextCursor?: string }>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.call({ method: "GET", path: `/v1/matches?${query.toString()}` });
  }

  matchDetail(roomId: string): Promise<ApiResult<{ match: MatchSummary; rounds: MatchRoundView[] }>> {
    return this.call({ method: "GET", path: `/v1/rooms/${encodeURIComponent(roomId)}/history` });
  }

  // ---------- 群聊 ----------

  groups(): Promise<ApiResult<{ groups: GroupSummary[] }>> {
    return this.call({ method: "GET", path: "/v1/groups" });
  }

  /** 群详情：群名、公告、人数与「我」的角色。 */
  group(groupId: string): Promise<ApiResult<GroupDetail>> {
    return this.call({ method: "GET", path: `/v1/groups/${encodeURIComponent(groupId)}` });
  }

  /**
   * 群消息历史。不传 `before` 时取最新一页；用上一页返回的 `nextCursor` 继续往前翻。
   * 返回的 `messages` 按时间升序（旧 → 新），可以直接从上往下渲染。
   */
  groupMessages(groupId: string, limit = 50, before?: string): Promise<ApiResult<GroupMessagePage>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set("before", before);
    return this.call({ method: "GET", path: `/v1/groups/${encodeURIComponent(groupId)}/messages?${query.toString()}` });
  }

  /**
   * 签发一个图片或语音的直传地址。
   *
   * 类型与大小在**签发时**就被服务端校验掉（地址绑定了内容类型，换类型上传会被存储端拒绝），
   * 所以这里传真实字节数，不要估算。没配存储时服务端返回 `STORAGE_UNAVAILABLE`（501）。
   */
  createUpload(input: { kind: "image" | "voice"; contentType: string; byteSize: number }): Promise<ApiResult<UploadTicket>> {
    return this.call({ method: "POST", path: "/v1/uploads", body: input });
  }

  /**
   * 发任意类型的群消息；`content` 对图片/语音来说是对象键。
   *
   * `idempotencyKey` 由调用方在**重试时复用同一个值** —— 这是「重复提交不会发出第二条消息」
   * 的关键（见 `ClientFlow` 的 `retryOnceOnNetworkFailure`）。
   */
  sendGroupMessage(
    groupId: string,
    body: { type: GroupMessageView["type"]; content: string; voiceSeconds?: number },
    idempotencyKey?: string,
  ): Promise<ApiResult<GroupMessageView>> {
    return this.call({
      method: "POST",
      path: `/v1/groups/${encodeURIComponent(groupId)}/messages`,
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  sendGroupText(groupId: string, content: string, idempotencyKey?: string): Promise<ApiResult<GroupMessageView>> {
    return this.sendGroupMessage(groupId, { type: "text", content }, idempotencyKey);
  }

  recallGroupMessage(groupId: string, messageId: string): Promise<ApiResult<GroupMessageView>> {
    return this.call({
      method: "POST",
      path: `/v1/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/recall`,
    });
  }

  leaveGroup(groupId: string): Promise<ApiResult<{ groupId: string; dissolved: boolean; ownerId?: string; memberCount?: number }>> {
    return this.call({ method: "POST", path: `/v1/groups/${encodeURIComponent(groupId)}/leave` });
  }

  dissolveGroup(groupId: string): Promise<ApiResult<unknown>> {
    return this.call({ method: "POST", path: `/v1/groups/${encodeURIComponent(groupId)}/dissolve` });
  }
}

export type { RoomResult };
