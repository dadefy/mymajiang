import type { MatchState, Screen, SeatControl, Tile } from "@mianyang-mahjong/client";
import { tableSide, deadlineSeconds } from "../ui/landscape-table.js";
import { addedTile } from "../ui/table-layout.js";
import type { AnimationPayload, SeatSide } from "./animation/animation-spec.js";
import type { AnimationCue, AnimationCoordinator } from "./animation/AnimationCoordinator.js";
import type { AudioManager, ConfirmedAudioEvent, UiCue } from "./audio/AudioManager.js";

/** 房间页那一种 `Screen`（表现层唯一需要细看的页面）。 */
type RoomScreen = Extract<Screen, { name: "room" }>;
type ChatScreen = Extract<Screen, { name: "chat" }>;

/** 一帧牌桌里**表现层要看**的那几个字段，按座位摊平，便于差分。 */
interface FrameView {
  roundNumber: number;
  phase: MatchState["phase"];
  seat: number;
  currentPlayerSeat: number | null;
  control: SeatControl;
  hand: Tile[];
  /**
   * 这一帧刚摸到的那张牌（推不出来时为 null）。
   *
   * 牌桌把它抽出来排在最右，所以**显示槽位**与数组下标不是一回事，动画要的是前者。
   */
  drawn: Tile | null;
  /** 服务端操作超时时刻（Unix 毫秒）；老服务端可能不带。 */
  deadlineAt: number | null;
  players: Array<{ seat: number; discards: number; lastDiscard: Tile | null; melds: number; lastMeldKind: string; lastMeldTile: Tile | null; won: boolean }>;
}

/** 只读渲染用的事件出口；页面不直接碰 `AudioManager` 与 `AnimationCoordinator`。 */
export interface PresentationDirectorOptions {
  readonly audio: AudioManager;
  readonly animations: AnimationCoordinator;
  /** 注入时钟，便于单测里稳定地跑倒计时。 */
  now?: () => number;
}

/**
 * 一小场共几秒的兜底：服务端只下发 `actionDeadlineAt`（截止时刻），不下发时长。
 *
 * 我们改成在**第一次看到某个截止时间**时把当时的剩余秒数当作总时长，所以这个常量
 * 只在那一帧之前就拿到过截止时间的极端情况下才会用到。
 */
const FALLBACK_TURN_SECONDS = 20;

/** 倒计时提醒的分档：到点各响一次，同一秒不重复。 */
const WARNING_SECONDS = [5, 4, 3, 2, 1] as const;

/**
 * 仅靠**状态差分**推不出来的事件，写清楚而不是硬凑。
 *
 * 见任务书：「如果某个事件仅靠状态 diff 无法可靠判断，先报告，不要为了触发动画去修改业务协议。」
 * 这些缺口都已经有**入口**（下面的 `notify*` 方法），缺的只是调用点，不需要改协议。
 */
export const NOT_DERIVABLE_FROM_STATE: readonly string[] = [
  // 「过」不留痕迹：碰与过之后 melds 都不变，actions 列表的变化也区分不开是谁放弃。
  "pass（服务端事件；当前由 notifyPass() 在玩家点「过」时本地触发）",
  // 摸到的是哪张牌能推，但「自摸」与「点炮」要等结算帧里的 wins 才知道。
  "self-draw 音效区分（需 result.wins[].method，已在结算帧里）",
  // 对手弃牌的**飞牌**动画需要三家牌河的镜像坐标，那属于牌桌布局（不在本任务改动范围）。
  "对手弃牌飞牌动画（当前只有音效）",
];

/**
 * 业务状态 → 表现事件的**唯一**转换器。
 *
 * 存在的全部理由：麻将规则与渲染代码里不该散落 `playSound(...)` / `Tween.to(...)`。
 * 页面只负责「渲染完之后把这一帧交给我」，剩下的事件识别、去重、动画与音效都由这里派发。
 *
 * 三条不变量：
 * 1. **只跟在服务端状态后面**：所有事件都由两帧之间的差异推出，绝不预测下一步。
 * 2. **同一帧重复渲染不发任何事件**：轮询、重绘、F5 之后回到同一状态都是安静的。
 * 3. **重连不重放历史**：进房第一帧与旧帧（轮次倒退）一律只对齐持续态，不发事件。
 */
