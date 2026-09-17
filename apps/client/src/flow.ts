import { ApiClient, type ApiError, type ApiResult } from "./api-client.js";
import { MatchSocket, type SocketEvent } from "./match-socket.js";
import type {
  ActiveRoomView,
  GroupDetail,
  GroupMessagePage,
  GroupMessageView,
  GroupSummary,
  MatchResult,
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
      /**
       * 进行中的对局（登录时服务端告知）。有它就显示「回到房间」——
       * 有人退出后重新登录，靠这个入口回去接着打。
       */
      activeRoom: ActiveRoomView | null;
      busy: boolean;
      error?: string | undefined;
    }
  | {
      name: "room";
      roomId: string;
      /** 6 位房间号；进房时由调用方带上，之后以快照为准。 */
      roomNo: string | null;
      snapshot: RoomSnapshot | null;
      /** 当前这一局；还没开局或还没收到第一帧时为空。 */
      match: MatchState | null;
      actions: string[];
      /** 最近一局的结算，弹窗用。**只有单局**形状（整场的见 `lastMatchResult`）。 */
      lastResult: RoomResult | null;
      /**
       * 整场结算（打满 8 局或中途解散）。
       *
       * 必须与 `lastResult` 分开：两者在服务端来自不同的包（规则包 / 域包），
       * 字段完全不同（`deltas` vs `rawDeltas` + `accountDeltas`）。
       * 之前合用一个字段，`match-finished` 一来，渲染层按单局去读就抛异常。
       */
      lastMatchResult: MatchResult | null;
      /**
       * 本地时刻：**这一小场那屏数字要显示到什么时候**（服务端下发了停留时长时才有值）。
       *
       * 存**时刻**而不是「还剩几秒」：倒计时要在渲染层随本地时钟推进，
       * 存一个固定的秒数没法动。为 null 表示不停留（或老服务端不下发）。
       *
       * 名字不是「下一小场几时开始」而是「这屏显示到几时」：打满 8 小场时**没有**下一小场，
       * 但这一屏仍然要显示满 3 秒再交接给整局结算记录 —— 所以 `match-finished` **不清它**
       * （清了的话最后一小场那屏就不知道自己该什么时候让位，结算记录永远不出现）。
       * 清它的时机是收到新一局的 `game` 帧（见下面 `game` 分支）。
       */
      roundPopUntil: number | null;
      /**
       * 这一局已经结算、但下一局还没开始（收到 `round-finished` 到收到新局的 `game` 帧之间）。
       *
       * **不能用 `match.phase === "finished"` 代替**：服务端在一局结束时只发结算帧、
       * 不发 `game` 帧（见 ws-server 的 broadcastState），所以客户端的 `match` 永远停在
       * 结束**之前**的那个状态（playing / claiming），那个判据一次都不会成立。
       */
      roundFinished: boolean;
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

/**
 * 服务端透传的英文错误 → 中文。
 *
 * 域层抛的是英文句子，服务端**原样透传**，而它有两条出口：REST 放在 `message` 里、
 * 实时通道放在 `error` 帧的 `message` 里。所以翻译只能放在客户端，而且两个入口都要过。
 */
const DOMAIN_ERROR_TEXT: Record<string, string> = {
  // 开局与准备
  "Four players are required": "要四个人才能开局",
  "All players must be ready": "还有玩家没有准备",
  "Only the room owner can start the match": "只有房主能开局",
  "Room is not waiting to start": "这个房间已经开局了",
  "Match has already started": "这局已经在打了",
  "Match has not started": "对局还没开始",
  "Room is not playable": "这个房间现在不能开局",
  "Ready state is locked after the match starts": "开局之后不能再改准备状态",
  // 进出房间
  "ROOM_NOT_FOUND": "没有这个房间号，可能房主已经解散了",
  "Room has already started": "这局已经开始了，回去接着打吧",
  "Player is already in the room": "你已经在这间房里了",
  "Player is not in the room": "你不在这个房间里",
  "Room is full": "房间满了，一桌只能坐四个人",
  "Players cannot leave after the match starts": "开局之后不能退出房间",
  "Active account with at least 500 points is required": "积分不足 500，暂时进不了牌局",
  // 「已经有一局在进行中」原本和上一条共用英文原文，报出来是「积分不足」——
  // 完全指错方向。域层已把它们拆开（见 packages/domain 的 assertCanJoin）。
  "Active account already has a match in progress": "这个账号还在一局没打完的牌局里，先回那一局打完再来",
  // 连接与身份
  "Not authenticated": "登录状态已失效，请重新登录",
  "ACCOUNT_NOT_ACTIVE": "账号已被停用",
  // 断线重连有时间窗（见 packages/domain 的 reconnect）：窗口内回来能接着打，
  // 超时就回不去了。这条原先会原样显示英文码给用户。
  "RECONNECT_WINDOW_EXPIRED": "离开太久，那一局已经回不去了",
};

function translateDomainError(message: string): string | undefined {
  return DOMAIN_ERROR_TEXT[message];
}

function describe(error: ApiError): string {
  if (error.kind === "network") return "连不上服务器，请稍后再试";
  if (error.code === "KEY_INVALID") return "邀请密钥不存在";
  if (error.code === "KEY_REVOKED") return "邀请密钥已被撤销";
  if (error.code === "KEY_MALFORMED") return "邀请密钥格式不对";
  if (error.code === "ACCOUNT_NOT_ACTIVE") return "账号已被停用";
  if (error.message) return translateDomainError(error.message) ?? error.message;
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
  /**
   * 进行中的对局，来自登录响应。
   *
   * 之所以留一份在客户端：`leaveRoom` 回主页时不该再登一次录，而主页要显示什么
   * 得有个依据 —— 这份值就是。它只在两处失效：账号换人（登录/登出），
   * 以及**自己看到这一局已经结束**（快照或结算帧），那时入口就该消失。
   */
  private activeRoom: ActiveRoomView | null = null;
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
    this.activeRoom = null;
    this.api.setToken(undefined);
    this.set({ name: "key-entry", busy: false });
  }

  /** 输入密钥：已激活的进主页，没激活的进资料页。 */
  get currentUserId(): string | undefined { return this.me?.userId; }
  get activeRoomNumber(): string | undefined { return this.activeRoom?.roomNo; }
  async enterAccount(userId: string, password: string): Promise<void> {
    this.set({ name: "key-entry", busy: true });
    const result = await this.api.loginAccount(userId.trim(), password);
    if (result.ok) await this.enterHome(result.value);
    else this.set({ name: "key-entry", busy: false, error: result.error.code === "INVALID_CREDENTIALS" ? "账号或密码错误，请确认已用密钥登录并设置密码" : describe(result.error) });
  }
  async savePassword(password: string): Promise<string> {
    const result = await this.api.setPassword(password);
    return result.ok ? "密码已设置，可使用账号 ID 和密码登录" : describe(result.error);
  }
  searchGroups(query: string) { return this.api.searchGroups(query.trim()); }
  async createGroup(name: string): Promise<string | undefined> {
    const result = await this.api.createGroup(name.trim());
    if (!result.ok) return describe(result.error);
    await this.openChat(result.value.groupId);
  }
  async joinGroup(groupNo: string): Promise<string | undefined> {
    const result = await this.api.joinGroup(groupNo);
    if (!result.ok) return describe(result.error);
    await this.openChat(result.value.groupId);
  }
  async manageGroup(action: string, body: object): Promise<string | undefined> {
    if (this.screen.name !== "chat") return;
    const result = await this.api.manageGroup(this.screen.groupId, action, body);
    if (!result.ok) return describe(result.error);
    await this.refreshChat();
  }
  listShareGroups() { return this.api.groups(); }
  async shareRoom(groupId: string): Promise<string | undefined> {
    const roomNo = this.screen.name === "room" ? this.screen.roomNo : this.activeRoom?.roomNo;
    if (!roomNo) return "请先创建或加入房间";
    const result = await this.api.sendGroupMessage(groupId, { type: "room_invite", content: JSON.stringify({ roomNo }) }, newIdempotencyKey());
    if (!result.ok) return describe(result.error);
    if (this.screen.name === "chat") await this.refreshChat();
  }

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
    // 已经在加载中就不再推一帧「加载中」：`enterHome` 刚设过一次，
    // 无条件再设会让「回首页」多闪一次（onChange 是按对象引用比的，值一样也算一次变化）。
    if (!this.screen.busy) this.set({ ...this.screen, busy: true });
    const [groups, matches, me] = await Promise.all([this.api.groups(), this.api.matches(), this.api.me()]);
    if (me.ok) this.activeRoom = me.value.activeRoom;
    const matchesUnavailable = !matches.ok && matches.error.kind === "unavailable";
    const failure = groups.ok ? (matches.ok || matchesUnavailable ? null : matches.error) : groups.error;
    this.set({
      name: "home",
      // 用刚拉回来的账号状态覆盖登录时那份快照：**积分只在整局结算时改**，
      // 打完一整局回到首页，不覆盖就还是开局前的余额（看着像「分没进账」）。
      // `me` 拉失败时保留原值 —— 它只影响积分显示，不该把整页判成失败。
      me: me.ok
        ? { userId: me.value.userId, nickname: me.value.nickname, points: me.value.points }
        : this.screen.me,
      groups: groups.ok ? groups.value.groups : [],
      matches: matches.ok ? matches.value.matches : [],
      matchesUnavailable,
      activeRoom: this.activeRoom,
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
    await this.enterRoom(created.value.roomId, created.value.roomNo);
  }

  /**
   * 按 6 位房间号加入。
   *
   * 本地先查一遍格式：服务端也会拒（6 位数字），但它返回的是通用的「参数不合法」，
   * 不如在这里直接说清楚该输什么 —— 输错号码是内测里最常见的一种「点了没反应」。
   */
  async joinRoom(rawRoomNo: string): Promise<void> {
    if (this.screen.name !== "home" && this.screen.name !== "chat") return;
    const roomNo = rawRoomNo.trim();
    if (!/^\d{6}$/.test(roomNo)) {
      this.set({ ...this.screen, ...(this.screen.name === "home" ? { busy: false } : {}), error: "房间号是 6 位数字，请再确认一下" });
      return;
    }
    this.set({ ...this.screen, ...(this.screen.name === "home" ? { busy: true } : {}) });
    const joined = await this.api.joinRoom(roomNo);
    if (!joined.ok) {
      this.set({ ...this.screen, ...(this.screen.name === "home" ? { busy: false } : {}), error: describe(joined.error) });
      return;
    }
    await this.enterRoom(joined.value.roomId, joined.value.roomNo);
  }

  /**
   * 回到进行中的那一局。
   *
   * **不再调「加入」**：人本来就在房间里，而对局中调 join 会被域层拒绝
   * （`Players cannot leave after the match starts` 那一类规则）；
   * 服务端在登录时已经确认过这间房还能回去（见 `activeRoomView`）。
   * 重连本身由实时通道负责 —— `enterRoom` 会带上同一间房重新握手。
   */
  async rejoinActiveRoom(): Promise<void> {
    if (this.screen.name !== "home") return;
    const active = this.screen.activeRoom;
    if (!active) return;
    await this.enterRoom(active.roomId, active.roomNo);
  }

  /** 离开房间并断开该房间的实时通道，然后回主页。 */
  async leaveRoom(): Promise<void> {
    // 对局中离开会被服务端拒绝（规则不允许中途走人），那就留在这一局里 ——
    // 主页因此要照旧显示「回到房间」，所以 `activeRoom` 原样带着走。
    if (this.roomId) {
      const result = await this.api.leaveRoom(this.roomId);
      if (!result.ok) {
        if (this.screen.name === "room") this.set({ ...this.screen, notice: describe(result.error) });
        return;
      }
      this.activeRoom = null;
    }
    this.closeSocket();
    this.roomId = null;
    // 不能用 refreshHome()：当前页面还是 room，它会在原地返回。
    await this.enterHome({ ...this.meOrFail(), activeRoom: this.activeRoom });
  }

  /**
   * 重拉当前房间快照。
   *
   * 等待期的「谁准备了 / 谁刚加入」只能靠它刷新 —— 实时通道目前只推对局帧
   * （`game` / `actions`），不推房间成员变化（见 `PROJECT_STATUS` 4.22）。
   * 渲染层可以定时调它（LayaAir 的房间页就是这么做的），
   * 而准备 / 开局这类自己发起的动作则应当**调完立刻拉一次**，否则界面不变、看起来像没反应。
   */
  async refreshRoom(): Promise<void> {
    if (this.screen.name !== "room") return;
    const snapshot = await this.api.room(this.screen.roomId);
    if (this.screen.name !== "room") return;
    if (snapshot.ok) this.forgetActiveRoomIfOver(snapshot.value.status);
    this.set({
      ...this.screen,
      roomNo: snapshot.ok ? snapshot.value.roomNo : this.screen.roomNo,
      snapshot: snapshot.ok ? snapshot.value : this.screen.snapshot,
      ...(snapshot.ok ? {} : { notice: describe(snapshot.error) }),
    });
  }

  /**
   * 这一局已经结束：把「回到房间」的入口撤掉。
   *
   * 服务端那边 `activeMatchId` 一并被清了（见 `MatchRoom.finalize`），
   * 客户端不该比它记得更久 —— 否则主页会一直挂着一个回不去、或者回去了也没得打的房间。
   */
  private forgetActiveRoomIfOver(status: RoomSnapshot["status"]): void {
    if (status === "finished" || status === "dissolved") this.activeRoom = null;
  }

  async setReady(ready: boolean): Promise<void> {
    if (this.roomId === null) return;
    const result = await this.api.setReady(this.roomId, ready);
    if (!result.ok) {
      // 失败必须有反馈。之前这里是静默的，看起来就是「点了没反应」。
      if (this.screen.name === "room") this.set({ ...this.screen, notice: describe(result.error) });
      return;
    }
    await this.refreshRoom();
  }

  /**
   * 房主开始对局。
   *
   * **走实时通道，不走 REST。** 对局本身活在实时层（`ActiveMatch`），而 REST 的
   * `POST /v1/rooms/:roomId/start` 只把房间状态改成 `playing` —— 实时层不会因此知道要开局，
   * 而四个人的连接早在开局之前就建好了，之后不会再有握手，于是**谁都收不到首帧**，
   * 表现就是「点了开始，什么都没发生」。`{type:"start"}` 那条路会做完
   * `room.start()` + 建局 + 向四个座位广播首帧（见 `ws-server` 的 start 分支）。
   *
   * 失败（人不够、有人没准备、只有房主能开局）会以 `error` 帧回来，由房间页显示。
   */
  async startMatch(): Promise<void> {
    if (this.roomId === null) return;
    if (!this.socket) {
      // 没有实时通道就开不了局，别让它静默失败。
      if (this.screen.name === "room") {
        this.set({ ...this.screen, notice: "连接已断开，请重新进入房间后再开局" });
      }
      return;
    }
    this.socket.send({ type: "start" });
    // 开局后立刻拉一次快照：`status` 要变成 "playing"。
    //
    // 不拉的话快照会永远停在 "waiting"（它只在进房、准备时刷新过），
    // 而渲染层是**按快照状态决定显示准备按钮还是对局操作**的 ——
    // 结果整局都停在「我准备好了 / 开始对局」那一屏，
    // 碰、杠、胡、过这些按钮永远没有机会出现（只在 claiming 阶段下发）。
    //
    // 与 `setReady` 一样是 `await` 的：调用方（含测试）拿到返回时快照已经更新。
    await this.refreshRoom();
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
    // 带着进行中的对局回主页：从群聊退回主页时，那个入口不该消失。
    await this.enterHome({ ...this.meOrFail(), activeRoom: this.activeRoom });
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

  private async enterHome(session: { userId: string; nickname: string; points: number; activeRoom: ActiveRoomView | null }): Promise<void> {
    // 令牌在登录那一刻就已由 ApiClient 自动持有；这里只记住「我是谁」与「有没有对局在等我」，
    // 离开房间回主页时要用。
    this.me = { userId: session.userId, nickname: session.nickname, points: session.points };
    // `?? null` 是防御性的：万一对面是还没带这个字段的旧版本，页面不该因此拿到 undefined。
    this.activeRoom = session.activeRoom ?? null;
    this.set({
      name: "home",
      me: this.me,
      groups: [],
      matches: [],
      matchesUnavailable: false,
      activeRoom: this.activeRoom,
      busy: true,
    });
    // 群列表、战绩与**最新积分**统一交给 refreshHome：原先这里是同一段拉取的副本，
    // 两处各维护一份必然漂移 —— 打完一整局回首页要重新拉账号状态（积分是在结算那一刻改的），
    // 只加在 refreshHome 里的话，走 leaveRoom 这条路仍会显示开局前的旧余额。
    await this.refreshHome();
  }

  private meOrFail(): { userId: string; nickname: string; points: number } {
    if (!this.me) throw new Error("Not signed in");
    return this.me;
  }

  private async enterRoom(roomId: string, roomNo: string | null = null): Promise<void> {
    // 令牌由 ApiClient 在登录那一刻自动持有；实时通道要带上同一个令牌。
    const token = this.api.token;
    if (!token) throw new Error("Not signed in");
    // 进房间前先收掉上一条通道：它可能只是一条订阅了群聊的连接，
    // 留着会同时收两边的帧，而且关闭旧连接前必须先摘掉它的监听（见 MatchSocket.connect）。
    this.closeSocket();
    this.earlierCursor = undefined;
    this.roomId = roomId;
    this.set({ name: "room", roomId, roomNo, snapshot: null, match: null, actions: [], lastResult: null, lastMatchResult: null, roundPopUntil: null, roundFinished: false, busy: true });
    const socket = new MatchSocket({ url: this.socketUrl, token, factory: this.sockets });
    socket.on((event) => this.dispatchSocketEvent(event));
    this.socket = socket;
    await socket.connect(roomId);
    const snapshot = await this.api.room(roomId);
    if (snapshot.ok) this.forgetActiveRoomIfOver(snapshot.value.status);
    this.set({
      name: "room",
      roomId,
      roomNo: snapshot.ok ? snapshot.value.roomNo : roomNo,
      snapshot: snapshot.ok ? snapshot.value : null,
      match: null,
      actions: [],
      lastResult: null,
      lastMatchResult: null,
      roundPopUntil: null,
      roundFinished: false,
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
        // 新一局的第一帧会经过这里 —— 上一小场那屏数字该退场了，它的显示时限也随之作废。
        this.set({ ...this.screen, match: event.state, busy: false, roundFinished: false, roundPopUntil: null });
        return;
      case "actions":
        this.set({ ...this.screen, actions: event.actions });
        return;
      case "round-finished":
        // 服务端在这之后会停一会儿（给四家看清这一小场各赢输多少）再开下一小场。
        // 把停留时长换算成「这屏显示到几时」，桌面上那组数字与它的倒计时据此推进。
        this.set({
          ...this.screen,
          lastResult: event.result,
          roundFinished: true,
          roundPopUntil: event.nextRoundInMs > 0 ? Date.now() + event.nextRoundInMs : null,
        });
        return;
      case "match-finished":
        // 打完了就没有「回到这一局」可言了，入口同快照一起失效。
        // 整场结算单独存 —— 它的形状和单局结算完全不同（见 `lastMatchResult`）。
        // ⚠️ `roundPopUntil` **有意不清**：打满 8 小场时没有下一小场，但最后一小场那屏
        // 仍要显示满停留时长再交接给整局结算记录 —— 它得知道那是什么时候（见类型上的说明）。
        this.activeRoom = null;
        this.set({ ...this.screen, lastMatchResult: event.result, match: null, actions: [] });
        return;
      case "error":
        // 实时通道的失败也要翻译：它和 REST 一样透传域层的英文原文。
        this.set({ ...this.screen, notice: translateDomainError(event.message) ?? event.message });
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
        this.set({ ...this.screen, notice: translateDomainError(event.message) ?? event.message });
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
