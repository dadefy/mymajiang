import { shareDialog, socialAvatar } from "./SocialDialogs.js";
import type { PresentationDirector } from "../presentation/PresentationDirector.js";
import type { ApiClient, ClientFlow, MatchState, MatchResult, RoomResult, RoomSnapshot, Screen, Suit, Tile } from "@mianyang-mahjong/client";
import { matchTimeText, roundLabel, winSummaryText } from "@mianyang-mahjong/client";
import {
  actionAvailable,
  discardableIndexes,
  selectedTiles,
  sortedHand,
  swapSelectionIsValid,
  tileAsset,
} from "./table-model.js";
import { acceptRoomSnapshot, deadlineSeconds, effectiveRoomStatus, roundPopIsLive, tableSide } from "./landscape-table.js";
import {
  ACTION_GAP,
  ACTION_LABEL,
  ACTION_WIDTH,
  BACK_SIDE_GAP,
  BACK_SIDE_H,
  BACK_SIDE_W,
  BACK_TOP_GAP,
  BACK_TOP_H,
  BACK_TOP_W,
  DIAL_SIZE,
  DISCARD_GAP_X,
  DISCARD_GAP_Y,
  DISCARD_H,
  DISCARD_W,
  HAND_TILE_GAP,
  HAND_TILE_H,
  HAND_TILE_W,
  MELD_H,
  MELD_MAX_W,
  MELD_W,
  SAFE,
  SEAT_AVATAR,
  SEAT_COL_W,
  SEAT_W,
  SIDE_RIVER_Y,
  TABLE_H,
  WIND_SLOTS,
  Y,
  actionButtons,
  actionsWidth,
  activeWindSlot,
  addedTile,
  huSummary,
  isFinalCountdown,
  type TableSide,
  type WindSlot,
} from "./table-layout.js";
import {
  TABLE_HEIGHT,
  TABLE_WIDTH,
  THEME,
  box,
  circle,
  fmtDelta,
  label,
  line,
  poly,
  refill,
  roundRect,
  scrollList,
  setButtonText,
  textButton,
  tileName,
  tileRun,
} from "./widgets.js";
import {
  SKIN,
  SLAB,
  TABLE_THEME,
  a2,
  addTileFace,
  avatarDisc,
  faceTile,
  handTile,
  iconButton,
  inkPanel,
  pieMask,
  plate,
  setPie,
  tileBack,
  tileWall,
  type A2Key,
} from "./table-skin.js";

const PHASE_NAMES: Record<MatchState["phase"], string> = {
  swapping: "换三张",
  missing: "定缺",
  playing: "出牌阶段",
  claiming: "等待操作",
  finished: "已结束",
};

const SUIT_NAMES: Record<Suit, string> = { wan: "万", tong: "筒", tiao: "条" };

const STATUS_NAMES: Record<RoomSnapshot["status"], string> = {
  waiting: "等待中",
  playing: "对局中",
  finished: "已结束",
  dissolved: "已解散",
};

/** 桌芯四个方向格的文字。固定牌桌方向，不代表服务端风位（见 table-layout 的说明）。 */
const WIND_TEXT: Record<WindSlot, string> = { N: "北", E: "东", S: "南", W: "西" };

/** 一整局几小场。服务端每帧都会带 `totalRounds`，这里只是它缺席时的兜底。 */
const TOTAL_ROUNDS_FALLBACK = 8;

/**
 * 倒计时字号：正常 / 最后三秒。行高必须 ≥ 字号 ×1.3，否则 CJK 数字的字形盒会被裁。
 *
 * 上限由罗盘的环决定：环 98、圈厚约 7，内孔只有 86，58 的字号会把环撑破。
 */
const CLOCK_FONT = 46;
const CLOCK_FONT_FINAL = 54;
const clockLine = (font: number): number => Math.ceil(font * 1.3);

/**
 * 中心倒计时环的直径（画在 210 的玉盘正中）。
 *
 * 环带落在半径 43~49 那一圈，四个方向胶囊的内沿必须停在 57 之外 —— 环再大一点
 * 就会从东西两枚胶囊身上穿过去。
 */
const DIAL_RING = 98;

/** 倒计时行的顶边：读数就是罗盘的圆心，上下都不再压第二行字。 */
const clockTop = (font: number): number => DIAL_SIZE / 2 - clockLine(font) / 2;

/**
 * 四个方向胶囊在玉盘上的落位（相对桌芯左上角）。
 *
 * 南北横排、东西竖排，都不越出圆盘。东西两枚特意收窄并贴到盘边：它们的内沿
 * 离圆心 57，正好让开半径 43~49 的倒计时环带，不再被环穿过去。
 */
const WIND_PILL: Record<WindSlot, { x: number; y: number; w: number; h: number }> = {
  N: { x: 74, y: 14, w: 62, h: 30 },
  S: { x: 74, y: 166, w: 62, h: 30 },
  W: { x: 2, y: 90, w: 46, h: 30 },
  E: { x: 162, y: 90, w: 46, h: 30 },
};

/**
 * 顶栏通知带：左边让开「房号牌匾」（约 370 收口），右边让开右侧栏第一枚图标（1648 起）。
 *
 * 通知只能待在顶栏这一行 —— 往下一点到 `Y.topbar + 52` 就压住对家的座位信息（`Y.topInfo`）。
 */
const NOTICE_X = 480;
const NOTICE_W = 1120;

/**
 * 右侧栏三枚图标按钮（规则 / 设置 / 退出）：从右往左等距排，最右一枚收在安全边内。
 *
 * `iconButton` 的节点高是 `size + 28`（圆底 + 下方短文字），所以这一栏比顶栏文字略高一点，
 * 纵向中心对到 `Y.topbar` 那一行才不显得往下坠。
 */
const RAIL_SIZE = 68;
const RAIL_Y = Y.topbar - 6;
const RAIL_X = [
  TABLE_WIDTH - SAFE - RAIL_SIZE - 2 * (RAIL_SIZE + 18),
  TABLE_WIDTH - SAFE - RAIL_SIZE - 1 * (RAIL_SIZE + 18),
  TABLE_WIDTH - SAFE - RAIL_SIZE,
] as const;

/** 碰/杠/胡 的瞬时提示位置（贴着**动作发起方**的手牌一侧，不压牌河/副露/桌芯）。 */
const SHOUT_ANCHOR: Record<TableSide, { x: number; y: number }> = {
  bottom: { x: 700, y: 806 },
  top: { x: 1236, y: 156 },
  left: { x: 292, y: 214 },
  right: { x: 1392, y: 214 },
};

/** 设置面板那三个开关的键。 */
type SettingKey = "music" | "sfx" | "voice";

/**
 * 定缺 → A2 那三枚花色胶囊。没定缺就什么都不画。
 *
 * 胶囊上的「缺万 / 缺筒 / 缺条」字样与配色都由资源给（任务书第十五条：
 * 不许前端自己拿黄字糊一个「缺」）。
 */
function missingBadgeKey(suit: Suit | null | undefined): A2Key | null {
  return suit === "wan" || suit === "tong" || suit === "tiao" ? `badge_missing_${suit}` : null;
}

/** 倒计时配色分档：宽裕时象牙、十秒内转金、五秒内朱红。只有颜色变，不闪全屏。 */
function clockColor(seconds: number | null): string {
  if (seconds === null) return TABLE_THEME.ivory;
  if (seconds <= 5) return TABLE_THEME.vermilion;
  if (seconds <= 10) return TABLE_THEME.gold;
  return TABLE_THEME.ivory;
}

/**
 * 把一串文本放进剪贴板，返回**是否真的成功**。
 *
 * `navigator.clipboard` 在非安全上下文（Http 调试页、部分 Android WebView）里直接是 undefined
 * 或者抛错，所以留一条隐藏 textarea + `execCommand("copy")` 的退路。
 * 两条都不成也不骗人 —— 调用方据此决定要不要亮「已复制」。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = (Laya.Browser.window as {
    navigator?: { clipboard?: { writeText?: (s: string) => Promise<void> } };
  }).navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      /* 落到下面的 execCommand 退路 */
    }
  }
  const doc = Laya.Browser.document as unknown as {
    body?: { appendChild: (n: unknown) => void; removeChild: (n: unknown) => void };
    execCommand?: (command: string) => boolean;
  };
  if (!doc.body || !doc.execCommand) return false;
  let area: HTMLTextAreaElement;
  try {
    area = Laya.Browser.createElement("textarea");
  } catch {
    return false;
  }
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "absolute";
  area.style.left = "-9999px";
  doc.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  }
  doc.body.removeChild(area);
  return ok;
}

/**
 * 座位号 → 昵称。
 *
 * ⚠️ 这里**按数组下标取座位**，因为 `RoomPlayerView` 上没有 `seat` 字段
 * （协议层没给）。这个假设成立是有依据的：服务端 `roomSnapshot()` 直接送
 * `[...room.players.values()]`，而 `room.players` 是 `Map`、顺序就是入座顺序，
 * 座位号也正是按入座顺序分配的 —— 两者同源，所以下标就是座位号。
 *
 * 牌局期间这个假设不会破：开局之后服务端禁止任何人离房（`Players cannot leave
 * after the match starts`），所以不存在"有人退出再进来导致 Map 顺序错位"的情况。
 */
function playerName(snapshot: RoomSnapshot | null, seat: number): string {
  const player = snapshot?.players[seat];
  return player ? player.nickname : `玩家${seat}`;
}

/**
 * 房间快照的指纹：只取渲染真正会用到、又可能变的字段。
 *
 * 用来挡住「轮询拿到一份一模一样的快照也要整棵重建牌桌」的白重画。
 * 刻意**不含** `points` 之类与牌桌无关的字段，免得账号积分一变就重画一次。
 */
function snapshotSignature(snapshot: RoomSnapshot | null): string {
  if (snapshot === null) return "";
  return [
    snapshot.status,
    snapshot.roomNo,
    snapshot.ownerId,
    snapshot.players.length,
    ...snapshot.players.map((player) =>
      [player.userId, player.nickname, player.avatarUrl, player.ready ? 1 : 0, player.presence].join("~")),
  ].join("|");
}