export class PresentationDirector {
  private readonly now: () => number;
  private pageName: Screen["name"] | null = null;
  private roomId: string | null = null;
  private signature = "";
  private revision = 0;
  /** 已合成过的事件序号，只用于保证 eventId 不撞车。 */
  private emitted = 0;
  private frame: FrameView | null = null;
  private actionsCount = 0;
  private lastRoundResult: RoomScreen["lastResult"] | null = null;
  private lastMatchResult: RoomScreen["lastMatchResult"] | null = null;
  private lastMessageId: string | null = null;
  /** 本轮倒计时的总时长（第一次看到某个截止时间时定格）。 */
  private turnTotalSeconds = FALLBACK_TURN_SECONDS;
  private trackedDeadline: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly options: PresentationDirectorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /* ------------------------------------------------------------------ *
   * 页面级入口
   * ------------------------------------------------------------------ */

  /**
   * 每渲染一帧调用一次（`ScreenHost.render` 与 `RoomPage.show` 各一处，别处不需要）。
   *
   * 顺序是「先渲染、再交给表现层」：这样动画永远压在完成后的画面上，
   * 中途来新帧也只是把在途动画收掉，不会出现动画与牌桌各画一半。
   */
  observe(screen: Screen): void {
    if (this.disposed) return;
    this.syncBgm(screen);
    this.syncSustainedTimer();
    if (this.pageName !== screen.name) {
      const first = this.pageName === null;
      this.pageName = screen.name;
      // 进应用那一跳不播转场：没有「从哪来」，帷幕平白盖一下反而像卡了。
      if (!first) this.options.animations.playLocal("screen-transition");
    }
    if (screen.name === "room") {
      this.observeRoom(screen);
      return;
    }
    if (screen.name === "chat") this.observeChat(screen);
    // 不在牌桌上：牌桌的持续态一律收掉，别留一个还在呼吸的环。
    this.frame = null;
    this.signature = "";
    this.options.animations.setActivePlayer(null);
    this.options.animations.setCountdown(null, null);
  }

  /** 聊天页：新消息一声提示。自己发的与刚进群看到的那条都不算。 */
  private observeChat(screen: ChatScreen): void {
    const last = screen.messages[screen.messages.length - 1];
    const id = last ? last.messageId : null;
    const previous = this.lastMessageId;
    this.lastMessageId = id;
    if (id === null || previous === null || previous === id) return;
    if (last && last.senderId !== screen.meId) this.options.audio.playUi("messageReceive");
  }

  /** 场景音乐：大厅 / 等待房 / 牌桌三档（素材未就位时只记意图，不发请求）。 */
  private syncBgm(screen: Screen): void {
    const audio = this.options.audio;
    if (screen.name === "room") {
      const status = screen.snapshot?.status ?? null;
      if (status === "waiting") audio.playSceneBgm("waitingRoom");
      else if (status === "playing") audio.playSceneBgm("game");
      return;
    }
    audio.playSceneBgm("lobby");
  }

  /* ------------------------------------------------------------------ *
   * 牌桌：状态差分
   * ------------------------------------------------------------------ */

  private observeRoom(screen: RoomScreen): void {
    if (this.roomId !== screen.roomId) {
      this.roomId = screen.roomId;
      this.frame = null;
      this.signature = "";
      this.actionsCount = 0;
      this.lastRoundResult = null;
      this.lastMatchResult = null;
    }
    this.diffResults(screen);

    const match = screen.match;
    if (match === null) {
      // 局间停留与结束态：服务端不再发 `game` 帧，牌桌停在结算那屏。
      this.frame = null;
      this.signature = "";
      this.options.animations.setActivePlayer(null);
      this.options.animations.setCountdown(null, null);
      return;
    }
    const previous = this.frame;
    const drawn = previous === null ? null : addedTile(previous.hand, match.hand);
    const frame = frameOf(match, drawn);
    const signature = frameSignature(frame, screen.actions);
    // 同一帧重复渲染（2.5 秒轮询没变化、结算那屏自己重画）：一个事件都不发。
    if (signature === this.signature) return;
    // 轮次倒退 = 手上这帧比已知状态更早（重连时服务端可能先发旧的），整帧丢掉。
    if (previous !== null && frame.roundNumber < previous.roundNumber) return;
    this.signature = signature;
    this.revision += 1;
    this.options.animations.acceptSnapshot(this.revision);
    this.frame = frame;
    this.trackDeadline(frame);
    /**
     * 第一帧不发事件：那一帧的四家弃牌、副露与胡牌都是**别人已经走完的历史**，
     * 逐条补播会变成进房先炸一屏动画。只对齐持续态。
     */
    if (previous !== null && previous.roundNumber === frame.roundNumber) this.diff(previous, frame, screen);
    // 差完再记：`diff` 里「操作按钮刚出现」要靠**上一帧**的列表长度。
    this.actionsCount = screen.actions.length;
    this.syncSustained(frame);
  }

