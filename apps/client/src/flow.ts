import { ApiClient, type ApiError, type ApiResult } from "./api-client.js";
import { MatchSocket, type SocketEvent } from "./match-socket.js";
import type { GroupMessageView, GroupSummary, MatchState, MatchSummary, RoomResult, RoomSnapshot, Suit, Tile } from "./protocol.js";
import type { SocketTransportFactory } from "./transport.js";

/**
 * 界面只需要渲染的四个页面，字段全是纯数据：
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
 * 客户端的业务骨架：密钥登录 → 主页 → 建房/进房 → 行牌。
 *
 * 它不渲染任何东西，只产出 `Screen`；渲染层订阅 `onChange` 就够了。
 * 群消息走 REST 拉取、实时推送走同一条 socket，但群页面不在骨架里，由渲染层自行组织。
 */
export class ClientFlow {
  private screen: Screen = { name: "key-entry", busy: false };
  private socket: MatchSocket | null = null;
  /** 登录后记住「我是谁」，离开房间回主页时不用再调接口。 */
  private me: { userId: string; nickname: string; points: number } | undefined;
  private roomId: string | null = null;
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

  /** 群消息的内容走 REST；推送由 socket 事件带给渲染层。 */
  sendGroupText(groupId: string, content: string): Promise<ApiResult<GroupMessageView>> {
    return this.api.sendGroupText(groupId, content);
  }

  groupMessages(groupId: string, limit = 50): Promise<ApiResult<{ messages: GroupMessageView[] }>> {
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
    this.roomId = roomId;
    this.set({ name: "room", roomId, snapshot: null, match: null, actions: [], lastResult: null, busy: true });
    this.socket = new MatchSocket({ url: this.socketUrl, token, factory: this.sockets });
    this.socket.on((event) => this.handleSocketEvent(event));
    await this.socket.connect(roomId);
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

  private handleSocketEvent(event: SocketEvent): void {
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

  private set(screen: Screen): void {
    this.screen = screen;
    for (const listener of this.listeners) listener(screen);
  }
}