/** 房间等待、完整牌桌操作与单局/整场结算。所有动作仍由服务端 actions 列表授权。 */
export class RoomPage {
  readonly view: Laya.Box;
  private readonly roomLabel: Laya.Label;
  private readonly statusLabel: Laya.Label;
  /** 「已复制」的就地提示，只在点复制后短暂出现。 */
  private readonly copyHint: Laya.Label;
  private readonly exitButton: Laya.Sprite;
  /** 牌桌菜单入口。只在牌局进行中出现 —— 那时候"退出房间"不是一个合法动作。 */
  private readonly menuButton: Laya.Sprite;
  /** 托管中压在牌桌正中的那一块：报「正在托管中 · 第 N/8 局」并给「重新接管」。 */
  private readonly trusteePanel: Laya.Sprite;
  private readonly trusteeRoundLabel: Laya.Label;
  private readonly noticeLabel: Laya.Label;
  private readonly playerHeading: Laya.Label;
  private readonly playerList: Laya.VBox;
  private readonly waitingControls: Laya.Box;
  private readonly waitingTable: Laya.Box;
  /**
   * 等人期间的「返回大厅」。
   *
   * 它**必须**跟着 `inProgress` 一起收掉：它挂在 `this.view` 上、位置又正好在
   * `matchArea` 底下，牌局期间虽然被 matchArea 盖住看不见，但节点仍在场景树里、
   * 命中判定也仍然可能命中它 —— 牌局中「返回大厅」的正确入口是牌桌菜单里那个
   * （语义是"暂离"，控制权不变），不是这个。
   */
  private readonly backHomeButton: Laya.Box;
  private readonly startButton: Laya.Box;
  private readonly readyButton: Laya.Box;
  private readonly matchArea: Laya.Box;
  private readonly resultOverlay: Laya.Sprite;
  private readonly resultTitle: Laya.Label;
  /** 整局结算的「开始时间 · 耗时」那行；只有整局结算才有内容，其余时候隐藏。 */
  private readonly resultTime: Laya.Label;
  private readonly resultBody: Laya.Box;
  /** 结算底部那行提示（例如「再来一局」未接通时的说明）。 */
  private readonly resultNotice: Laya.Label;
  /** 一小场结束时**弹在牌桌上**的那一小块：只报四家的本小场得失分。 */
  private readonly roundPop: Laya.Sprite;
  private readonly roundPopTitle: Laya.Label;
  private readonly roundPopBody: Laya.Label;
  private readonly roundPopFoot: Laya.Label;
  private roomId = "";
  /** 6 位房间号：给玩家看、让玩家转述的那串。快照回来之前可能还不知道。 */
  private roomNo = "";
  private snapshot: RoomSnapshot | null = null;
  private match: MatchState | null = null;
  /** 服务端下发的可用操作（原样存，不加工）。渲染时用 `liveActions` 取，见那里的说明。 */
  private actions: string[] = [];
  private lastResult: RoomResult | null = null;
  private lastMatchResult: MatchResult | null = null;
  private resultDismissed = false;
  /**
   * 一小场那屏数字要显示到什么时候（本地时刻，null = 没有时限）。
   *
   * 由服务端下发的停留时长换算而来（见 `roundPopUntil`）。打满 8 小场时**没有**下一小场，
   * 但那一屏仍要放满停留时长再交接给整局结算记录 —— 所以这个值在 `match-finished` 之后
   * 依然有效，不能顺手清掉。
   */
  private popUntil: number | null = null;
  /**
   * 这一小场已经结算、但下一小场的第一帧还没到。
   *
   * **不能用 `this.match === null` 代替**：服务端一小场结束时只发 `round-finished`、
   * 不发 `game` 帧（见 ws-server 的 broadcastState），所以 `this.match` 会停在结束
   * **之前**的状态（playing / claiming）—— 那个判据一次都不会成立，表现就是
   * 结算那屏压根不渲染，像「结算功能消失了」。新一局的 `game` 帧会把它清掉。
   */
  private roundFinished = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 一小场那屏数字到点自己收的定时器（到点重画一次，好交接给整局结算记录）。 */
  private popTimer: ReturnType<typeof setTimeout> | null = null;
  private selectedIndexes = new Set<number>();
  private handSignature = "";
  private actionLocked = false;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  /** 桌芯中心圆：倒计时的底。每帧重画，这里只留当前那个 Label 供 `updateClock` 改写。 */
  private turnClock: Laya.Label | null = null;
  /** 进度环的扇形遮罩：`updateClock` 每 100ms 改它的**角度**，不去缩放整圈。 */
  private countdownMask: Laya.Sprite | null = null;
  /** 进度环整圈：实测不到窗口长度时干脆不画，别摆一条不动的满环骗人。 */
  private countdownFill: Laya.Sprite | null = null;
  /** 遮罩所对应环的半径（`setPie` 画扇形要用）。 */
  private countdownRadius = 0;
  /**
   * 当前这一窗操作的 `actionDeadlineAt`，与**第一次看见它**的时刻。
   *
   * 协议只给截止时间、不给这一窗有多长，所以进度圈的分母只能实测：拿「首次观测」
   * 到截止时间的差当窗口长度。写死 15 秒会在换三张 / 定缺 / 认领那几窗全错。
   */
  private deadlineSeen: string | null = null;
  private deadlineWindowMs = 0;
  private prevHand: Tile[] | null = null;
  /**
   * 刚摸到的那张牌。
   *
   * 协议里**没有** `drawnTile` / draw 事件，所以只能从手牌多重集差推 ——
   * 判据收在 `addedTile()` 里：只有"恰好多一张、且没有牌消失"才认，其余一律 null。
   */
  private drawnTile: Tile | null = null;
  /** 结算浮层里那条「再来一局未接通」的说明是否已经点出来过。 */
  private rematchHintShown = false;
  /** 「已复制」自己收掉的定时器（1.2 秒）。 */
  private copyHintTimer: ReturnType<typeof setTimeout> | null = null;
  /** 复制房号那枚圆钮：按下去要自己缩一下再弹回，所以得留住建句。 */
  private readonly copyButton: Laya.Sprite;
  /** 设置面板三个开关的当前值。纯本地：音频模块未接入，这里不假装能改掉声音。 */
  private readonly settingOn: Record<SettingKey, boolean> = { music: true, sfx: true, voice: true };
  /** 规则面板 / 设置面板：从侧栏图标点开的那一块，关掉即销毁，不参与牌桌重画。 */
  private infoPanel: Laya.Sprite | null = null;
  private infoPanelKind: "rules" | "settings" | null = null;

  constructor(
    private readonly flow: ClientFlow,
    private readonly api: ApiClient,
    parent: Laya.Stage,
    private readonly getMe: () => { userId: string } | undefined,
    /**
     * 表现层事件出口（可空：单测与不接音效的构建传不到也能跑）。
     *
     * 这里**只**用于「玩家点了哪张牌 / 按了哪个认领按钮」两件事 —— 音效与动画的判定
     * 全在 director 里按帧差分，页面不直接 `playSound`，也不直接 `Tween`。
     */
    private readonly director?: PresentationDirector,
  ) {
    this.view = new Laya.Box();
    this.view.size(TABLE_WIDTH, TABLE_HEIGHT);
    parent.addChild(this.view);

    /* ---------- 顶栏牌匾：房号 + 复制 · 局数与房间状态 ---------- */
    inkPanel(this.view, SAFE, Y.topbar - 2, 336, 68);
    this.roomLabel = label(this.view, "房号读取中", 30, { bold: true, color: TABLE_THEME.cream });
    this.roomLabel.pos(SAFE + 14, Y.topbar + 2);
    this.roomLabel.height = 34;
    this.roomLabel.valign = "middle";
    this.statusLabel = label(this.view, "", 22, { color: TABLE_THEME.goldSoft });
    this.statusLabel.pos(SAFE + 14, Y.topbar + 34);
    this.statusLabel.height = 28;
    this.statusLabel.valign = "middle";
    /** 「已复制」就地提示：借牌匾第二行那几个字的位置，不弹盖住牌面的大 toast。 */
    this.copyHint = label(this.view, "已复制", 22, { color: TABLE_THEME.jadeLight });
    this.copyHint.pos(SAFE + 14, Y.topbar + 34);
    this.copyHint.height = 28;
    this.copyHint.valign = "middle";
    this.copyHint.visible = false;
    this.copyButton = new Laya.Sprite();
    this.copyButton.pos(SAFE + 272, Y.topbar + 6);
    this.copyButton.size(44, 44);
    circle(this.copyButton, 22, 22, 21, "#12282388", TABLE_THEME.goldDeep, 2);
    a2(this.copyButton, "icon_copy", 8, 10, 28, 28);
    this.copyButton.on(Laya.Event.CLICK, null, () => { void this.copyRoomNo(); });
    this.view.addChild(this.copyButton);

    /* ---------- 右侧栏：规则 / 设置 / 退出（A2 图标 + 短文字） ---------- */
    // 必须建在 matchArea **之前**：整块牌桌背景是 1920×1080 的命中区，
    // 靠 matchArea 的 zOrder = -1 才让顶栏点得动（见下面那段注释）。
    iconButton(this.view, RAIL_X[0], RAIL_Y, RAIL_SIZE, "icon_rules", "规则", () => this.toggleRulesPanel());
    iconButton(this.view, RAIL_X[1], RAIL_Y, RAIL_SIZE, "icon_settings", "设置", () => this.toggleSettingsPanel());
    // 两种退出在同一个位置上互斥出现（图标与短文字相同，差别只在点下去之后）：
    //   等人/未开局 → 直接离开房间（waiting 期合法，服务端会放行）
    //   牌局进行中 → 开牌桌菜单：继续游戏 / 返回大厅 / 退出游戏
    //                （这一阶段服务端拒绝"离开房间"，必须走托管那条路）
    this.exitButton = iconButton(this.view, RAIL_X[2], RAIL_Y, RAIL_SIZE, "icon_exit", "退出",
      () => void this.flow.leaveRoom());
    this.menuButton = iconButton(this.view, RAIL_X[2], RAIL_Y, RAIL_SIZE, "icon_exit", "退出",
      () => this.openTableMenu());
    this.menuButton.visible = false;

    this.noticeLabel = label(this.view, "", 24, { width: NOTICE_W, align: "center", color: THEME.warn, wordWrap: true });
    this.noticeLabel.pos(NOTICE_X, Y.topbar + 6);
    this.noticeLabel.visible = false;

    /* ---------- 等人期间 ---------- */
    this.playerHeading = label(this.view, "", 28, { bold: true });
    this.playerHeading.visible = false;
    this.playerList = scrollList(this.view, 0, 0, 1, 1);
    this.playerList.parent.visible = false;
    this.waitingTable = box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT);
    this.waitingControls = box(this.view, 0, 900, TABLE_WIDTH, 130);
    textButton(this.waitingControls, "分享名片", 500, 12, 260, 80, THEME.accentDark, () => shareDialog(this.view, this.flow), 24);
    this.readyButton = textButton(this.waitingControls, "准备", 830, 12, 260, 80, TABLE_THEME.jade, () => {
      const me = this.snapshot?.players.find((player) => player.userId === this.getMe()?.userId);
      if (me) void this.flow.setReady(!me.ready);
    }, 24);
    this.backHomeButton = textButton(this.view, "返回大厅", SAFE, 980, 230, 70, THEME.panelBg2, () => { void this.flow.backHome(); }, 22);
    this.startButton = textButton(this.waitingControls, "开始对局", 1160, 12, 260, 80, THEME.accentDark, () => void this.flow.startMatch(), 24);