  /** 结算帧：`lastResult` / `lastMatchResult` 由 flow 换新对象才算新一场。 */
  private diffResults(screen: RoomScreen): void {
    const round = screen.lastResult;
    if (round && round !== this.lastRoundResult) {
      this.lastRoundResult = round;
      const total = round.totalRounds ?? 8;
      this.emit(round.roundNumber ?? 0, "roundFinish", "round-finished", "round-finished", {
        text: `第 ${round.roundNumber ?? "?"}/${total} 小场结束`,
      });
    }
    const match = screen.lastMatchResult;
    if (match && match !== this.lastMatchResult) {
      this.lastMatchResult = match;
      this.emit(match.completedRounds, "matchFinish", "match-finished", "match-finished", {
        text: match.reason === "dissolved" ? "本局已结束" : "整场结束",
      });
    }
  }

  private diff(previous: FrameView, frame: FrameView, screen: RoomScreen): void {
    const mine = frame.seat;

    /* ---------- 副露：碰 / 杠 ---------- */
    for (const now of frame.players) {
      const before = seatOf(previous.players, now.seat);
      if (!before || now.melds <= before.melds) continue;
      const side = sideOf(mine, now.seat);
      const payload = { side, tile: now.lastMeldTile ?? undefined };
      if (now.lastMeldKind === "kong") this.emit(frame.roundNumber, "gang", "kong", "kong", payload);
      else this.emit(frame.roundNumber, "peng", "peng", "peng", payload);
    }

    /* ---------- 胡：某一座的 `won` 由 false 变 true ---------- */
    const winners = frame.players.filter((player) => {
      const before = seatOf(previous.players, player.seat);
      return before !== undefined && !before.won && player.won;
    });
    if (winners.length > 0) {
      // 血战到底一局可能三家胡。印章只有一个位置，叠着放三张等于糊成一团，
      // 所以一帧之内只放**一次**强调（优先自己那家），不做逐家连播。
      const first = winners.find((player) => player.seat === mine) ?? winners[0];
      this.emit(frame.roundNumber, "hu", "hu", "hu", { side: sideOf(mine, first.seat), text: "胡" });
    }

    /* ---------- 弃牌 ---------- */
    const previousSlots = displaySlots(previous.hand, previous.drawn);
    for (const now of frame.players) {
      const before = seatOf(previous.players, now.seat);
      if (!before || now.discards <= before.discards) continue;
      if (now.seat !== mine) {
        // 三家弃牌只给声音：飞牌动画要落点，而对家牌河的坐标没有镜像（属牌桌布局）。
        this.options.audio.playConfirmed({ eventId: this.id(frame.roundNumber, `discard-${now.seat}`), source: "server", cue: "discard" });
        continue;
      }
      const tile = now.lastDiscard;
      this.emit(frame.roundNumber, "discard", "discard", "discard", {
        tile: tile ?? undefined,
        handIndex: tile === null ? 0 : Math.max(0, previousSlots.lastIndexOf(tile)),
        riverIndex: before.discards,
        side: "bottom",
      });
    }

    /* ---------- 摸牌：手牌恰好多一张且没有牌消失 ---------- */
    if (frame.drawn !== null && frame.currentPlayerSeat === mine) {
      this.emit(frame.roundNumber, "draw", "draw", "draw", {
        tile: frame.drawn,
        handIndex: displaySlots(frame.hand, frame.drawn).length - 1,
        isDrawn: true,
        side: "bottom",
      });
    }

    /* ---------- 轮到谁 ---------- */
    if (previous.currentPlayerSeat !== frame.currentPlayerSeat && frame.currentPlayerSeat !== null) {
      const isMine = frame.currentPlayerSeat === mine && frame.control === "human";
      void this.options.animations.playConfirmed({
        eventId: this.id(frame.roundNumber, `turn-${frame.currentPlayerSeat}`),
        source: "server",
        snapshotRevision: this.revision,
        cue: "turn-highlight",
        payload: { side: sideOf(mine, frame.currentPlayerSeat) },
      });
      // 只在自己被叫到时响一声：四家轮转每声都响就是轰炸。
      if (isMine) this.options.audio.playUi("turnNotify");
    }

    /* ---------- 托管 / 接管 ---------- */
    if (previous.control !== frame.control) {
      if (frame.control === "trustee") this.emit(frame.roundNumber, "trusteeOn", "trustee", "trustee-on");
      else this.emit(frame.roundNumber, "trusteeOff", "takeover", "trustee-off");
    }

    /* ---------- 换三张 / 定缺整排动作 ---------- */
    if (previous.phase !== frame.phase) {
      if (frame.phase === "swapping") this.emit(frame.roundNumber, "swap", "swap", "swap");
      if (frame.phase === "missing") this.emit(frame.roundNumber, "chooseMissing", "choose-missing", "choose-missing");
    }

    /* ---------- 操作按钮出现 ---------- */
    if (screen.actions.length > 0 && this.actionsCount === 0 && frame.currentPlayerSeat === mine) {
      void this.options.animations.playConfirmed({
        eventId: this.id(frame.roundNumber, "actionButtons"),
        source: "server",
        snapshotRevision: this.revision,
        cue: "action-buttons",
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 持续态与倒计时
   * ------------------------------------------------------------------ */

  /** 呼吸环与倒计时环：每帧按当前状态推一次，驱动内部自己判要不要重建。 */
  private syncSustained(frame: FrameView): void {
    const animations = this.options.animations;
    const live = frame.phase === "playing" || frame.phase === "claiming";
    animations.setActivePlayer(live && frame.currentPlayerSeat !== null ? sideOf(frame.seat, frame.currentPlayerSeat) : null);
    if (!live || frame.deadlineAt === null) animations.setCountdown(null, null);
    else animations.setCountdown(deadlineSeconds(frame.deadlineAt, this.now()), this.turnTotalSeconds);
  }

  /** 截止时间一换就把总时长定格，环才知道该扫多少。 */
  private trackDeadline(frame: FrameView): void {
    if (frame.deadlineAt === this.trackedDeadline) return;
    this.trackedDeadline = frame.deadlineAt;
    if (frame.deadlineAt === null) return;
    const remaining = deadlineSeconds(frame.deadlineAt, this.now());
    if (remaining !== null && remaining > 0) this.turnTotalSeconds = remaining;
  }

  /**
   * 倒计时到点提醒。
   *
   * 只有**轮到自己且人在操作**时才响 —— 三家的超时读秒一起滴答是最吵的做法。
   * 动画侧只改环的颜色（`countdownColor`），不做整屏闪烁。
   */
  tick(): void {
    if (this.disposed) return;
    const frame = this.frame;
    if (frame === null) return;
    const live = (frame.phase === "playing" || frame.phase === "claiming") && frame.control === "human";
    if (!live || frame.currentPlayerSeat !== frame.seat || frame.deadlineAt === null) return;
    const seconds = deadlineSeconds(frame.deadlineAt, this.now());
    if (seconds === null) return;
    this.options.animations.setCountdown(seconds, this.turnTotalSeconds);
    if (seconds > WARNING_SECONDS[0]) return;
    for (const mark of WARNING_SECONDS) {
      if (seconds > mark) continue;
      /**
       * 250ms 一跳会连着撞上同一秒，去重交给 `AudioManager` 的已播表：
       * 截止时间每一轮都是新值，所以「这一轮的 3 秒」天然只有一条记录。
       */
      this.options.audio.playConfirmed({
        eventId: `${this.roomId ?? "room"}:${frame.deadlineAt}:warn-${mark}`,
        source: "server",
        cue: mark === 1 ? "countdown-1" : "countdown-3",
      });
      return;
    }
  }

  private syncSustainedTimer(): void {
    if (this.disposed) return;
    const onTable = this.pageName === "room" && this.frame !== null;
    if (onTable && this.timer === null) this.timer = setInterval(() => this.tick(), 250);
    if (!onTable && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 页面里那些**只有点击才知道**的反馈
   * ------------------------------------------------------------------ */

  /** 通用按钮声（`widgets.textButton` 一处接，不散落）。 */
  notifyUi(cue: UiCue): void { this.options.audio.playUi(cue); }

  /**
   * 选中一张牌：抬起动画 + 牌面声。
   *
   * 页面只需要把**点到的那张牌**交进来 —— 槽位由这里按当前帧的显示顺序算，
   * 页面不必知道动画层怎么定位。
   */
  notifyTileSelect(tile: Tile): void {
    const frame = this.frame;
    if (frame === null || frame.control === "trustee") return;
    const slots = displaySlots(frame.hand, frame.drawn);
    const slot = slots.lastIndexOf(tile);
    if (slot < 0) return;
    this.options.audio.playUi("tileSelect");
    void this.options.animations.playLocal("select-tile", {
      handIndex: slot,
      tile,
      isDrawn: frame.drawn !== null && slot === slots.length - 1 && tile === frame.drawn,
      side: "bottom",
    });
  }

  /**
   * 玩家按下碰/杠/胡/过。
   *
   * 服务端**不会**为这些动作单独推事件，真正成立时那一帧自然会再发一次确认动画；
   * 这里给的只是按下瞬间的手感，所以不参与 eventId 去重，也不会改变牌桌。
   */
  notifyAction(action: "hu" | "peng" | "kong" | "pass"): void {
    if (action === "pass") { this.notifyPass(); return; }
    this.options.audio.playUi("button");
  }

  /** 「过」：一条柔和提示，不响强调音（见 `NOT_DERIVABLE_FROM_STATE`）。 */
  notifyPass(): void {
    this.options.audio.playUi("button");
    void this.options.animations.playLocal("pass", { side: "bottom" });
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  onBackground(): void {
    this.options.audio.onBackground();
    this.options.animations.onBackground();
  }

  onForeground(): void { this.options.audio.onForeground(); }

  /** 页面销毁：停表、收动画、放开播记录。之后再 observe 一律无效。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.frame = null;
    this.options.animations.dispose();
    this.options.audio.dispose();
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  /**
   * 合成事件标识。
   *
   * 服务端帧里**没有** id/seq/version（`eventId` 只存在于 REST 历史里，实时通道不推），
   * 所以表现层只能自己造。造的原则：同一次变化在任何重绘路径上都只会算出一个 id，
   * 而不同变化之间绝不撞车 —— 轮次 + 事件种类 + 全局递增序号。
   */
  private id(round: number, kind: string): string {
    return `${this.roomId ?? "room"}:${round}:${kind}#${++this.emitted}`;
  }

  /** 一个业务事件 = 一声 + 一段动画，共用同一个 eventId。 */
  private emit(round: number, kind: string, sound: ConfirmedAudioEvent["cue"], cue: AnimationCue, payload?: AnimationPayload): void {
    const eventId = this.id(round, kind);
    this.options.audio.playConfirmed({ eventId, source: "server", cue: sound });
    void this.options.animations.playConfirmed({ eventId, source: "server", snapshotRevision: this.revision, cue, payload });
  }
}

function frameOf(match: MatchState, drawn: Tile | null): FrameView {
  return {
    roundNumber: match.roundNumber,
    phase: match.phase,
    seat: match.seat,
    currentPlayerSeat: match.currentPlayerSeat,
    control: match.control ?? "human",
    hand: match.hand,
    drawn,
    deadlineAt: match.actionDeadlineAt ?? null,
    players: match.players.map((player) => {
      const last = player.melds[player.melds.length - 1];
      const river = player.discards;
      return {
        seat: player.seat,
        discards: river.length,
        lastDiscard: river.length > 0 ? river[river.length - 1] : null,
        melds: player.melds.length,
        lastMeldKind: last ? last.kind : "",
        lastMeldTile: last ? last.tile : null,
        won: player.won,
      };
    }),
  };
}

/**
 * 一帧的指纹。
 *
 * 手牌取**多重集**（排序后拼接）而不是原序：牌桌会把刚摸的那张排在最右，
 * 顺序变了不代表状态变了。
 */
function frameSignature(frame: FrameView, actions: readonly string[]): string {
  const hand = frame.hand.slice().sort((a, b) => a - b).join(".");
  const players = frame.players.map((player) => `${player.seat}=${player.discards}/${player.melds}/${player.won ? 1 : 0}`).join(",");
  return [
    frame.roundNumber, frame.phase, frame.currentPlayerSeat, frame.control,
    hand, players, frame.deadlineAt, actions.join(","),
  ].join("|");
}

function seatOf(players: FrameView["players"], seat: number): FrameView["players"][number] | undefined {
  for (const player of players) if (player.seat === seat) return player;
  return undefined;
}

function sideOf(mySeat: number, seat: number): SeatSide {
  return tableSide(mySeat, seat) as SeatSide;
}

/**
 * 手牌的**显示**顺序：牌桌把刚摸的那张抽出来排在最右，其余照原序。
 *
 * 动画要的是这个顺序里的槽位 —— 用数组下标会把幽灵牌画偏一格。
 * 同牌面的多张从右往左认（玩家点走的总是靠右那一张）。
 */
function displaySlots(hand: readonly Tile[], drawn: Tile | null): Tile[] {
  const rest = hand.slice();
  if (drawn === null) return rest;
  const at = rest.lastIndexOf(drawn);
  if (at < 0) return rest;
  rest.splice(at, 1);
  rest.push(drawn);
  return rest;
}
