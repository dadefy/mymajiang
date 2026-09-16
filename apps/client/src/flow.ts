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
import type { SocketTransportFactory } from "./transport.js";

/** 群聊一次拉多少条历史。服务端上限 200，这里取一个够用又不会一次拉太多的值。 */
const CHAT_PAGE_SIZE = 50;

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
      /** 正在发送。 */
      sending: boolean;
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

  /** 回主页：拉群列表与战绩。任何一项失败都留在主页并提示，不弹回登录。 */
  async refreshHome(): Promise<void> {
    if (this.screen.name !== "home") return;
    this.set({ ...this.screen, busy: true });
    const [groups, matches] = await Promise.all([this.api.groups(), this.api.matches()]);
    const failure = groups.ok ? (matches.ok ? null : matches.error) : groups.error;
    this.set({
      name: "home",
      me: this.screen.me,
      groups: groups.ok ? groups.value.groups : [],
      matches: matches.ok ? matches.value.matches : [],
      busy: false,
      ...(failure ? { error: describe(failure) } : {}),
    });
  }

  async createRoom(): Promise<void> {
    if (this.screen.name !== "home") return;
    this.set({ ...this.screen, busy: true });
    const created = await this.api.createRoom();
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
    const sent = await this.api.sendGroupText(groupId, text);
    if (this.screen.name !== "chat" || this.screen.groupId !== groupId) return;
    if (!sent.ok) {
      this.set({ ...this.screen, sending: false, error: describe(sent.error) });
      return;
    }
    this.set({ ...this.screen, sending: false, messages: appendMessage(this.screen.messages, sent.value) });
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
    this.set({ name: "home", me: this.me, groups: [], matches: [], busy: true });
    const [groups, matches] = await Promise.all([this.api.groups(), this.api.matches()]);
    const failure = groups.ok ? (matches.ok ? null : matches.error) : groups.error;
    this.set({
      name: "home",
      me: this.me,
      groups: groups.ok ? groups.value.groups : [],
      matches: matches.ok ? matches.value.matches : [],
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