    /* ---------- 牌桌本体 ---------- */
    this.matchArea = box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT);
    // 桌布是一整块不透明的 1920×1080，而顶栏（房号/通知/退出·菜单）和等人层都比它先建。
    // 不压 zOrder 的话它会把那些节点**画在下面**，Laya 的命中判定走同一套排序，
    // 于是「菜单」也点不动 —— 牌局中返回大厅 / 退出托管全断。
    this.matchArea.zOrder = -1;
    this.paintFelt(this.matchArea);

    /* ---------- 一小场那屏：压在桌芯上的一小块 ---------- */
    this.roundPop = roundRect(this.view, TABLE_WIDTH / 2 - 330, 330, 660, 300, 24, "#0A231AF2", THEME.accent, 1);
    this.roundPopTitle = label(this.roundPop, "", 28, { width: 660, align: "center", color: THEME.accent });
    this.roundPopTitle.pos(0, 22);
    this.roundPopTitle.height = 38;
    this.roundPopTitle.valign = "middle";
    this.roundPopBody = label(this.roundPop, "", 32, { width: 660, align: "center", wordWrap: true, bold: true, color: THEME.text });
    this.roundPopBody.pos(0, 74);
    this.roundPopFoot = label(this.roundPop, "", 25, { width: 660, align: "center", color: THEME.textDim });
    this.roundPopFoot.pos(0, 254);
    this.roundPopFoot.height = 34;
    this.roundPopFoot.valign = "middle";
    this.roundPop.visible = false;

    /* ---------- 大局结算 ---------- */
    this.resultOverlay = roundRect(this.view, TABLE_WIDTH / 2 - 540, 250, 1080, 620, 26, "#0A231A", THEME.accentDark, 1);
    this.resultTitle = label(this.resultOverlay, "", 40, { width: 1080, align: "center", bold: true, color: THEME.accent });
    this.resultTitle.pos(0, 22);
    this.resultTitle.height = 54;
    this.resultTitle.valign = "middle";
    this.resultTime = label(this.resultOverlay, "", 25, { width: 1080, align: "center", color: THEME.textDim });
    this.resultTime.pos(0, 78);
    this.resultTime.height = 34;
    this.resultTime.valign = "middle";
    this.resultTime.visible = false;
    this.resultBody = box(this.resultOverlay, 0, 122, 1080, 400);
    this.resultNotice = label(this.resultOverlay, "", 25, { width: 1080, align: "center", color: THEME.warn });
    // 说明只能放在名单与按钮行之间那一条（名单最后一行收到 478，按钮行从 528 起）。
    this.resultNotice.pos(0, 486);
    this.resultNotice.height = 34;
    this.resultNotice.valign = "middle";
    this.resultNotice.visible = false;
    textButton(this.resultOverlay, "返回大厅", 44, 528, 200, 68, THEME.panelBg2, () => { void this.flow.backHome(); }, 34);
    // 「再来一局」：视觉主按钮，但**后端没有重开能力**（见 report），所以标注未接通。
    textButton(this.resultOverlay, "再来一局", 700, 528, 200, 68, THEME.accentDark, () => this.onRematchTap(), 34);
    textButton(this.resultOverlay, "知道了", 916, 528, 120, 68, THEME.panelBg2, () => {
      this.resultDismissed = true;
      this.resultOverlay.visible = false;
    }, 34);
    this.resultOverlay.visible = false;

    /* ---------- 托管浮层：压在牌桌正中，不全屏遮挡 ---------- */
    this.trusteePanel = roundRect(this.view, TABLE_WIDTH / 2 - 300, Y.dial + 16, 600, 250, 24, "#0A231AF7", THEME.accentDark, 1);
    label(this.trusteePanel, "你的牌局正在托管中", 40, { width: 600, align: "center", bold: true, color: THEME.accent }).pos(0, 34);
    this.trusteeRoundLabel = label(this.trusteePanel, "", 25, { width: 600, align: "center", color: THEME.warn });
    this.trusteeRoundLabel.pos(0, 96);
    this.trusteeRoundLabel.height = 34;
    this.trusteeRoundLabel.valign = "middle";
    textButton(this.trusteePanel, "重新接管", 175, 152, 250, 72, THEME.accentDark, () => this.flow.requestTakeover(), 36);
    this.trusteePanel.visible = false;
  }

  /**
   * 桌布三层：湖亭背景 → 青墨压暗 → 八角翡翠石板。
   *
   * `renderMatch` 每帧清空 matchArea 后会重新调它一次；三张图都走 Laya 的纹理缓存，
   * 重复挂节点不会重复解码。压暗那层是**一笔画出来的矩形**（约 22%），
   * 不用实时模糊/滤镜 —— Android WebView 上那是要掉帧的。
   */
  private paintFelt(area: Laya.Box): void {
    const bg = new Laya.Image();
    bg.skin = SKIN.bg;
    bg.size(TABLE_WIDTH, TABLE_HEIGHT);
    area.addChild(bg);

    const veil = new Laya.Sprite();
    veil.graphics.drawRect(0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#081A1E38");
    area.addChild(veil);

    const slab = new Laya.Image();
    slab.skin = SKIN.slab;
    slab.pos(SLAB.x, SLAB.y);
    slab.size(SLAB.w, SLAB.h);
    area.addChild(slab);
  }

  show(screen: Screen): void {
    if (screen.name !== "room") return;
    if (this.roomId !== screen.roomId) {
      this.roomId = screen.roomId;
      this.snapshot = screen.snapshot;
      this.match = null;
      this.lastResult = null;
      this.lastMatchResult = null;
      this.resultDismissed = false;
      this.roundFinished = false;
      this.prevHand = null;
      this.drawnTile = null;
      this.rematchHintShown = false;
      this.resetSelection();
    }
    // 房间号进房时不一定知道（快照才带），所以每次都跟最新值走，别退回空字符串。
    this.roomNo = screen.roomNo ?? this.roomNo;
    this.mergeSnapshot(screen.snapshot);
    this.match = screen.match;
    this.actions = screen.actions;
    this.actionLocked = false;
    this.syncSelection(screen.match);
    if (screen.lastResult && screen.lastResult !== this.lastResult) this.resultDismissed = false;
    this.lastResult = screen.lastResult;
    this.lastMatchResult = screen.lastMatchResult;
    this.popUntil = screen.roundPopUntil;
    this.roundFinished = screen.roundFinished;
    this.renderAll(screen.notice);
    this.schedulePolling();
  }

  /**
   * 收下一份房间快照（判据收在 `acceptRoomSnapshot` 里，可单测）。
   *
   * `screen.snapshot` 是进房那一刻取的，牌局中 flow 不再刷新；房间页自己的 `poll()`
   * 才是拿到最新状态的那条路。所以终态一旦到手就不让更早的帧盖回去。
   */
  private mergeSnapshot(incoming: RoomSnapshot | null): void {
    if (incoming === null) return;
    if (!acceptRoomSnapshot(this.snapshot?.status ?? null, incoming.status)) return;
    this.snapshot = incoming;
  }

  hide(): void {
    this.stopPolling();
    this.stopClock();
    // 切走时把弹层一起收掉：不然下次进房会带着一块「读规则」的遮罩回来。
    this.closeInfoPanel();
  }

  /**
   * 牌桌菜单：继续游戏 / 返回大厅 / 退出游戏。
   *
   * 三个动作的语义完全不同，所以文案里把差别写清楚 ——
   * 「返回大厅」只是暂时离开牌桌（控制权还在玩家手上，回来直接接着打）；
   * 「退出游戏」是把座位交给服务器托管（要回来得点「重新接管」）。
   */
  private openTableMenu(): void {
    const overlay = box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#04100AD9");
    overlay.zOrder = 100;
    label(overlay, "牌桌菜单", 40, { width: 620, color: THEME.text, bold: true, align: "center" }).pos(650, 220);
    textButton(overlay, "继续游戏", 760, 310, 400, 80, THEME.accentDark, () => overlay.destroy(true), 40);
    textButton(overlay, "返回大厅", 760, 415, 400, 80, THEME.panelBg2, () => {
      overlay.destroy(true);
      void this.flow.backHome();
    }, 40);
    textButton(overlay, "退出游戏", 760, 520, 400, 80, THEME.panelBg2, () => {
      overlay.destroy(true);
      this.confirmQuitGame();
    }, 40);
    label(overlay, "返回大厅：暂时离开牌桌，你仍属于这一局，随时可以回来接着打。", 25, { width: 900, color: THEME.textDim, wordWrap: true }).pos(510, 650);
    label(overlay, "退出游戏：由服务器接管你的座位并自动代打，牌、座次与积分都保留。", 25, { width: 900, color: THEME.textDim, wordWrap: true }).pos(510, 716);
  }

  /**
   * 退出前的二次确认。
   *
   * 这个动作不可逆地交出了操作权（要拿回来得点「重新接管」），所以必须让人明确点一次，
   * 而不是在一次误触里就离开牌桌。
   */
  private confirmQuitGame(): void {
    const overlay = box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#04100AF2");
    overlay.zOrder = 110;
    label(overlay, "确定退出当前游戏吗？", 40, { width: 620, color: THEME.accent, bold: true, align: "center" }).pos(650, 310);
    label(overlay, "退出后系统将自动托管你的座位，\n本次大局结束前你可以回来重新接管。", 30, {
      width: 620, color: THEME.text, align: "center", wordWrap: true,
    }).pos(650, 390);
    textButton(overlay, "取消", 660, 540, 250, 80, THEME.panelBg2, () => overlay.destroy(true), 40);
    textButton(overlay, "确认退出", 1010, 540, 250, 80, THEME.accentDark, () => {
      overlay.destroy(true);
      // 服务端接管后会把控制权随下一帧下发，界面据此切成「托管中 + 重新接管」。
      this.flow.quitGame();
    }, 40);
  }

  /**
   * 复制房间号。
   *
   * 优先走剪贴板 API；Android WebView 里它常常因为不是安全上下文而直接抛错，
   * 那就退回一次性隐藏 textarea。两条路都不成也不弹错误框 —— 房号本来就写在牌匾上，
   * 念出来就行；这时「已复制」也不能骗人，所以只在真成功时才亮。
   */
  private async copyRoomNo(): Promise<void> {
    if (this.roomNo.length === 0) return;
    this.copyButton.scale(0.9, 0.9);
    setTimeout(() => this.copyButton.scale(1, 1), 110);
    if (!(await copyToClipboard(this.roomNo))) return;
    if (this.copyHintTimer !== null) clearTimeout(this.copyHintTimer);
    // 第二行让给「已复制」：局数和状态晚 1.2 秒回来，牌匾上不会同时挤两组字。
    this.statusLabel.visible = false;
    this.copyHint.visible = true;
    this.copyHintTimer = setTimeout(() => {
      this.copyHintTimer = null;
      this.copyHint.visible = false;
      this.statusLabel.visible = true;
    }, 1200);
  }

  /** 「规则」入口：再点一次收掉。 */
  private toggleRulesPanel(): void {
    if (this.infoPanelKind === "rules") this.closeInfoPanel();
    else this.openInfoPanel("rules");
  }

  /** 「设置」入口：再点一次收掉。 */
  private toggleSettingsPanel(): void {
    if (this.infoPanelKind === "settings") this.closeInfoPanel();
    else this.openInfoPanel("settings");
  }

  /** 收掉侧栏弹层。**必须 destroy 而不是只藏** —— 那块 1920×1080 的背景留着就是全屏命中区。 */
  private closeInfoPanel(): void {
    this.infoPanel?.destroy(true);
    this.infoPanel = null;
    this.infoPanelKind = null;
  }

  /**
   * 侧栏弹层（规则 / 设置）：一块居中的墨青牌匾，压在牌桌之上。
   *
   * 收法有两种 —— 点空白处、或点底部的「关闭」，跟牌桌菜单一致。
   * 弹层建在 `this.view` 上而不是 `matchArea` 里：`renderMatch` 每帧会清空 matchArea，
   * 读规则的人正盯着这一屏，不该被下一帧牌局快照抹掉。
   */
  private openInfoPanel(kind: "rules" | "settings"): void {
    this.closeInfoPanel();
    this.infoPanelKind = kind;
    const layer = new Laya.Sprite();
    layer.size(TABLE_WIDTH, TABLE_HEIGHT);
    layer.zOrder = 95;
    this.view.addChild(layer);
    this.infoPanel = layer;

    const backdrop = box(layer, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#04100AD9");
    backdrop.on(Laya.Event.CLICK, null, () => this.closeInfoPanel());

    const w = 760;
    const h = kind === "rules" ? 860 : 560;
    const x = TABLE_WIDTH / 2 - w / 2;
    const y = (TABLE_HEIGHT - h) / 2;
    inkPanel(layer, x, y, w, h);
    const head = new Laya.Sprite();
    head.pos(x, y);
    layer.addChild(head);
    a2(head, kind === "rules" ? "icon_rules" : "icon_settings", 40, 26, 52, 52);
    label(head, kind === "rules" ? "房间规则" : "设置", 34, { bold: true, color: TABLE_THEME.cream })
      .pos(108, 32);
    a2(head, "divider_gold", 40, 96, w - 80, 26);

    const body = new Laya.Sprite();
    body.pos(x + 40, y + 140);
    layer.addChild(body);
    if (kind === "rules") this.renderRulesBody(body, w - 80);
    else this.renderSettingsBody(body, w - 80);

    textButton(layer, "关闭", x + w / 2 - 130, y + h - 96, 260, 76, TABLE_THEME.jadeDeep,
      () => this.closeInfoPanel(), 38);
  }

  /**
   * 规则面板：只列**这个玩法真实现了**的条目，一条都不照着效果图编。
   *
   * 每条都对应到 `packages/rules`（108 张、不能吃、番数封顶、底分）或 `apps/server`
   * （换三张 → 定缺 → 摸打的阶段顺序、手里有缺门牌必须先打、超时的服务器托管）。
   * 具体番型与得分不写在这里：那由服务端结算下发，抄一份到面板上早晚和结算口径对不上。
   */
  private renderRulesBody(body: Laya.Sprite, width: number): void {
    const total = this.match?.totalRounds ?? TOTAL_ROUNDS_FALLBACK;
    const rows: [string, string][] = [
      ["牌局", `四人一桌 · 万 / 筒 / 条 共 108 张，不含字牌`],
      ["局数", `一整局 ${total} 小场，每一小场独立结算`],
      ["开局", "先换三张，再定缺，缺门牌必须先打"],
      ["出牌", "只能碰、杠、胡，不能吃牌"],
      ["杠", "明杠、暗杠、加杠三种都算，杠后补摸一张"],
      ["胡牌", "一家胡后牌局继续打到底，一小场可能有三家胡"],
      ["计分", "番数封顶 4 番，得分由服务端结算"],
      ["托管", "超时由服务器代打，可随时点「重新接管」"],
    ];
    let y = 0;
    for (const [tag, text] of rows) {
      a2(body, "tag_jade_base", 0, y, 104, 40, "fill");
      const tagLabel = label(body, tag, 22, { width: 104, align: "center", color: TABLE_THEME.cream });
      tagLabel.pos(0, y + 4);
      tagLabel.height = 32;
      tagLabel.valign = "middle";
      const detail = label(body, text, 25, { width: width - 128, wordWrap: true, color: TABLE_THEME.ivory });
      detail.pos(128, y + 2);
      detail.height = 36;
      y += 76;
    }
  }

  /**
   * 设置面板：音乐 / 音效 / 语音三个开关。
   *
   * ⚠️ 音频模块（AudioManager）由另一条线在做，本工作区里还没有可调的接口，
   * 所以这里**只给控制界面**，状态记在本地，不假装能改掉声音 —— 底部那行说明就是留给这个缺口的。
   */
  private renderSettingsBody(body: Laya.Sprite, width: number): void {
    const rows: [SettingKey, string, string][] = [
      ["music", "音乐", "牌桌背景乐"],
      ["sfx", "音效", "摸牌、碰杠胡的提示音"],
      ["voice", "语音", "牌局内的语音播报"],
    ];
    let y = 0;
    for (const [key, name, hint] of rows) {
      label(body, name, 30, { width: 160, color: TABLE_THEME.cream, bold: true }).pos(0, y + 6);
      label(body, hint, 22, { width: width - 220, color: TABLE_THEME.goldSoft }).pos(160, y + 14);
      this.drawSwitch(body, key, width - 110, y);
      y += 96;
    }
    label(body, "音频模块尚未接入，这里的开关暂不影响声音。", 22, {
      width, wordWrap: true, color: TABLE_THEME.goldSoft,
    }).pos(0, y + 8);
  }

  /** 一个拨动开关：画在面板上，点一下就就地变色，状态存在本地。 */
  private drawSwitch(parent: Laya.Sprite, key: SettingKey, x: number, y: number): void {
    const node = new Laya.Sprite();
    node.pos(x, y);
    node.size(88, 46);
    this.paintSwitch(node, this.settingOn[key]);
    node.on(Laya.Event.CLICK, null, () => {
      this.settingOn[key] = !this.settingOn[key];
      this.paintSwitch(node, this.settingOn[key]);
    });
    parent.addChild(node);
  }

  private paintSwitch(node: Laya.Sprite, on: boolean): void {
    node.graphics.clear();
    node.graphics.drawRoundRect(0, 0, 88, 46, 23, 23, 23, 23,
      on ? TABLE_THEME.jade : TABLE_THEME.inkSoft, TABLE_THEME.goldDeep, 2);
    node.graphics.drawCircle(on ? 65 : 23, 23, 17, on ? TABLE_THEME.cream : TABLE_THEME.scoreFlat);
  }

  /**
   * 「再来一局」。
   *
   * ⚠️ 服务端**没有**重开能力：`room.start()` 要求 `status === "waiting"`，
   * 而一大局打完 `finalize()` 会把房间置成 `finished`；也没有 rematch / 重置房间的接口。
   * 所以这里**不假装能继续**，只把缺口说清楚。
   */
  private onRematchTap(): void {
    this.rematchHintShown = true;
    this.resultNotice.text = "「再来一局」需要服务端支持（重开已结束的房间），当前未接通";
    this.resultNotice.visible = true;
  }

  private renderAll(notice?: string): void {
    this.noticeLabel.visible = notice !== undefined;
    this.noticeLabel.text = notice ?? "";
    const waiting = this.snapshot?.status === "waiting" && this.match === null;
    // 显示房间号而不是内部 roomId —— 玩家要把它念给下一桌的人听。
    // 房号单独占一行（它是要被复制、被转述的那串），局数与状态是第二行的辅助信息。
    this.roomLabel.text = this.roomNo.length > 0 ? `房号 ${this.roomNo}` : "房号读取中";
    const round = this.match ? `第 ${this.match.roundNumber}/${this.match.totalRounds ?? TOTAL_ROUNDS_FALLBACK} 局 · ` : "";
    this.statusLabel.text = `${round}${this.roomStatusText()}`;
    const inProgress = this.match !== null || this.snapshot?.status === "playing";
    this.exitButton.visible = !inProgress;
    this.menuButton.visible = inProgress;

    // 控制权由服务端下发（每帧都带），客户端只读。`trustee` = 这一座现在服务器在打。
    const trustee = this.match?.control === "trustee";
    this.trusteePanel.visible = trustee;
    if (trustee && this.match) {
      this.trusteeRoundLabel.text = `当前第 ${this.match.roundNumber} / ${this.match.totalRounds ?? 8} 局`;
    }

    this.playerHeading.visible = false;
    this.playerList.parent.visible = false;
    this.waitingTable.visible = waiting;
    this.waitingControls.visible = waiting;
    this.backHomeButton.visible = !inProgress;
    // 局间那屏数字是**压在牌桌上**的，所以它显示期间牌桌必须留着当背景；
    // 打满 8 小场时 `match` 已被清空，但最后一小场那屏还没到点 —— 这时同样不能把牌桌收掉。
    this.matchArea.visible = this.match !== null || this.popVisible();
    if (waiting) {
      this.renderPlayers();
      this.renderWaitingControls();
    }
    if (this.match) this.renderMatch(this.match);
    this.renderResult();
  }

  /**
   * 这一小场那屏数字此刻是否该显示（判据收在 `roundPopIsLive` 里，可单测）。
   *
   * 注意它**不是** `this.match === null`：服务端一小场结束时只发结算帧、不发 `game` 帧，
   * 所以 `this.match` 会停在结束**之前**的状态，那个判据一次都不会成立
   * —— 结果就是结算那屏永远不出现。
   */
  private popVisible(): boolean {
    return roundPopIsLive({
      hasResult: this.lastResult !== null,
      hasMatch: this.match !== null,
      roundFinished: this.roundFinished,
      popUntil: this.popUntil,
      matchSettled: this.lastMatchResult !== null,
    });
  }

  /** 标题栏那半句状态（判据收在 `effectiveRoomStatus` 里，可单测）。 */
  private roomStatusText(): string {
    const status = effectiveRoomStatus(this.snapshot?.status ?? null, this.match !== null);
    return status ? STATUS_NAMES[status] : "连接中";
  }

  /**
   * 渲染时要认的可用操作列表。
   *
   * 一小场结算之后、下一小场的第一帧之前，服务端手上那一份 `actions` **还是结算前那一份**
   * —— 直接用它会把「打出 X万」这类旧按钮留在结算那屏上（点了也只会被服务端拒）。
   * 所以这一小段窗口里一律认空列表，与浏览器端 `screen.roundFinished ? [] : screen.actions`
   * 同一判据。新一局的 `game` + `actions` 帧随后就到（服务端 `sendPlayerState` 两帧一起发），
   * 所以这里不需要自己重拉。
   */
  private get liveActions(): string[] {
    return this.roundFinished ? [] : this.actions;
  }

  private renderPlayers(): void {
    this.waitingTable.removeChildren();
    const backdrop = new Laya.Image("resources/bg/bg-room.png");
    backdrop.pos(0, 0); backdrop.size(TABLE_WIDTH, TABLE_HEIGHT); this.waitingTable.addChild(backdrop);
    box(this.waitingTable, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#F4EEDC22").mouseEnabled = false;
    const table = roundRect(this.waitingTable, 430, 145, 1060, 700, 80, "#1E6657DD", TABLE_THEME.goldSoft, 4);
    const players = this.snapshot?.players ?? [];
    const me = Math.max(0, players.findIndex((player) => player.userId === this.getMe()?.userId));
    const positions = [[435, 520], [835, 270], [435, 20], [35, 270]];
    for (let index = 0; index < 4; index++) {
      const player = players[(me + index) % 4];
      const [x, y] = positions[index]!;
      const seat = box(table, x!, y!, 190, 160, "#183A34CC");
      socialAvatar(seat, player?.nickname ?? "＋", player?.avatarUrl, 59, 0, 72);
      label(seat, player?.nickname ?? "等待入座", 25, { width: 190, align: "center" }).pos(0, 83);
      if (player) {
        label(seat, `ID ${player.userId}`, 20, { width: 190, align: "center", color: THEME.textDim }).pos(0, 114);
        const role = player.userId === this.snapshot?.ownerId ? "房主" : player.ready ? "已准备" : "未准备";
        label(seat, role, 20, { width: 190, align: "center", color: player.ready ? TABLE_THEME.jadeLight : THEME.accent }).pos(0, 141);
      }
    }
    label(table, `房号 ${this.roomNo}\n${players.length}/4 人`, 40, { width: 340, align: "center", wordWrap: true, color: THEME.text }).pos(360, 300);
    label(table, `规则 ${this.snapshot?.ruleVersion ?? "读取中"} · 共 8 小局`, 23, { width: 600, align: "center", color: TABLE_THEME.goldSoft }).pos(230, 410);
  }

  private renderWaitingControls(): void {
    this.startButton.visible = this.snapshot?.ownerId === this.getMe()?.userId;
    const me = this.snapshot?.players.find((player) => player.userId === this.getMe()?.userId);
    this.readyButton.visible = me !== undefined;
    setButtonText(this.readyButton, me?.ready ? "取消准备" : "准备");
    const full = this.snapshot?.players.length === 4;
    this.startButton.mouseEnabled = full;
    this.startButton.alpha = full ? 1 : 0.45;
    setButtonText(this.startButton, full ? "开始游戏" : "等待四人到齐");
  }

  /* ==================================================================
   * 牌桌本体
   * ==================================================================*/

  private renderMatch(match: MatchState): void {
    this.matchArea.removeChildren();
    this.paintFelt(this.matchArea);

    const cx = TABLE_WIDTH / 2;
    const handX = SAFE + SEAT_W + 14;

    // 左：座位信息 → 牌背 → 副露 → 弃牌；右镜像。由外到内：手牌→副露→牌河→桌芯。
    const leftBacksX = SAFE + SEAT_W + 12;
    const leftMeldX = leftBacksX + BACK_SIDE_W + 14;
    const leftRiverX = leftMeldX + MELD_MAX_W + 16;
    const rightBacksX = TABLE_WIDTH - SAFE - SEAT_W - 12 - BACK_SIDE_W;
    const rightMeldX = rightBacksX - 14 - MELD_MAX_W;
    const rightRiverX = rightMeldX - 16 - (2 * (DISCARD_W + DISCARD_GAP_X) - DISCARD_GAP_X);

    const riverW = 9 * (DISCARD_W + DISCARD_GAP_X) - DISCARD_GAP_X;
    const riverX = cx - riverW / 2;

    /* ---------- 四家：信息 / 副露 / 牌背 / 弃牌 ---------- */
    for (const player of match.players) {
      const side = tableSide(match.seat, player.seat);
      this.renderSeat(match, player.seat, side);
      if (side !== "bottom") this.renderBacks(player.handSize, side, leftBacksX, rightBacksX, cx);
      this.renderMelds(player.melds, side, leftMeldX, rightMeldX, cx, handX);
    }
    this.renderRiver(match, "top", riverX, Y.topRiver, 9, 2);
    this.renderRiver(match, "left", leftRiverX, SIDE_RIVER_Y, 2, 6);
    this.renderRiver(match, "right", rightRiverX, SIDE_RIVER_Y, 2, 6);
    this.renderRiver(match, "bottom", riverX, Y.selfRiver, 9, 2);

    /* ---------- 中央桌芯 ---------- */
    this.renderDial(match, cx);

    /* ---------- 手牌 + 操作区 ---------- */
    const hand = sortedHand(match.hand);
    this.trackDrawnTile(hand);
    this.renderHand(hand, match, handX);
    this.renderControls(match, hand);
    this.renderShout(match, handX);

    this.updateClock();
    this.startClock();
  }

  /**
   * 桌芯罗盘：玉色圆盘 + 四个方向胶囊 + 中心的倒计时环。
   *
   * 进度环是 A2 的 `ring_countdown_track`（底圈）叠 `ring_countdown_fill`（进度），
   * 进度**只能按角度裁**（扇形遮罩）—— 整圈一缩放，环的粗细就变了。
   * 一圈多长服务端没下发，所以分母按「第一次看到这个 deadline」实测；
   * 实测不到就不画进度，只留底圈和秒数。
   */
  private renderDial(match: MatchState, cx: number): void {
    const active = activeWindSlot(match.seat, match.currentPlayerSeat);
    const d = box(this.matchArea, cx - DIAL_SIZE / 2, Y.dial, DIAL_SIZE, DIAL_SIZE);
    const c = DIAL_SIZE / 2;

    // 玉盘：外圈深翡翠、内圈再暗一档，收在一道香槟金里。
    circle(d, c, c, c - 1, TABLE_THEME.jadeDeep, TABLE_THEME.gold, 2);
    circle(d, c, c, c - 13, TABLE_THEME.jadeDark);
    // 当前操作方：从圆心铺开一道很淡的金，指方向而不压牌河。
    if (active !== null) poly(d, 0, 0, windTriangleOf(active), "#E9B44C1F");

    for (const slot of WIND_SLOTS) {
      const pill = WIND_PILL[slot];
      const hot = slot === active;
      a2(d, "tag_jade_base", pill.x, pill.y, pill.w, pill.h, "fill");
      if (hot) {
        roundRect(d, pill.x - 3, pill.y - 3, pill.w + 6, pill.h + 6, 17, "#00000000", TABLE_THEME.goldSoft, 2);
      }
      const t = label(d, WIND_TEXT[slot], 26, {
        width: pill.w, align: "center", bold: hot, color: hot ? TABLE_THEME.cream : TABLE_THEME.goldSoft,
      });
      t.pos(pill.x, pill.y + (pill.h - 32) / 2);
      t.height = 32;
      t.valign = "middle";
    }

    /* ---------- 中心环：底圈常驻，进度圈按角度裁剪 ---------- */
    const ringX = c - DIAL_RING / 2;
    a2(d, "ring_countdown_track", ringX, ringX, DIAL_RING, DIAL_RING);
    const fill = new Laya.Sprite();
    fill.pos(ringX, ringX);
    fill.size(DIAL_RING, DIAL_RING);
    a2(fill, "ring_countdown_fill", 0, 0, DIAL_RING, DIAL_RING);
    this.countdownRadius = DIAL_RING / 2;
    this.countdownMask = pieMask(fill, DIAL_RING / 2, -Math.PI / 2, -Math.PI / 2);
    this.countdownFill = fill;
    d.addChild(fill);
    this.observeDeadline(match.actionDeadlineAt);
    this.paintCountdownRing();

    const seconds = deadlineSeconds(match.actionDeadlineAt);
    const font = isFinalCountdown(seconds) ? CLOCK_FONT_FINAL : CLOCK_FONT;
    this.turnClock = label(d, seconds === null ? "" : String(seconds), font, {
      width: DIAL_SIZE, align: "center", bold: true, color: clockColor(seconds),
    });
    this.turnClock.pos(0, clockTop(font));
    this.turnClock.height = clockLine(font);
    this.turnClock.valign = "middle";

    /* ---------- 桌芯两侧：阶段（左）/ 余牌 + 小局（右）。都不占中心，也不再是裸字。 ---------- */
    const total = match.totalRounds ?? TOTAL_ROUNDS_FALLBACK;
    const phaseW = 210;
    const phaseX = cx - DIAL_SIZE / 2 - 24 - phaseW;
    const phaseY = Y.dial + DIAL_SIZE / 2 - 28;
    a2(this.matchArea, "tag_jade_base", phaseX, phaseY, phaseW, 56, "fill");
    const pl = label(this.matchArea, this.phaseText(match), 28, {
      width: phaseW, align: "center", color: TABLE_THEME.cream,
    });
    pl.pos(phaseX, phaseY + 11);
    pl.height = 34;
    pl.valign = "middle";

    const leftW = 150;
    const leftX = cx + DIAL_SIZE / 2 + 34;
    const panelY = Y.dial + DIAL_SIZE / 2 - 76;
    tileWall(this.matchArea, leftX - 50, panelY + 50, 38, 54, "vertical");
    tileWall(this.matchArea, leftX + leftW + 22, panelY + 56, 54, 38, "horizontal");
    inkPanel(this.matchArea, leftX - 10, panelY, leftW + 20, 152);
    const kl = label(this.matchArea, "余牌", 22, {
      width: leftW, align: "center", color: TABLE_THEME.goldSoft,
    });
    kl.pos(leftX, panelY + 8);
    kl.height = 28;
    kl.valign = "middle";
    const vl = label(this.matchArea, String(match.tilesLeft), 40, {
      width: leftW, align: "center", bold: true, color: TABLE_THEME.cream,
    });
    vl.pos(leftX, panelY + 36);
    vl.height = 52;
    vl.valign = "middle";
    a2(this.matchArea, "divider_gold", leftX + 12, panelY + 92, leftW - 24, 12, "fill");
    const rl = label(this.matchArea, `第 ${match.roundNumber}/${total} 局`, 21, {
      width: leftW, align: "center", color: TABLE_THEME.goldSoft,
    });
    rl.pos(leftX, panelY + 108);
    rl.height = 30;
    rl.valign = "middle";
  }

  /**
   * 记下这一窗操作的实测长度。
   *
   * `actionDeadlineAt` 一变就是一窗新操作：以「第一次看见它的时刻」为起点。
   * 客户端轮询/推送的延迟会算进窗口里，所以这里只取一个合理区间内的值，
   * 越界就当没测到（宁可不画进度，也不画一条乱跳的环）。
   */
  private observeDeadline(deadlineAt: number | undefined): void {
    const key = deadlineAt === undefined ? null : String(deadlineAt);
    if (key === this.deadlineSeen) return;
    this.deadlineSeen = key;
    const span = deadlineAt === undefined ? 0 : deadlineAt - Date.now();
    this.deadlineWindowMs = span > 900 && span < 60_000 ? span : 0;
  }

  /** 按剩余时间改写进度环的扇形角度。没实测到窗口长度就整圈不画。 */
  private paintCountdownRing(): void {
    const mask = this.countdownMask;
    if (mask === null) return;
    const deadlineAt = this.match?.actionDeadlineAt;
    const fraction = deadlineAt === undefined || this.deadlineWindowMs <= 0
      ? 0
      : Math.max(0, Math.min(1, (deadlineAt - Date.now()) / this.deadlineWindowMs));
    const from = -Math.PI / 2;
    setPie(mask, this.countdownRadius, from, from + fraction * Math.PI * 2);
    if (this.countdownFill !== null) this.countdownFill.visible = fraction > 0.005;
  }

  private phaseText(match: MatchState): string {
    if (match.phase === "claiming") return PHASE_NAMES.claiming;
    return PHASE_NAMES[match.phase];
  }

  /**
   * 一家座位：墨青牌匾 + 圆头像 + 庄家 / 定缺角标 + 大局累计分 + 状态。
   *
   * 落点仍由 `SEAT_POS` 决定（四家座位是硬保留项），改的只是这一块长什么样 ——
   * 原来三行字直接悬在背景上，现在收进牌匾里。
   * 分数取**整局累计** `matchDelta`（换一小场不清零），配色只分暖金 / 冷灰蓝 / 象牙灰，
   * 不借股市那套红绿。网络状态要真实延迟才画，协议里没有，所以这里不摆。
   */
  private renderSeat(match: MatchState, seat: number, side: TableSide): void {
    const player = match.players.find((entry) => entry.seat === seat);
    if (!player) return;
    const pos = SEAT_POS[side];
    const acting = match.currentPlayerSeat === seat;
    const snap = this.snapshot?.players[seat];
    const row = box(this.matchArea, pos.x, pos.y, SEAT_W, 100);
    inkPanel(row, -10, -12, SEAT_W + 20, 104);

    const name = playerName(this.snapshot, seat);
    const avatarY = 14;
    avatarDisc(row, 0, avatarY, SEAT_AVATAR, snap?.avatarUrl ?? player.avatarUrl, name);
    if (acting) {
      a2(row, "ring_active_player", -8, avatarY - 8, SEAT_AVATAR + 16, SEAT_AVATAR + 16);
    }
    // 庄家：A2 那枚圆章压在头像左上角，和光环错开。
    if (match.dealerSeat === seat) a2(row, "badge_dealer", -14, avatarY - 20, 34, 34);

    const colX = SEAT_AVATAR + 12;
    const nameLabel = label(row, name, 30, { width: SEAT_COL_W - 76, color: TABLE_THEME.cream });
    nameLabel.pos(colX, 0);
    nameLabel.height = 39;
    nameLabel.valign = "middle";
    const score = player.matchDelta ?? 0;
    const scoreLabel = label(row, fmtDelta(score), 30, {
      width: 68, align: "right", bold: true,
      color: score > 0 ? TABLE_THEME.scoreUp : score < 0 ? TABLE_THEME.scoreDown : TABLE_THEME.scoreFlat,
    });
    scoreLabel.pos(colX + SEAT_COL_W - 76, 0);
    scoreLabel.height = 39;
    scoreLabel.valign = "middle";

    // 状态行：定缺胶囊在最左，后面才是在场 / 托管 / 已胡那些文字。
    let statusX = colX;
    const badge = missingBadgeKey(player.missingSuit);
    if (badge !== null) {
      a2(row, badge, colX, 44, 56, 30);
      statusX = colX + 64;
    }
    const status = this.seatStatusText(match, player.seat, player.presence, player.won);
    const st = label(row, status, 25, { width: SEAT_W + 20 - statusX, color: TABLE_THEME.goldSoft });
    st.pos(statusX, 42);
    st.height = 33;
    st.valign = "middle";
  }

  /** 托管中 / 暂离 / 掉线 / 已胡，用 · 连接，超长由 Label 的宽度兜住。定缺不写在这里 —— 它归胶囊。 */
  private seatStatusText(match: MatchState, seat: number, presence: string | undefined, won: boolean): string {
    const bits: string[] = [];
    const trustee = seat === match.seat ? match.control === "trustee" : presence === "trustee";
    if (trustee) bits.push("托管中");
    else if (seat === match.seat ? match.away === true : presence === "away") bits.push("暂离");
    else if (presence === "disconnected") bits.push("掉线");
    if (won) bits.push("已胡");
    return bits.join(" · ");
  }

  /** 对手牌背：**只由 handSize 生成**，不含任何牌值。 */
  private renderBacks(handSize: number, side: TableSide, leftBacksX: number, rightBacksX: number, cx: number): void {
    const count = Math.max(0, handSize);
    if (side === "top") {
      const total = count * (BACK_TOP_W + BACK_TOP_GAP) - BACK_TOP_GAP;
      const startX = cx - total / 2;
      for (let i = 0; i < count; i++) {
        tileBack(this.matchArea, startX + i * (BACK_TOP_W + BACK_TOP_GAP), Y.topBacks, BACK_TOP_W, BACK_TOP_H, "top");
      }
      return;
    }
    const x = side === "left" ? leftBacksX : rightBacksX;
    for (let i = 0; i < count; i++) {
      tileBack(this.matchArea, x, SIDE_RIVER_Y + i * (BACK_SIDE_H + BACK_SIDE_GAP), BACK_SIDE_W, BACK_SIDE_H,
        side === "left" ? "left" : "right");
    }
  }

  /** 副露：放在各自手牌**朝中心的一侧**，与牌河留出间距。 */
  private renderMelds(
    melds: ReadonlyArray<{ kind: "pong" | "kong"; tile: Tile | null; concealed?: boolean }>,
    side: TableSide, leftMeldX: number, rightMeldX: number, cx: number, handX: number,
  ): void {
    if (melds.length === 0) return;
    const anchor = side === "top" ? { x: cx - MELD_MAX_W / 2, y: Y.topMelds }
      : side === "left" ? { x: leftMeldX, y: 432 }
      : side === "right" ? { x: rightMeldX, y: 432 }
      : { x: handX, y: Y.selfMelds };
    let x = anchor.x;
    for (const meld of melds) {
      const count = meld.kind === "kong" ? 4 : 3;
      const w = count * (MELD_W + 2) + 6;
      const cell = box(this.matchArea, x, anchor.y, w, MELD_H + 6);
      inkPanel(cell, 0, 0, w, MELD_H + 6);
      for (let i = 0; i < count; i++) {
        // 暗杠：牌值不可见时画扣着的背，不泄露牌面。
        if (meld.tile === null || (meld.kind === "kong" && meld.concealed && i > 0)) {
          tileBack(cell, 3 + i * (MELD_W + 2), 3, MELD_W, MELD_H);
        } else {
          faceTile(cell, 3 + i * (MELD_W + 2), 3, MELD_W, MELD_H, tileAsset(meld.tile));
        }
      }
      x += w + 8;
    }
  }

  /** 一家弃牌。最近打出的一张用金框**原位**高亮，不另画一张盖上去。 */
  private renderRiver(match: MatchState, side: TableSide, x: number, y: number, cols: number, rows: number): void {
    const player = match.players.find((entry) => tableSide(match.seat, entry.seat) === side);
    if (!player) return;
    const tiles = player.discards.slice(0, cols * rows);
    const isSelf = side === "bottom";
    const lastIndex = match.phase === "claiming" && isSelf ? tiles.length - 1 : -1;
    tiles.forEach((tile, index) => {
      const col = index % cols, row = Math.floor(index / cols);
      const cell = faceTile(this.matchArea,
        x + col * (DISCARD_W + DISCARD_GAP_X),
        y + row * (DISCARD_H + DISCARD_GAP_Y),
        DISCARD_W, DISCARD_H, tileAsset(tile));
      if (index === lastIndex) {
        // 象牙白牌面上金边几乎看不见，最近一张用朱红框定位。
        roundRect(cell, -2, -2, DISCARD_W + 4, DISCARD_H + 4, 7, "#00000000", TABLE_THEME.vermilion, 3);
      }
    });
  }

  /**
   * 记录"刚摸到的那张"。
   *
   * 判据在 `addedTile()`：只有手牌恰好多一张、且没有牌消失才认。其余情况（碰杠换牌、
   * 一帧里发生两件事）一律置空 —— 宁可不提示，也不误报。
   */
  private trackDrawnTile(hand: readonly Tile[]): void {
    this.drawnTile = addedTile(this.prevHand, hand) as Tile | null;
    this.prevHand = [...hand];
  }

  /**
   * 手牌：整副牌里最醒目的主体。
   *
   * 刚摸到的那张**不排进顺子**，单独放在最右、和其余牌留 28px 间距并上浮
   * —— 这是麻将桌的惯例，一眼就能看出"这是刚摸的"。
   */
  private renderHand(hand: Tile[], match: MatchState, handX: number): void {
    const canDiscard = actionAvailable(this.liveActions, "discard") && match.phase === "playing";
    // 定缺之后手里还有缺门牌时，服务端只收缺门牌（`Missing suit tiles must be discarded first`），
    // 所以这里也把能点的牌收窄到缺门 —— 与浏览器端的 `DiscardSelection.canSelect` 同一判据。
    const discardable = canDiscard ? discardableIndexes(hand, match.missingSuit) : null;
    const canSwap = match.phase === "swapping" && actionAvailable(this.liveActions, "swap");
    // 托管中：牌照常显示（看得见牌局），但一张都不能点 —— 这一座现在由服务器操作。
    const trustee = match.control === "trustee";
    const myTurn = match.currentPlayerSeat === match.seat;

    const rest = [...hand];
    const drawnIndex = this.drawnTile === null ? -1 : rest.lastIndexOf(this.drawnTile);
    const drawn = drawnIndex >= 0 ? rest.splice(drawnIndex, 1)[0]! : null;

    const draw = (tile: Tile, index: number, isDrawn: boolean, offsetX: number): void => {
      const selected = this.selectedIndexes.has(index);
      const enabled = !trustee && (canSwap || (discardable?.has(index) ?? false));
      // 三种弱化分开：缺门限制最重、不是自己操作只轻微、托管与缺门同级。
      const dim = enabled ? 1 : (myTurn ? 0.74 : 0.88);
      const lift = (selected ? 24 : 0) + (isDrawn ? 10 : 0);
      // 描边与放大都落在牌**底下**那张垫板上 —— 直接套在牌面上会把万/筒/条的花色盖掉。
      const card = handTile(this.matchArea, offsetX, Y.hand - lift, HAND_TILE_W, HAND_TILE_H,
        tileAsset(tile), selected ? 1.03 : 1);
      if (dim < 1) card.alpha = dim;
      if (selected) {
        roundRect(card, -3, -3, HAND_TILE_W + 6, HAND_TILE_H + 6, 9, "#00000000", TABLE_THEME.goldSoft, 3);
      }
      // 刚摸的牌：香槟金描边 + 上浮，动画结束后提示仍然保留。
      if (isDrawn) roundRect(card, -3, -3, HAND_TILE_W + 6, HAND_TILE_H + 6, 9, "#00000000", TABLE_THEME.gold, 3);
      if (enabled) card.on(Laya.Event.CLICK, null, () => this.toggleTile(index, hand, match, tile));
    };

    let x = handX;
    rest.forEach((tile, index) => { draw(tile, index, false, x); x += HAND_TILE_W + HAND_TILE_GAP; });
    if (drawn !== null) draw(drawn, drawnIndex, true, x + 24);
  }

  /**
   * 操作区：**严格按服务端 actions 渲染**。
   *
   * `actions` 里没有的种类根本不出现（而不是画出来再置灰）。
   * 数量变化时整体右对齐重排，不留空洞。
   */
  private renderControls(match: MatchState, hand: Tile[]): void {
    const actY = Y.hand - 20 - 100;

    if (match.control === "trustee") {
      const t = label(this.matchArea, "托管中 · 由服务器代打", 30, { width: 400, align: "right", color: THEME.accent });
      t.pos(TABLE_WIDTH - SAFE - 400, actY + 30);
      return;
    }

    if (match.phase === "swapping" && actionAvailable(this.liveActions, "swap")) {
      const valid = swapSelectionIsValid(hand, this.selectedIndexes);
      const hint = label(this.matchArea, `请选择 3 张牌 · 已选 ${this.selectedIndexes.size}/3`, 30, {
        width: 560, align: "right", color: valid ? THEME.good : THEME.text,
      });
      hint.pos(TABLE_WIDTH - SAFE - 560, actY - 8);
      textButton(this.matchArea, "确认换牌", TABLE_WIDTH - SAFE - 290, actY + 42, 290, 80,
        valid ? THEME.accentDark : "#2B3831", () => {
          if (!valid || this.actionLocked) return;
          this.actionLocked = true;
          this.flow.swap(selectedTiles(hand, this.selectedIndexes));
          this.resetSelection();
        }, 40);
      return;
    }

    if (match.phase === "missing" && actionAvailable(this.liveActions, "choose-missing")) {
      const cx = TABLE_WIDTH / 2;
      const hint = label(this.matchArea, "请选择定缺花色", 30, { width: 680, align: "center", color: THEME.text });
      hint.pos(cx - 340, Y.dial - 4);
      (["wan", "tong", "tiao"] as const).forEach((suit, index) => {
        const colors = { wan: "#A62B1F", tong: "#1F5FA8", tiao: "#1B6E41" } as const;
        textButton(this.matchArea, `缺${SUIT_NAMES[suit]}`, cx - 270 + index * 180, Y.dial + 46, 164, 120, colors[suit],
          () => this.send(() => this.flow.chooseMissing(suit)), 24);
      });
      return;
    }

    // 认领：严格按 actions 决定出现哪些（顺序 胡>杠>碰>过）
    if (match.phase === "claiming") {
      const kinds = actionButtons(this.liveActions);
      if (kinds.length === 0) {
        const t = label(this.matchArea, "等待其他玩家操作…", 30, { width: 400, align: "right", color: THEME.textDim });
        t.pos(TABLE_WIDTH - SAFE - 400, actY + 30);
        return;
      }
      this.drawActionRow(kinds, TABLE_WIDTH - SAFE, actY, (kind) => this.send(() => {
        // 放在 send 里面：锁挡下重复点击时不该再闪一下反馈。
        this.director?.notifyAction(kind as "hu" | "peng" | "kong" | "pass");
        this.flow.claim(kind as "hu" | "peng" | "kong" | "pass");
      }));
      return;
    }

    // 行牌阶段：打出 / 自摸 / 暗杠 / 补杠
    const kinds: string[] = [];
    const selected = [...this.selectedIndexes][0];
    if (actionAvailable(this.liveActions, "discard")) kinds.push("discard");
    if (actionAvailable(this.liveActions, "hu")) kinds.push("hu");
    if (actionAvailable(this.liveActions, "kong-concealed")) kinds.push("kong");
    if (actionAvailable(this.liveActions, "kong-added")) kinds.push("kong");
    if (kinds.length === 0) {
      const t = label(this.matchArea, match.won ? "本局已胡，等待其他玩家" : "等待其他玩家操作…", 30,
        { width: 420, align: "right", color: THEME.textDim });
      t.pos(TABLE_WIDTH - SAFE - 420, actY + 30);
      return;
    }
    let x = TABLE_WIDTH - SAFE - actionsWidth(kinds.map((k) => (k === "discard" ? "discard" : "kong")));
    for (const kind of kinds) {
      const label0 = kind === "discard"
        ? (selected === undefined ? "请先选牌" : `打出 ${tileName(hand[selected]!)}`)
        : kind === "hu" ? "自摸" : selected === undefined ? "暗杠" : "杠";
      const action = kind === "discard"
        ? () => { if (selected === undefined) return; this.flow.discard(hand[selected]!); this.resetSelection(); }
        : kind === "hu" ? () => this.flow.selfDraw()
        : actionAvailable(this.liveActions, "kong-concealed") ? () => this.flow.concealedKong()
        : () => this.flow.addedKong();
      const w = ACTION_WIDTH[kind] ?? 148;
      const bg = kind === "discard" ? (selected === undefined ? "#2B3831" : THEME.accentDark) : THEME.accentDark;
      textButton(this.matchArea, label0, x, actY, w, 100, bg, () => this.send(action), 26);
      x += w + ACTION_GAP;
    }
  }

  /** 一排操作按钮：按优先级颜色分级，整体右对齐。 */
  private drawActionRow(kinds: string[], rightX: number, y: number, onTap: (kind: string) => void): void {
    const colors: Record<string, string> = {
      hu: "#A3231A", kong: "#A05213", peng: "#16553C", pass: "#33443C",
    };
    let x = rightX - actionsWidth(kinds);
    for (const kind of kinds) {
      const w = ACTION_WIDTH[kind] ?? 148;
      textButton(this.matchArea, ACTION_LABEL[kind] ?? kind, x, y, w, 100, colors[kind] ?? "#33443C", () => onTap(kind), 26);
      x += w + ACTION_GAP;
    }
  }

  /**
   * 碰 / 杠 / 胡：贴**动作发起方**的手牌一侧显示，0.8 秒后自己收。
   *
   * 不再从中央桌芯弹出 —— 桌芯只负责方向与倒计时。
   */
  private renderShout(match: MatchState, handX: number): void {
    // 谁能"碰/杠/胡"？就是当前帧里被服务端允许 claim 的那一家；没有就退回当前操作方。
    const claimant = match.currentPlayerSeat;
    if (claimant === null) return;
    const side = tableSide(match.seat, claimant);
    const kinds = actionButtons(this.liveActions);
    const shout = kinds.indexOf("hu") >= 0 ? "胡！" : kinds.indexOf("kong") >= 0 ? "杠！" : kinds.indexOf("peng") >= 0 ? "碰！" : null;
    if (shout === null) return;
    const anchor = SHOUT_ANCHOR[side];
    const x = side === "bottom" ? Math.min(anchor.x, handX + 380) : anchor.x;
    const t = label(this.matchArea, shout, 56, { width: 200, align: "center", bold: true, color: shout === "胡！" ? THEME.bad : THEME.accent });
    t.pos(x, anchor.y);
    t.height = 74;
    t.valign = "middle";
  }

  private renderResult(): void {
    const result = this.lastResult;

    // ---- 一小场那一屏：**弹在牌桌上**，只报四家的得失分 ----
    // 牌型、四家牌面、胡牌明细都不在这屏出现（按玩法），也不用玩家按任何东西：
    // 到点（服务端给的停留时长）自己收，随后开下一小场。
    //
    // 判据是 `roundPopIsLive()` 而**不是** `this.match === null`：服务端一小场结束时只发
    // 结算帧、不发 `game` 帧，`this.match` 停在结束之前的状态，那个判据一次都不会成立
    // —— 结果就是这一屏永远不出现。
    if (result !== null && this.popVisible()) {
      const left = this.popUntil === null ? null : this.popUntil - Date.now();
      this.roundPopTitle.text = roundLabel(result.roundNumber ?? 1, result.totalRounds);
      const rows: NonNullable<RoomResult["players"]> = result.players
        ?? result.deltas.map<NonNullable<RoomResult["players"]>[number]>((entry, seat) => ({ playerId: entry.playerId, seat, won: false, hand: [], melds: [] }));
      const lines: string[] = [];
      for (const win of result.wins ?? []) {
        const summary = huSummary(win, tileName);
        const name = this.nicknameOfSeat(summary.seat);
        lines.push(`${name}  ${summary.way}${summary.fans ? ` · ${summary.fans}` : ""}  ${fmtDelta(summary.points)}`);
      }
      for (const player of [...rows].sort((a, b) => a.seat - b.seat)) {
        if ((result.wins ?? []).some((win) => win.seat === player.seat)) continue;
        const delta = result.deltas.find((entry) => entry.playerId === player.playerId)?.delta ?? 0;
        lines.push(`${this.nicknameOfSeat(player.seat)}  ${fmtDelta(delta)}`);
      }
      this.roundPopBody.text = lines.join("\n");
      this.roundPopFoot.text = left === null ? "" : `${Math.ceil(left / 1000)} 秒后进入下一局`;
      this.roundPop.visible = true;
      this.resultOverlay.visible = false;
      // 到点重画一次：打满 8 小场时那一刻要接着显示整局结算记录，
      // 而服务端在那之后**已经不再发任何帧**（这里不像两个浏览器客户端那样
      // 能等到新一局的 `game` 帧把手，所以必须自己定个闹钟）。
      if (left !== null) {
        if (this.popTimer !== null) clearTimeout(this.popTimer);
        this.popTimer = setTimeout(() => {
          this.popTimer = null;
          this.renderResult();
        }, left + 40);
      }
      return;
    }
    if (this.popTimer !== null) {
      clearTimeout(this.popTimer);
      this.popTimer = null;
    }
    this.roundPop.visible = false;

    // ---- 整局结算记录（打满 8 小场 / 中途解散）----
    const settled = this.lastMatchResult;
    if (settled === null || this.resultDismissed) {
      this.resultOverlay.visible = false;
      return;
    }

    const dissolved = settled.reason === "dissolved";
    this.resultTitle.text = dissolved ? "本场提前结束" : "本场结束";
    const time = matchTimeText(settled.startedAt, settled.finishedAt);
    this.resultTime.text = dissolved
      ? `已完成 ${settled.completedRounds}/${this.lastResult?.totalRounds ?? TOTAL_ROUNDS_FALLBACK} 局 · 当前未完成小局已作废`
      : `打满 ${settled.completedRounds} 小场${time === null ? "" : ` · ${time}`}`;
    this.resultTime.visible = true;
    this.resultBody.removeChildren();

    // 列头：玩家 | 本场 | 入账 | 余额（数字列固定宽、右对齐）
    const COL = { player: 0, x1: 560, x2: 700, x3: 840, numW: 130 };
    const head = box(this.resultBody, 44, 0, 992, 40);
    label(head, "玩家", 25, { width: 300, color: THEME.textDim }).pos(COL.player, 0);
    for (const [text, x] of [["本场", COL.x1], ["入账", COL.x2], ["余额", COL.x3]] as const) {
      const l = label(head, text, 25, { width: COL.numW, align: "right", color: THEME.textDim });
      l.pos(x, 0);
    }
    line(this.resultBody, 44, 40, 1036, 40, "#FFFFFF1A");

    const settledPlayers = settled.players ?? [];
    settledPlayers.forEach((player, index) => {
      const y = 52 + index * 78;
      const row = box(this.resultBody, 44, y, 992, 70);
      const avatar = box(row, 0, 12, 42, 42);
      socialAvatar(avatar, player.nickname, player.avatarUrl, 0, 0, 42);
      const name = label(row, player.nickname, 30, { width: 300, color: THEME.text });
      name.pos(56, 0);
      name.height = 36;
      name.valign = "middle";
      const id = label(row, `ID ${player.playerId}`, 25, { width: 300, color: THEME.textDim });
      id.pos(56, 36);
      id.height = 33;
      id.valign = "middle";
      // 三个数字列：固定宽 + tabular 对齐，纵向成列
      const nums: Array<[number, string, string]> = [
        [COL.x1, fmtDelta(player.delta), player.delta > 0 ? THEME.good : player.delta < 0 ? THEME.bad : THEME.textDim],
        [COL.x2, fmtDelta(player.accountDelta), player.accountDelta > 0 ? THEME.good : player.accountDelta < 0 ? THEME.bad : THEME.textDim],
        [COL.x3, String(player.balance), THEME.text],
      ];
      for (const [x, text, color] of nums) {
        const l = label(row, text, 30, { width: COL.numW, align: "right", bold: true, color });
        l.pos(x, 18);
        l.height = 39;
        l.valign = "middle";
      }
      if (index < settledPlayers.length - 1) line(this.resultBody, 44, y + 74, 1036, y + 74, "#FFFFFF0F");
    });

    const done = `${settled.completedRounds}/${this.lastResult?.totalRounds ?? TOTAL_ROUNDS_FALLBACK}`;
    // 局数放在按钮行中间那段空白里（「返回大厅」收到 244，「再来一局」从 700 起）：
    // 面板只有 620 高，按钮行以下没有第四条可站。
    const foot = label(this.resultOverlay, `已完成 ${done} 局`, 25, { width: 424, align: "center", color: THEME.textDim });
    foot.pos(260, 546);
    foot.height = 34;
    foot.valign = "middle";
    this.resultOverlay.visible = true;
  }

  private nicknameOfSeat(seat: number): string {
    return this.snapshot?.players[seat]?.nickname ?? `${seat} 号位`;
  }

  private toggleTile(index: number, hand: Tile[], match: MatchState, tile: Tile): void {
    // 这一小场已经结算：牌桌上压着结算那屏，旧手牌不该再有任何反应。
    if (this.roundFinished) return;
    if (match.phase === "swapping") {
      if (this.selectedIndexes.has(index)) this.selectedIndexes.delete(index);
      else if (this.selectedIndexes.size < 3) this.selectedIndexes.add(index);
    } else {
      this.selectedIndexes = this.selectedIndexes.has(index) ? new Set() : new Set([index]);
    }
    this.renderMatch(match);
    // 只在「选中」时给反馈：取消选中再抬一次动画读起来像是又选了一遍。
    if (this.selectedIndexes.has(index)) this.director?.notifyTileSelect(tile);
  }

  private send(action: () => void): void {
    if (this.actionLocked) return;
    this.actionLocked = true;
    action();
  }

  private syncSelection(match: MatchState | null): void {
    const signature = match ? `${match.phase}:${sortedHand(match.hand).join(",")}` : "";
    if (signature !== this.handSignature) {
      this.handSignature = signature;
      this.selectedIndexes.clear();
    }
  }

  private resetSelection(): void {
    this.selectedIndexes.clear();
    this.handSignature = "";
  }

  private schedulePolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => { void this.poll(); }, 2500);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startClock(): void {
    if (this.clockTimer !== null) return;
    // 100ms 一跳：最后三秒的呼吸缩放要够顺，而它只改一个 Label，代价可以忽略。
    this.clockTimer = setInterval(() => this.updateClock(), 100);
  }

  private stopClock(): void {
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.turnClock = null;
    this.countdownMask = null;
    this.countdownFill = null;
  }

  /**
   * 倒计时只显示服务端 `actionDeadlineAt` 的剩余秒数，**不触发任何业务动作**。
   *
   * 颜色按剩余时间分三档（象牙 → 金 → 朱红），最后三秒再加大字号 + 轻微呼吸缩放
   * （1.0→1.08→1.0）。进度环的角度也在这一跳里改写：它只改扇形遮罩的角度，不碰整圈。
   */
  private updateClock(): void {
    const clock = this.turnClock;
    if (clock === null || this.match === null) return;
    const seconds = deadlineSeconds(this.match.actionDeadlineAt);
    const final = isFinalCountdown(seconds);
    clock.text = seconds === null ? "" : String(seconds);
    clock.fontSize = final ? CLOCK_FONT_FINAL : CLOCK_FONT;
    clock.color = clockColor(seconds);
    clock.height = clockLine(clock.fontSize);
    clock.y = clockTop(clock.fontSize);
    this.paintCountdownRing();
    if (final) {
      const scale = 1 + 0.08 * (0.5 + 0.5 * Math.sin(Date.now() / 260));
      clock.scaleX = scale;
      clock.scaleY = scale;
    } else if (clock.scaleX !== 1) {
      clock.scaleX = 1;
      clock.scaleY = 1;
    }
  }

  private async poll(): Promise<void> {
    const fetched = await this.api.room(this.roomId);
    if (!fetched.ok) return;
    const changed = snapshotSignature(this.snapshot) !== snapshotSignature(fetched.value);
    this.snapshot = fetched.value;
    /**
     * **只有快照真的变了才重画。**
     *
     * 牌局中也要继续轮询：实时通道**不推**房间状态的变化 —— 中途解散就是一条
     * 一个字节都不发的路径（见 `app.ts` 的 `/dissolve` 与 `voteDissolve`，服务端
     * 直接改房间状态，不经过 `broadcastState`）。不轮询的话四家会一直停在冻结的牌桌上，
     * 既不知道房间已经结束，昵称也会退化成「玩家N」。
     *
     * 但 `renderAll()` 会把牌桌整棵 `removeChildren` 重建，每 2.5 秒白重建一次会闪、
     * 也白白打断玩家正在做的选牌，所以用快照指纹挡一道。
     */
    if (changed) this.renderAll();
  }
}

/**
 * 当前操作方那道很淡的金扇形。
 *
 * 不能沿用 `table-layout.windTriangle` 的方形角点 —— 那三个顶点离圆心 148，
 * 而玉盘只有 104 半径，扇形会从盘子里戳到桌布上。这里收在盘内。
 */
function windTriangleOf(slot: WindSlot): number[] {
  const c = DIAL_SIZE / 2, r = c - 8, spread = (26 * Math.PI) / 180;
  const dir = { N: -Math.PI / 2, E: 0, S: Math.PI / 2, W: Math.PI }[slot];
  return [
    c, c,
    c + r * Math.cos(dir - spread), c + r * Math.sin(dir - spread),
    c + r * Math.cos(dir + spread), c + r * Math.sin(dir + spread),
  ];
}

/** 四家座位信息的左上角。上家/下家贴在牌背外侧，对家在上方居中，自己在左下。 */
const SEAT_POS: Record<TableSide, { x: number; y: number }> = {
  top: { x: TABLE_WIDTH / 2 - SEAT_W / 2, y: Y.topInfo },
  left: { x: SAFE, y: 432 },
  right: { x: TABLE_WIDTH - SAFE - SEAT_W, y: 432 },
  bottom: { x: SAFE, y: Y.selfInfo },
};
