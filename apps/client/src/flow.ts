import { ApiClient, type ApiError, type ApiResult } from "./api-client.js";
import { MatchSocket, type SocketEvent } from "./match-socket.js";
import type {
  GroupDetail,
  GroupMessagePage,
  GroupMessageView,
  GroupSummary,
  MatchState,
  MatchSummary,
  RoomResult,
  RoomSnapshot,
  Suit,
  Tile,
} from "./protocol.js";
import type {
  SocketTransportFactory,
  UploadRequest,
  UploadResponse,
  UploadTransport,
} from "./transport.js";

/** 群聊一次拉多少条历史。服务端上限 200，这里取一个够用又不会一次拉太多的值。 */
const CHAT_PAGE_SIZE = 50;

/**
 * 图片与语音的本地上限。
 *
 * 与服务端 `UPLOAD_LIMITS` 一致 —— 客户端这一道**只是不想白传一次**，
 * 权威判定仍在服务端（它会按内容类型与真实字节数再拒一遍）。
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VOICE_BYTES = 2 * 1024 * 1024;

/**
 * 语音时长上限；与服务端 `sendMessage` 对 `voiceSeconds` 的校验一致（1–60 秒）。
 *
 * 导出给渲染层用：录音界面要据此自动停止，不能录出一段服务端必然拒收的音频。
 */
export const MAX_VOICE_SECONDS = 60;

/**
 * 生成一个幂等键。
 *
 * 不依赖 `crypto.randomUUID`：LayaAir 的原生运行时不一定提供它。时间戳 + 随机段就够了 ——
 * 这个键只需要在「同一个用户的一次操作及其重试」之间唯一，不承担安全职责。
 * 形状要满足服务端的校验：16–128 位、只含 URL 安全字符。
 */
