import type { HttpTransport, HttpRequest } from "./transport.js";
import type {
  FriendRequestView,
  GroupMessageView,
  GroupSummary,
  MatchRoundView,
  MatchSummary,
  PublicUser,
  RoomResult,
  RoomSnapshot,
  SessionView,
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

  createRoom(): Promise<ApiResult<{ roomId: string; status: string }>> {
    return this.call({ method: "POST", path: "/v1/rooms" });
  }

  room(roomId: string): Promise<ApiResult<RoomSnapshot>> {
    return this.call({ method: "GET", path: `/v1/rooms/${encodeURIComponent(roomId)}` });
  }

  joinRoom(roomId: string): Promise<ApiResult<{ roomId: string; status: string; playerCount: number }>> {
    return this.call({ method: "POST", path: `/v1/rooms/${encodeURIComponent(roomId)}/join` });
  }

  leaveRoom(roomId: string): Promise<ApiResult<unknown>> {
    return this.call({ method: "POST", path: `/v1/rooms/${encodeURIComponent(roomId)}/leave` });
  }

  setReady(roomId: string, ready: boolean): Promise<ApiResult<{ userId: string; ready: boolean }>> {
    return this.call({ method: "POST", path: `/v1/rooms/${encodeURIComponent(roomId)}/ready`, body: { ready } });
  }

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

  groupMessages(groupId: string, limit = 50): Promise<ApiResult<{ messages: GroupMessageView[] }>> {
    return this.call({ method: "GET", path: `/v1/groups/${encodeURIComponent(groupId)}/messages?limit=${limit}` });
  }

  sendGroupText(groupId: string, content: string): Promise<ApiResult<GroupMessageView>> {
    return this.call({ method: "POST", path: `/v1/groups/${encodeURIComponent(groupId)}/messages`, body: { type: "text", content } });
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