function newIdempotencyKey(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 网络错误时重试一次。
 *
 * **两次用的是同一个幂等键**，所以即使第一次其实已经到达并执行了（只是响应慢或丢了），
 * 重试也只会拿回那一次的结果，不会多建一间房、多发一条消息。
 *
 * 只重试网络错误：4xx/5xx 是服务端已经给出的判断，原样重试没有意义。
 */
async function retryOnceOnNetworkFailure<T>(operation: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const first = await operation();
  if (first.ok || first.error.kind !== "network") return first;
  return operation();
}

/**
 * 界面只需要渲染的页面，字段全是纯数据：
 * 换成 LayaAir 时直接把 `Screen` 绑到节点上即可，不需要改任何业务代码。
 *
 * 可选字段显式写成 `| undefined`：清掉提示时直接赋 `undefined`，不用按字段逐个拼对象。
 */
export type Screen =
  | { name: "key-entry"; busy: boolean; error?: string | undefined }
  | { name: "profile"; key: string; busy: boolean; error?: string | undefined }
  | {
      name: "home";
      me: { userId: string; nickname: string; points: number };
      groups: GroupSummary[];
      matches: MatchSummary[];
      /**
       * 战绩需要数据库。内存模式下服务端按设计返回 501 —— 这是**能力不可用**，不是操作失败，
       * 所以单独一个标记让页面说清楚，而不是弹一条让人以为系统坏了的错误。
       */
      matchesUnavailable: boolean;
      busy: boolean;
      error?: string | undefined;
    }
  | {
      name: "room";
      roomId: string;
      snapshot: RoomSnapshot | null;
      /** 当前这一局；还没开局或还没收到第一帧时为空。 */
      match: MatchState | null;
      actions: string[];
      /** 最近一局的结算，弹窗用。 */
      lastResult: RoomResult | null;
      busy: boolean;
      notice?: string | undefined;
    }
  | {
      name: "chat";
      groupId: string;
      /** 群详情；拉取失败时为空，页面仍能显示消息。 */
      group: GroupDetail | null;
      /** 已加载的消息，按时间升序（旧 → 新），页面直接从下往上贴。 */
      messages: GroupMessageView[];
      /** 我自己的用户 ID：判断哪条消息能撤回、哪条是自己发的。 */
      meId: string;
      /** 还有更早的消息可以加载。 */
      hasEarlier: boolean;
      /** 正在加载更早的一页。 */
      loadingEarlier: boolean;
      /** 正在发送文字。 */
      sending: boolean;
      /** 正在上传图片（签发 → 直传 → 发消息，三步都算）。 */
      uploading: boolean;
      error?: string | undefined;
      notice?: string | undefined;
    };

function isClaimAction(action: string): boolean {
  return ["hu", "peng", "kong", "pass"].includes(action);
}

function describe(error: ApiError): string {
  if (error.kind === "network") return "连不上服务器，请稍后再试";
  if (error.code === "KEY_INVALID") return "邀请密钥不存在";
  if (error.code === "KEY_REVOKED") return "邀请密钥已被撤销";
  if (error.code === "KEY_MALFORMED") return "邀请密钥格式不对";
  if (error.code === "ACCOUNT_NOT_ACTIVE") return "账号已被停用";
  if (error.message) return error.message;
  return `操作失败（${error.code}）`;
}

/**
 * 上传相关的失败给一句人话。
 *
 * 单独写而不是复用 `describe`：签发被拒时服务端返回的 `message` 是英文的
 * （例如 `image exceeds the 5 MB limit`），直接显示给用户不合适。
 */
function describeUploadFailure(error: ApiError): string {
  if (error.kind === "unavailable") return "服务器没有开启图片上传";
  if (error.kind === "network") return "连不上服务器，请稍后再试";
  if (error.code === "RATE_LIMITED") return "上传太频繁，请稍后再试";
  if (error.kind === "input") return "这张图片的格式或大小不符合要求";
  if (error.kind === "forbidden") return "这次上传没有被授权，请重新登录后再试";
  return describe(error);
}

/**
 * 客户端的业务骨架：密钥登录 → 主页 → 建房/进房 → 行牌，主页也可以进群聊。
 *
 * 它不渲染任何东西，只产出 `Screen`；渲染层订阅 `onChange` 就够了。
 * 对局与群聊**共用同一条实时通道**，但同一时刻只有一个页面在显示，
 * 所以收到的帧按当前页面分发（见 `dispatchSocketEvent`）。
 */
export class ClientFlow {
  private screen: Screen = { name: "key-entry", busy: false };
  private socket: MatchSocket | null = null;
  /** 登录后记住「我是谁」，离开房间回主页时不用再调接口。 */
  private me: { userId: string; nickname: string; points: number } | undefined;
  private roomId: string | null = null;
  /**
   * 群聊往更早翻页的游标。
   *
   * 它是加载更多的实现细节，渲染层不需要知道，所以不放 `Screen` 里 ——
   * 页面只要判断 `hasEarlier` 决定要不要显示「加载更早的消息」。
   */
  private earlierCursor: string | undefined;
  private readonly listeners = new Set<(screen: Screen) => void>();

  constructor(
    private readonly api: ApiClient,
    private readonly sockets: SocketTransportFactory,
    private readonly socketUrl: string,
    /** 图片直传。地址指向对象存储，所以和 `sockets` 一样是环境相关的缝。 */
    private readonly uploads: UploadTransport,
  ) {}

  get current(): Screen {
    return this.screen;
  }

  onChange(listener: (screen: Screen) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 退出登录：关掉实时通道、清掉令牌，回到密钥输入页。 */
  signOut(): void {
    this.socket?.close();
    this.socket = null;
    this.roomId = null;
    this.earlierCursor = undefined;
    this.me = undefined;
    this.api.setToken(undefined);
    this.set({ name: "key-entry", busy: false });
  }

  /** 输入密钥：已激活的进主页，没激活的进资料页。 */
  async enterKey(rawKey: string): Promise<void> {
    const key = rawKey.trim();
    this.set({ name: "key-entry", busy: true });
    const login = await this.api.login(key);
    if (login.ok) {
      await this.enterHome(login.value);
      return;
    }
    if (login.error.code === "KEY_ACTIVATION_REQUIRED") {
      this.set({ name: "profile", key, busy: false });
      return;
    }
    this.set({ name: "key-entry", busy: false, error: describe(login.error) });
  }

  async submitProfile(key: string, nickname: string, avatarUrl: string): Promise<void> {
    this.set({ name: "profile", key, busy: true });
    const activated = await this.api.activate(key, nickname.trim(), avatarUrl.trim());
    if (!activated.ok) {
      this.set({ name: "profile", key, busy: false, error: describe(activated.error) });
      return;
    }
    await this.enterHome(activated.value);
  }

  /**
   * 回主页：拉群列表与战绩。任何一项失败都留在主页并提示，不弹回登录。
   *
   * 但**战绩不可用要排除在外**：它需要数据库，内存模式下服务端按设计返回 501，
   * 内测时每个人都会看到它 —— 写成「操作失败」会让人以为系统坏了。
   */
  async refreshHome(): Promise<void> {
    if (this.screen.name !== "home") return;
    this.set({ ...this.screen, busy: true });
    const [groups, matches] = await Promise.all([this.api.groups(), this.api.matches()]);
    const matchesUnavailable = !matches.ok && matches.error.kind === "unavailable";
    const failure = groups.ok ? (matches.ok || matchesUnavailable ? null : matches.error) : groups.error;
    this.set({
      name: "home",
      me: this.screen.me,
      groups: groups.ok ? groups.value.groups : [],
      matches: matches.ok ? matches.value.matches : [],
      matchesUnavailable,
      busy: false,
      ...(failure ? { error: describe(failure) } : {}),
    });
  }

  async createRoom(): Promise<void> {
    if (this.screen.name !== "home") return;
    this.set({ ...this.screen, busy: true });
    // 建房不是幂等的：每调一次多一个房间。带上键，超时重试才不会建出两间。
    const idempotencyKey = newIdempotencyKey();
    const created = await retryOnceOnNetworkFailure(() => this.api.createRoom(idempotencyKey));
    if (!created.ok) {
      this.set({ ...this.screen, busy: false, error: describe(created.error) });
      return;
    }
    await this.enterRoom(created.value.roomId);
  }

  async joinRoom(roomId: string): Promise<void> {
    if (this.screen.name !== "home") return;
    this.set({ ...this.screen, busy: true });
    const joined = await this.api.joinRoom(roomId.trim());
    if (!joined.ok) {
      this.set({ ...this.screen, busy: false, error: describe(joined.error) });
      return;
    }
    await this.enterRoom(roomId.trim());
  }

  /** 离开房间并断开该房间的实时通道，然后回主页。 */
  async leaveRoom(): Promise<void> {
    if (this.roomId) await this.api.leaveRoom(this.roomId);
    this.closeSocket();
    this.roomId = null;
    // 不能用 refreshHome()：当前页面还是 room，它会在原地返回。
    await this.enterHome(this.meOrFail());
  }

  async setReady(ready: boolean): Promise<void> {
    if (this.roomId) await this.api.setReady(this.roomId, ready);
  }

  async startMatch(): Promise<void> {
    if (this.roomId) await this.api.startMatch(this.roomId);
  }

  // ---------- 行牌：都走实时通道 ----------

  swap(tiles: Tile[]): void {
    this.socket?.send({ type: "swap", tiles });
  }

  autoSwap(): void {
    this.socket?.send({ type: "auto-swap" });
  }

  chooseMissing(suit: Suit): void {
    this.socket?.send({ type: "missing", suit });
  }

  autoMissing(): void {
    this.socket?.send({ type: "auto-missing" });
  }

  discard(tile: Tile): void {
    this.socket?.send({ type: "discard", tile });
  }

  /** 响应别人的牌：hu / peng / kong / pass。 */
  claim(action: "hu" | "peng" | "kong" | "pass"): void {
    if (!isClaimAction(action)) throw new Error(`Unsupported claim action: ${action}`);
    this.socket?.send({ type: "claim", action });
  }

  selfDraw(): void {
    this.socket?.send({ type: "self-draw" });
  }

  concealedKong(): void {
    this.socket?.send({ type: "concealed-kong" });
  }

  addedKong(): void {
    this.socket?.send({ type: "added-kong" });
  }

  // ---------- 群聊 ----------

  /**
   * 进入群聊：拉群详情与最新一页消息，并在实时通道上订阅这个群。
   *
   * 群聊不绑房间（`auth` 的 `roomId` 可选），这条连接只收群消息 ——
   * 所以从群聊进房间是走不通的，页面流也只提供「群聊 ←→ 主页」这条来回。
   */
  async openChat(groupId: string): Promise<void> {
    const me = this.meOrFail();
    this.earlierCursor = undefined;
    this.set({
      name: "chat",
      groupId,
      group: null,
      messages: [],
      meId: me.userId,
      hasEarlier: false,
      loadingEarlier: false,
      sending: false,
      uploading: false,
    });
    await this.attachChatSocket(groupId);
    await this.loadLatestPage(groupId);
  }

  /** 回主页：退订并断开群聊通道，然后重拉主页列表（群的「最近消息」已经变了）。 */
  async backHome(): Promise<void> {
    if (this.screen.name === "chat") this.socket?.unsubscribeGroup(this.screen.groupId);
    this.closeSocket();
    this.earlierCursor = undefined;
    await this.enterHome(this.meOrFail());
  }

  /**
   * 发一条文字消息。
   *
   * 服务端写成功后会通过实时通道把这条消息推回来（自己也在订阅者里），
   * 所以这里就地把返回值贴上去、并在收到推送时按 `messageId` 去重：
   * 两条路都到，谁先到都只留一条，也避免「REST 成功但推送恰好没到」时消息看不见。
   */
  async sendText(content: string): Promise<void> {
    if (this.screen.name !== "chat") return;
    const text = content.trim();
    if (text.length === 0) return;
    const groupId = this.screen.groupId;
    this.set({ ...this.screen, sending: true, error: undefined });
    // 发消息不是幂等的：多到达一次就多一条。重试复用同一个键。
    const idempotencyKey = newIdempotencyKey();
    const sent = await retryOnceOnNetworkFailure(() => this.api.sendGroupText(groupId, text, idempotencyKey));
    if (this.screen.name !== "chat" || this.screen.groupId !== groupId) return;
    if (!sent.ok) {
      this.set({ ...this.screen, sending: false, error: describe(sent.error) });
      return;
    }
    this.set({ ...this.screen, sending: false, messages: appendMessage(this.screen.messages, sent.value) });
  }

  /**
   * 发一张图片（群聊页面内用）。
   *
   * 上传本身走 `uploadGroupImage`，这里只多做两件事：标记页面「上传中」，
   * 成功后把消息贴进当前列表（实时推送也会带来同一条，按 `messageId` 去重是幂等的）。
   */
  async sendImage(input: { bytes: Uint8Array; contentType: string }): Promise<void> {
    await this.sendAttachment((groupId) => this.uploadGroupImage(groupId, input));
  }

  /**
   * 发一段语音（群聊页面内用）。
   *
   * `seconds` 是录音时长，服务端按 1–60 秒校验；它只用于展示，音频本身不带时长信息。
   */
  async sendVoice(input: { bytes: Uint8Array; contentType: string; seconds: number }): Promise<void> {
    await this.sendAttachment((groupId) => this.uploadGroupVoice(groupId, input));
  }

  /**
   * 上传一张图片并作为群消息发出。
   *
   * **不要求当前页面是群聊**：浏览器调试面板是在主页里直接发图的。
   * 三步都不依赖界面状态，所以这里显式收 `groupId` 而不是读 `this.screen`。
   */
  async uploadGroupImage(
    groupId: string,
    input: { bytes: Uint8Array; contentType: string },
  ): Promise<{ ok: true; value: GroupMessageView } | { ok: false; error: string }> {
    // 本地先挡一道：明显不合规的图没必要先传上去再被拒。权威判定仍在服务端。
    if (input.bytes.byteLength === 0) return { ok: false, error: "这张图片是空的" };
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
    }
    return this.uploadAndSend(groupId, "image", input.bytes, input.contentType);
  }

  /** 上传一段语音并作为群消息发出。同样不要求当前页面是群聊。 */
  async uploadGroupVoice(
    groupId: string,
    input: { bytes: Uint8Array; contentType: string; seconds: number },
  ): Promise<{ ok: true; value: GroupMessageView } | { ok: false; error: string }> {
    if (input.bytes.byteLength === 0) return { ok: false, error: "没有录到声音" };
    if (input.bytes.byteLength > MAX_VOICE_BYTES) {
      return { ok: false, error: `语音不能超过 ${MAX_VOICE_BYTES / 1024 / 1024} MB` };
    }
    if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > MAX_VOICE_SECONDS) {
      return { ok: false, error: `语音长度要在 1–${MAX_VOICE_SECONDS} 秒之间` };
    }
    return this.uploadAndSend(groupId, "voice", input.bytes, input.contentType, input.seconds);
  }

  /**
   * 群聊页面内的「上传并发送」：标记上传中、把结果贴进当前列表。
   *
   * 图片与语音走的是同一条路（都只有三步：签发 → 直传 → 发消息），差别只在消息类型与参数，
   * 所以这里收一个已经绑定好参数的操作，而不是把三步写两遍。
   */
  private async sendAttachment(
    operation: (groupId: string) => Promise<{ ok: true; value: GroupMessageView } | { ok: false; error: string }>,
  ): Promise<void> {
    if (this.screen.name !== "chat") return;
    const groupId = this.screen.groupId;
    this.set({ ...this.screen, uploading: true, error: undefined });
    const sent = await operation(groupId);
    if (this.screen.name !== "chat" || this.screen.groupId !== groupId) return;
    if (!sent.ok) {
      this.set({ ...this.screen, uploading: false, error: sent.error });
      return;
    }
    // 实时推送也会带来同一条，`appendMessage` 按 messageId 去重，谁都只留一条。
    this.set({ ...this.screen, uploading: false, messages: appendMessage(this.screen.messages, sent.value) });
  }

  /** 撤回一条消息。能不能撤由服务端判定（2 分钟窗口与权限），客户端不自己算。 */
  async recallMessage(messageId: string): Promise<void> {
    if (this.screen.name !== "chat") return;
    const groupId = this.screen.groupId;
    const recalled = await this.api.recallGroupMessage(groupId, messageId);
    if (this.screen.name !== "chat" || this.screen.groupId !== groupId) return;
    if (!recalled.ok) {
      this.set({ ...this.screen, error: describe(recalled.error) });
      return;
    }
    this.set({ ...this.screen, messages: replaceMessage(this.screen.messages, recalled.value) });
  }

  /** 加载更早的一页历史，接在列表前面。 */
  async loadEarlier(): Promise<void> {
    if (this.screen.name !== "chat") return;
    const cursor = this.earlierCursor;
    if (this.screen.loadingEarlier || !this.screen.hasEarlier || !cursor) return;
    const groupId = this.screen.groupId;
    this.set({ ...this.screen, loadingEarlier: true, error: undefined });
    const page = await this.api.groupMessages(groupId, CHAT_PAGE_SIZE, cursor);
    if (this.screen.name !== "chat" || this.screen.groupId !== groupId) return;
    if (!page.ok) {
      this.set({ ...this.screen, loadingEarlier: false, error: describe(page.error) });
      return;
    }
    this.earlierCursor = page.value.nextCursor;
    this.set({
      ...this.screen,
      messages: [...page.value.messages, ...this.screen.messages],
      hasEarlier: page.value.nextCursor !== undefined,
      loadingEarlier: false,
    });
  }

  /** 重拉群详情与最新一页。失败时保留已有消息，只把错误显示出来。 */
  async refreshChat(): Promise<void> {
    if (this.screen.name !== "chat") return;
    await this.loadLatestPage(this.screen.groupId);
  }

  /** 群消息的内容走 REST；推送由 socket 事件带给渲染层。 */
  sendGroupText(groupId: string, content: string): Promise<ApiResult<GroupMessageView>> {
    return this.api.sendGroupText(groupId, content);
  }

  groupMessages(groupId: string, limit = 50): Promise<ApiResult<GroupMessagePage>> {
    return this.api.groupMessages(groupId, limit);
  }

  // ---------- 内部 ----------

  private async enterHome(me: { userId: string; nickname: string; points: number }): Promise<void> {
    // 令牌在登录那一刻就已由 ApiClient 自动持有；这里只记住「我是谁」，离开房间回主页时要用。
    this.me = me;
    this.set({ name: "home", me: this.me, groups: [], matches: [], matchesUnavailable: false, busy: true });
    const [groups, matches] = await Promise.all([this.api.groups(), this.api.matches()]);
    // 同 refreshHome：战绩不可用（没配数据库）是预期状态，不算失败。
    const matchesUnavailable = !matches.ok && matches.error.kind === "unavailable";
    const failure = groups.ok ? (matches.ok || matchesUnavailable ? null : matches.error) : groups.error;
    this.set({
      name: "home",
      me: this.me,
      groups: groups.ok ? groups.value.groups : [],
      matches: matches.ok ? matches.value.matches : [],
      matchesUnavailable,
      busy: false,
      ...(failure ? { error: describe(failure) } : {}),
    });
  }

  private meOrFail(): { userId: string; nickname: string; points: number } {
    if (!this.me) throw new Error("Not signed in");
    return this.me;
  }

  private async enterRoom(roomId: string): Promise<void> {
    // 令牌由 ApiClient 在登录那一刻自动持有；实时通道要带上同一个令牌。
    const token = this.api.token;
    if (!token) throw new Error("Not signed in");
    // 进房间前先收掉上一条通道：它可能只是一条订阅了群聊的连接，
    // 留着会同时收两边的帧，而且关闭旧连接前必须先摘掉它的监听（见 MatchSocket.connect）。
    this.closeSocket();
    this.earlierCursor = undefined;
    this.roomId = roomId;
    this.set({ name: "room", roomId, snapshot: null, match: null, actions: [], lastResult: null, busy: true });
    const socket = new MatchSocket({ url: this.socketUrl, token, factory: this.sockets });
    socket.on((event) => this.dispatchSocketEvent(event));
    this.socket = socket;
    await socket.connect(roomId);
    const snapshot = await this.api.room(roomId);
    this.set({
      name: "room",
      roomId,
      snapshot: snapshot.ok ? snapshot.value : null,
      match: null,
      actions: [],
      lastResult: null,
      busy: false,
      ...(snapshot.ok ? {} : { notice: describe(snapshot.error) }),
    });
  }

  private closeSocket(): void {
    this.socket?.close();
    this.socket = null;
  }

  /**
   * 对局与群聊共用同一条 socket，收到的帧按**当前页面**分发。
   *
   * 这里曾经是「不在房间页就直接丢掉」，于是离开房间页之后群消息推送全部丢失 ——
   * 而群聊页面正是靠这些推送实时更新的。
   */
  private dispatchSocketEvent(event: SocketEvent): void {
    if (this.screen.name === "room") this.handleRoomEvent(event);
    else if (this.screen.name === "chat") this.handleChatEvent(event);
  }

  private handleRoomEvent(event: SocketEvent): void {
    if (this.screen.name !== "room") return;
    switch (event.kind) {
      case "game":
        this.set({ ...this.screen, match: event.state, busy: false });
        return;
      case "actions":
        this.set({ ...this.screen, actions: event.actions });
        return;
      case "round-finished":
        this.set({ ...this.screen, lastResult: event.result });
        return;
      case "match-finished":
        this.set({ ...this.screen, lastResult: event.result, match: null, actions: [] });
        return;
      case "error":
        this.set({ ...this.screen, notice: event.message });
        return;
      case "disconnected":
        this.set({ ...this.screen, notice: "连接已断开，正在重连…" });
        return;
      case "reconnected":
        this.set({ ...this.screen, notice: undefined });
        return;
      default:
        return;
    }
  }

  /** 群聊页面的实时帧：只认当前这个群，别的群的消息不会打扰这一页。 */
  private handleChatEvent(event: SocketEvent): void {
    if (this.screen.name !== "chat") return;
    switch (event.kind) {
      case "group-message":
        if (event.groupId !== this.screen.groupId) return;
        this.set({ ...this.screen, messages: appendMessage(this.screen.messages, event.message) });
        return;
      case "group-message-recalled":
        if (event.groupId !== this.screen.groupId) return;
        this.set({ ...this.screen, messages: replaceMessage(this.screen.messages, event.message) });
        return;
      case "group-updated": {
        if (event.groupId !== this.screen.groupId) return;
        const group = this.screen.group;
        // 公告或全员禁言变了：就地改群详情，不重拉整页消息。
        this.set({
          ...this.screen,
          group: group
            ? { ...group, notice: event.notice ?? group.notice, allMuted: event.allMuted ?? group.allMuted }
            : null,
        });
        return;
      }
      case "group-removed":
        if (event.groupId !== this.screen.groupId) return;
        this.set({ ...this.screen, notice: "你已被移出该群" });
        return;
      case "group-dissolved":
        if (event.groupId !== this.screen.groupId) return;
        this.set({ ...this.screen, notice: "该群已解散" });
        return;
      case "disconnected":
        this.set({ ...this.screen, notice: "连接已断开，正在重连…" });
        return;
      case "reconnected":
        this.set({ ...this.screen, notice: undefined });
        return;
      case "error":
        this.set({ ...this.screen, notice: event.message });
        return;
      default:
        return;
    }
  }

  /** 拉群详情与最新一页消息，填进 chat 页面。 */
  private async loadLatestPage(groupId: string): Promise<void> {
    const [detail, page] = await Promise.all([
      this.api.group(groupId),
      this.api.groupMessages(groupId, CHAT_PAGE_SIZE),
    ]);
    if (this.screen.name !== "chat" || this.screen.groupId !== groupId) return;
    this.earlierCursor = page.ok ? page.value.nextCursor : undefined;
    const failure = detail.ok ? (page.ok ? null : page.error) : detail.error;
    this.set({
      ...this.screen,
      group: detail.ok ? detail.value : this.screen.group,
      messages: page.ok ? page.value.messages : this.screen.messages,
      hasEarlier: this.earlierCursor !== undefined,
      loadingEarlier: false,
      ...(failure ? { error: describe(failure) } : {}),
    });
  }

  /** 群聊页的连接：没有就建一条只订阅群聊的，然后订阅这个群。 */
  private async attachChatSocket(groupId: string): Promise<void> {
    const token = this.api.token;
    if (!token) throw new Error("Not signed in");
    let socket = this.socket;
    if (!socket) {
      socket = new MatchSocket({ url: this.socketUrl, token, factory: this.sockets });
      socket.on((event) => this.dispatchSocketEvent(event));
      this.socket = socket;
      // 不带 roomId：auth 的 roomId 可选，省略就是「只订阅群聊」。
      await socket.connect();
    }
    socket.subscribeGroup(groupId);
  }

  /**
   * 签发 → 直传 → 发消息，三步串起来，失败时给一句人话。
   *
   * 图片与语音共用这一条：差别只在消息类型与 `voiceSeconds`。
   * 直传打的是对象存储的域名，与 API 不是同一条链路 —— 那边网络出问题表现为抛异常，
   * 而不是一个带状态码的响应，所以这里要单独 catch。
   */
  private async uploadAndSend(
    groupId: string,
    kind: "image" | "voice",
    bytes: Uint8Array,
    contentType: string,
    voiceSeconds?: number,
  ): Promise<{ ok: true; value: GroupMessageView } | { ok: false; error: string }> {
    const label = kind === "image" ? "图片" : "语音";
    const ticket = await this.api.createUpload({ kind, contentType, byteSize: bytes.byteLength });
    if (!ticket.ok) return { ok: false, error: describeUploadFailure(ticket.error) };
    let uploaded: UploadResponse;
    try {
      uploaded = await this.putWithRetry({
        url: ticket.value.uploadUrl,
        method: ticket.value.method,
        headers: ticket.value.headers,
        body: bytes,
      });
    } catch {
      return { ok: false, error: `${label}上传失败，请检查网络后重试` };
    }
    if (uploaded.status < 200 || uploaded.status >= 300) {
      return { ok: false, error: `${label}上传失败（${uploaded.status}）` };
    }
    // 发消息这步才是「多到达一次就多一条」的那一步，必须带键重试。
    const idempotencyKey = newIdempotencyKey();
    const message = await retryOnceOnNetworkFailure(() =>
      this.api.sendGroupMessage(
        groupId,
        {
          type: kind,
          content: ticket.value.objectKey,
          ...(voiceSeconds === undefined ? {} : { voiceSeconds }),
        },
        idempotencyKey,
      ));
    if (!message.ok) return { ok: false, error: describe(message.error) };
    return { ok: true, value: message.value };
  }

  /**
   * 直传一次，网络抖动时再试一次。
   *
   * PUT 到同一个签名地址是**覆盖**语义（同一个对象键），重试不会产生第二个对象，
   * 所以这里可以放心重试，不像发消息那样必须靠幂等键。
   */
  private async putWithRetry(request: UploadRequest): Promise<UploadResponse> {
    try {
      return await this.uploads.put(request);
    } catch {
      return this.uploads.put(request);
    }
  }

  private set(screen: Screen): void {
    this.screen = screen;
    for (const listener of this.listeners) listener(screen);
  }
}

/**
 * 追加一条消息。
 *
 * 同一条消息可能从两处到：REST 的返回值与实时推送。按 `messageId` 去重，
 * 谁先到都只留一条 —— 否则自己刚发的那条会显示两次。
 */
function appendMessage(messages: GroupMessageView[], message: GroupMessageView): GroupMessageView[] {
  if (messages.some((existing) => existing.messageId === message.messageId)) {
    return replaceMessage(messages, message);
  }
  return [...messages, message];
}

/** 按 `messageId` 就地替换（撤回后内容变成「已撤回」）。 */
function replaceMessage(messages: GroupMessageView[], message: GroupMessageView): GroupMessageView[] {
  return messages.map((existing) => (existing.messageId === message.messageId ? message : existing));
}
