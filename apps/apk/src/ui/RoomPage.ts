import { shareDialog, socialAvatar } from "./SocialDialogs.js";
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
import { acceptRoomSnapshot, deadlineSeconds, effectiveRoomStatus, opponentBacks, roundPopIsLive, tableSide, type TableSide } from "./landscape-table.js";
import { TABLE_HEIGHT, TABLE_WIDTH, THEME, box, fmtDelta, label, refill, scrollList, setButtonText, textButton, tileName, tileRun } from "./widgets.js";

const PHASE_NAMES: Record<MatchState["phase"], string> = {
  swapping: "换三张",
  missing: "定缺",
  playing: "行牌中",
  claiming: "等待响应",
  finished: "已结束",
};

const SUIT_NAMES: Record<Suit, string> = { wan: "万", tong: "筒", tiao: "条" };

const STATUS_NAMES: Record<RoomSnapshot["status"], string> = {
  waiting: "等待中",
  playing: "对局中",
  finished: "已结束",
  dissolved: "已解散",
};

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
  if (!snapshot) return "";
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
  private readonly statusLabel: Laya.Label;
  private readonly exitButton: Laya.Box;
  /** 牌桌菜单入口。只在牌局进行中出现 —— 那时候"退出房间"不是一个合法动作。 */
  private readonly menuButton: Laya.Box;
  /** 托管中压在牌桌正中的那一块：报「正在托管中 · 第 N/8 局」并给「重新接管」。 */
  private readonly trusteePanel: Laya.Box;
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
  private readonly matchArea: Laya.Box;
  private readonly resultOverlay: Laya.Box;
  private readonly resultTitle: Laya.Label;
  /** 整局结算的「开始时间 · 耗时」那行；只有整局结算才有内容，其余时候隐藏。 */
  private readonly resultTime: Laya.Label;
  private readonly resultBody: Laya.Box;
  /** 一小场结束时**弹在牌桌上**的那一小块：只报四家的本小场得失分。 */
  private readonly roundPop: Laya.Box;
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
  private turnClock: Laya.Label | null = null;

  constructor(
    private readonly flow: ClientFlow,
    private readonly api: ApiClient,
    parent: Laya.Stage,
    private readonly getMe: () => { userId: string } | undefined,
  ) {
    this.view = new Laya.Box();
    this.view.size(TABLE_WIDTH, TABLE_HEIGHT);
    parent.addChild(this.view);

    const header = box(this.view, 0, 0, TABLE_WIDTH, 72, THEME.panelBg);
    this.statusLabel = label(header, "", 30, { bold: true });
    this.statusLabel.pos(30, 20);
    // 两种退出在同一个位置上互斥出现：
    //   等人/未开局 → 「退出」= 真的离开房间（waiting 期合法，服务端会放行）
    //   牌局进行中  → 「菜单」= 继续游戏 / 返回大厅 / 退出游戏
    //                  （这一阶段服务端拒绝"离开房间"，必须走托管那条路）
    this.exitButton = textButton(header, "退出", 1760, 8, 130, 56, THEME.panelBg2, () => void this.flow.leaveRoom());
    this.menuButton = textButton(header, "菜单", 1760, 8, 130, 56, THEME.panelBg2, () => this.openTableMenu());
    this.menuButton.visible = false;

    this.noticeLabel = label(this.view, "", 24, { width: 1500, align: "center", color: THEME.warn, wordWrap: true });
    this.noticeLabel.pos(210, 82);
    this.noticeLabel.visible = false;

    this.playerHeading = label(this.view, "玩家", 28, { bold: true });
    this.playerHeading.pos(75, 175);
    this.playerList = scrollList(this.view, 75, 220, 600, 300);

    this.waitingControls = box(this.view, 0, 920, TABLE_WIDTH, 110);
    this.waitingTable = box(this.view, 360, 130, 1200, 750, "#195b3d");
    textButton(this.waitingControls, "分享名片", 570, 0, 260, 80, THEME.accentDark, () => shareDialog(this.view, this.flow));
    this.backHomeButton = textButton(this.view, "返回大厅", 30, 980, 230, 70, THEME.accentDark, () => { void this.flow.backHome(); });
    this.startButton = textButton(this.waitingControls, "开始对局", 1090, 0, 260, 80, THEME.accentDark, () => void this.flow.startMatch());

    this.matchArea = box(this.view, 0, 72, TABLE_WIDTH, TABLE_HEIGHT - 72, "#154e38");

    this.resultOverlay = box(this.view, 410, 95, 1100, 940, THEME.panelBg2);
    this.resultTitle = label(this.resultOverlay, "", 34, { width: 1100, align: "center", bold: true, color: THEME.accent });
    this.resultTitle.pos(0, 30);
    // 标题与正文之间那一档（正文从 y=100 起）：够放一行 20 号字，不需要动正文的布局。
    this.resultTime = label(this.resultOverlay, "", 20, { width: 1100, align: "center" });
    this.resultTime.pos(0, 70);
    this.resultTime.visible = false;
    this.resultBody = box(this.resultOverlay, 75, 100, 950, 740);
    // 一小场那屏：**压在牌桌正中**的一小块，不是整屏浮层 —— 牌桌一直看得见，
    // 也点不到任何按钮，3 秒（服务端给的停留时长）后自己收掉。
    // 只有四行「号位 + 昵称 + 得失分」，牌型与牌面按玩法都不在这屏出现。
    this.roundPop = box(this.view, 610, 390, 700, 290, THEME.panelBg2);
    this.roundPopTitle = label(this.roundPop, "", 26, { width: 700, align: "center", color: THEME.accent });
    this.roundPopTitle.pos(0, 14);
    // 四家各一行（用显式换行而不是自动折行：四家的行数固定，自动折行反而会因昵称长度跑版）。
    this.roundPopBody = label(this.roundPop, "", 34, { width: 700, align: "center", wordWrap: true, bold: true });
    this.roundPopBody.pos(0, 56);
    this.roundPopFoot = label(this.roundPop, "", 20, { width: 700, align: "center" });
    this.roundPopFoot.pos(0, 222);
    this.roundPop.visible = false;
    textButton(this.resultOverlay, "继续", 425, 850, 250, 70, THEME.accentDark, () => {
      this.resultDismissed = true;
      this.resultOverlay.visible = false;
    });
    this.resultOverlay.visible = false;

    // 托管浮层：压在后牌桌正中，**不全屏遮挡** —— 牌面看得见正是这个状态要传达的信息
    // （另外三家在替你打）。这里只让人点不到牌，并给出唯一的出路：重新接管。
    this.trusteePanel = box(this.view, 660, 390, 600, 250, THEME.panelBg2);
    label(this.trusteePanel, "你的牌局正在托管中", 34, { width: 600, align: "center", bold: true, color: THEME.accent }).pos(0, 36);
    this.trusteeRoundLabel = label(this.trusteePanel, "", 26, { width: 600, align: "center", color: THEME.warn });
    this.trusteeRoundLabel.pos(0, 96);
    textButton(this.trusteePanel, "重新接管", 175, 156, 250, 76, THEME.accentDark, () => this.flow.requestTakeover());
    this.trusteePanel.visible = false;
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
    if (!incoming) return;
    if (!acceptRoomSnapshot(this.snapshot?.status ?? null, incoming.status)) return;
    this.snapshot = incoming;
  }

  hide(): void {
    this.stopPolling();
    this.stopClock();
  }

  /**
   * 牌桌菜单：继续游戏 / 返回大厅 / 退出游戏。
   *
   * 三个动作的语义完全不同，所以文案里把差别写清楚 ——
   * 「返回大厅」只是暂时离开牌桌（控制权还在玩家手上，回来直接接着打）；
   * 「退出游戏」是把座位交给服务器托管（要回来得点「重新接管」）。
   */
  private openTableMenu(): void {
    const overlay = box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#0b1120e6");
    overlay.zOrder = 100;
    label(overlay, "牌桌菜单", 36, { width: 620, color: THEME.text, bold: true, align: "center" }).pos(650, 220);
    textButton(overlay, "继续游戏", 760, 310, 400, 80, THEME.accentDark, () => overlay.destroy(true));
    textButton(overlay, "返回大厅", 760, 415, 400, 80, THEME.panelBg2, () => {
      overlay.destroy(true);
      void this.flow.backHome();
    });
    textButton(overlay, "退出游戏", 760, 520, 400, 80, THEME.panelBg2, () => {
      overlay.destroy(true);
      this.confirmQuitGame();
    });
    label(overlay, "返回大厅：暂时离开牌桌，你仍属于这一局，随时可以回来接着打。", 22, { width: 700, color: THEME.textDim, wordWrap: true }).pos(610, 650);
    label(overlay, "退出游戏：由服务器接管你的座位并自动代打，牌、座次与积分都保留。", 22, { width: 700, color: THEME.textDim, wordWrap: true }).pos(610, 710);
  }

  /**
   * 退出前的二次确认。
   *
   * 这个动作不可逆地交出了操作权（要拿回来得点「重新接管」），所以必须让人明确点一次，
   * 而不是在一次误触里就离开牌桌。
   */
  private confirmQuitGame(): void {
    const overlay = box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#0b1120f2");
    overlay.zOrder = 110;
    label(overlay, "确定退出当前游戏吗？", 36, { width: 620, color: THEME.accent, bold: true, align: "center" }).pos(650, 310);
    label(overlay, "退出后系统将自动托管你的座位，\n本次大局结束前你可以回来重新接管。", 26, {
      width: 620,
      color: THEME.text,
      align: "center",
      wordWrap: true,
    }).pos(650, 390);
    textButton(overlay, "取消", 660, 540, 250, 80, THEME.panelBg2, () => overlay.destroy(true));
    textButton(overlay, "确认退出", 1010, 540, 250, 80, THEME.accentDark, () => {
      overlay.destroy(true);
      // 服务端接管后会把控制权随下一帧下发，界面据此切成「托管中 + 重新接管」。
      this.flow.quitGame();
    });
  }

  private renderAll(notice?: string): void {
    this.noticeLabel.visible = notice !== undefined;
    this.noticeLabel.text = notice ?? "";
    const waiting = this.snapshot?.status === "waiting" && this.match === null;
    // 显示房间号而不是内部 roomId —— 玩家要把它念给下一桌的人听。
    const number = this.roomNo.length > 0 ? `房间号 ${this.roomNo}` : "房间号读取中";
    this.statusLabel.text = `${number} · ${this.roomStatusText()}`;
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

  /**
   * 标题栏那半句状态（判据收在 `effectiveRoomStatus` 里，可单测）。
   */
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
    const players = this.snapshot?.players ?? [];
    const me = Math.max(0, players.findIndex((player) => player.userId === this.getMe()?.userId));
    const positions = [[505, 565], [940, 295], [505, 25], [70, 295]];
    for (let index = 0; index < 4; index++) {
      const player = players[(me + index) % 4];
      const [x, y] = positions[index]!;
      const seat = box(this.waitingTable, x!, y!, 190, 160);
      socialAvatar(seat, player?.nickname ?? "＋", player?.avatarUrl, 59, 0);
      label(seat, player?.nickname ?? "等待入座", 24, { width: 190, align: "center" }).pos(0, 83);
      if (player) {
        label(seat, `ID ${player.userId}`, 19, { width: 190, align: "center" }).pos(0, 114);
        if (player.userId === this.snapshot?.ownerId) label(seat, "房主", 20, { width: 190, align: "center", color: "#f1d18c" }).pos(0, 141);
      }
    }
    label(this.waitingTable, `房间 ${this.roomNo}\n${players.length}/4 人`, 34, { width: 320, align: "center", wordWrap: true }).pos(440, 330);
  }

  private renderWaitingControls(): void {
    this.startButton.visible = this.snapshot?.ownerId === this.getMe()?.userId;
    const full = this.snapshot?.players.length === 4;
    this.startButton.mouseEnabled = full;
    this.startButton.alpha = full ? 1 : 0.45;
    setButtonText(this.startButton, full ? "开始游戏" : "等待四人到齐");
  }

  private renderMatch(match: MatchState): void {
    this.matchArea.removeChildren();
    const table = box(this.matchArea, 400, 130, 1120, 580, THEME.fieldBg);
    const acting = match.currentPlayerSeat === null ? "等待" : playerName(this.snapshot, match.currentPlayerSeat);
    label(table, `第 ${match.roundNumber}/${match.totalRounds ?? 8} 局`, 30, { width: 260, align: "center", bold: true, color: THEME.accent }).pos(430, 220);
    label(table, `${PHASE_NAMES[match.phase]} · 剩余 ${match.tilesLeft} 张`, 24, { width: 360, align: "center" }).pos(380, 265);
    label(table, `当前：${acting}`, 24, { width: 360, align: "center", color: THEME.warn }).pos(380, 305);
    this.turnClock = label(table, "", 36, { width: 180, align: "center", bold: true, color: THEME.accent });
    this.turnClock.pos(470, 350);

    const zones: Record<TableSide, [number, number, number, number]> = {
      top: [210, 20, 700, 125], right: [890, 130, 210, 330],
      bottom: [210, 430, 700, 125], left: [20, 130, 210, 330],
    };
    for (const player of match.players) {
      const side = tableSide(match.seat, player.seat);
      const [x, y, w, h] = zones[side];
      const zone = box(table, x, y, w, h, "#123526");
      const state = `${player.won ? "已胡 · " : ""}${player.missingSuit ? `缺${SUIT_NAMES[player.missingSuit]} · ` : ""}`;
      label(zone, `${state}${tileRun(player.discards)}`, 19, { width: w - 20, align: "center", wordWrap: true, color: THEME.textDim }).pos(10, 12);
    }

    this.renderSeatPanels(match);

    const melds = match.melds.map((meld) => `${meld.kind === "pong" ? "碰" : meld.concealed ? "暗杠" : "杠"}${tileName(meld.tile)}`).join("　");
    label(this.matchArea, `副露：${melds || "无"}`, 22, { width: 760 }).pos(300, 730);
    label(this.matchArea, match.missingSuit ? `定缺：${SUIT_NAMES[match.missingSuit]}` : "定缺：待定", 22, { color: THEME.textDim }).pos(1070, 730);

    const hand = sortedHand(match.hand);
    label(this.matchArea, "我的手牌", 25, { bold: true }).pos(300, 775);
    this.renderHand(hand, match);
    this.renderControls(hand, match);
    this.updateClock();
    this.startClock();
  }

  private renderSeatPanels(match: MatchState): void {
    const positions: Record<TableSide, [number, number, number, number]> = {
      bottom: [30, 770, 245, 190], right: [1640, 325, 245, 240],
      top: [840, 10, 245, 120], left: [35, 325, 245, 240],
    };
    for (const player of match.players) {
      const side = tableSide(match.seat, player.seat);
      const [x, y, w, h] = positions[side];
      // 暗杠：服务端只让对手看到一副「扣着的杠」。牌值可见时亮一张、其余扣着；
      // 若口径改成全扣（tile 为 null），就只写「暗杠」不带牌值。
      const melds = player.melds
        .map((meld) => {
          if (meld.tile === null) return "暗杠(扣)";
          if (meld.kind === "kong" && meld.concealed) return `暗杠${tileName(meld.tile)}(扣3)`;
          return `${meld.kind === "pong" ? "碰" : "杠"}${tileName(meld.tile)}`;
        })
        .join(" ");
      // 在场状态要让另外三家看得见：托管中的座位是**服务器在打**，
      // 不标出来的话别人会一直等"他怎么还不出牌"。
      const presence = player.presence === "trustee" ? " · 托管中"
        : player.presence === "away" ? " · 暂离"
        : player.presence === "disconnected" ? " · 掉线" : "";
      const snap = this.snapshot?.players[player.seat];
      const row = box(this.matchArea, x, y, w, h, player.seat === match.currentPlayerSeat ? THEME.accentDark : THEME.panelBg2);
      // 头像优先用对局帧自带的那份（`MatchState.players[].avatarUrl`）—— 它在每一帧里都有，
      // 而房间快照可能还没到/还没刷新。昵称对局帧不带，只能靠快照，取不到就退回「玩家N」。
      socialAvatar(row, snap?.nickname ?? String(player.seat), snap?.avatarUrl ?? player.avatarUrl, 50, 10);
      label(row, `${playerName(this.snapshot, player.seat)}${presence}`, 20, { width: 165, bold: true }).pos(72, 10);
      label(row, `本场 ${fmtDelta(player.matchDelta ?? 0)} · 本局 ${fmtDelta(player.roundDelta ?? 0)}`, 18, { width: 165, color: THEME.warn }).pos(72, 40);
      const controlText = player.seat === match.seat
        ? (match.control === "trustee" ? "托管" : "本人")
        : (player.presence === "trustee" ? "托管" : "本人");
      const awayText = player.seat === match.seat ? (match.away ? " · 暂离" : "") : (player.presence === "away" ? " · 暂离" : "");
      label(row, `${controlText}${awayText}${player.won ? " · 已胡" : ""}`, 18, { width: 165, color: THEME.textDim }).pos(72, 67);
      if (side !== "bottom") {
        const backs = opponentBacks(player.handSize);
        const vertical = side === "left" || side === "right";
        backs.forEach((_, index) => {
          const back = box(row, vertical ? 20 + (index % 7) * 27 : 10 + index * 16, vertical ? 104 + Math.floor(index / 7) * 42 : 94, 24, 36, "#315d84");
          back.alpha = 0.95;
        });
      }
      if (melds) label(row, melds, 16, { width: w - 20, color: THEME.textDim, wordWrap: true }).pos(10, h - 36);
    }
  }

  private renderHand(hand: Tile[], match: MatchState): void {
    const canDiscard = actionAvailable(this.liveActions, "discard") && match.phase === "playing";
    // 定缺之后手里还有缺门牌时，服务端只收缺门牌（`Missing suit tiles must be discarded first`），
    // 所以这里也把能点的牌收窄到缺门 —— 与浏览器端的 `DiscardSelection.canSelect` 同一判据。
    // 不收窄的话，点一张缺门之外的牌会被服务端拒掉，看起来就像「点了没反应」。
    const discardable = canDiscard ? discardableIndexes(hand, match.missingSuit) : null;
    const canSwap = match.phase === "swapping" && actionAvailable(this.liveActions, "swap");
    // 托管中：牌照常显示（看得见牌局），但一张都不能点 —— 这一座现在由服务器操作。
    // 服务端那边也会拒（`SEAT_UNDER_TRUSTEE`），这里只是别让人点了没反应。
    const trustee = match.control === "trustee";
    hand.forEach((tile, index) => {
      const selected = this.selectedIndexes.has(index);
      const enabled = !trustee && (canSwap || (discardable?.has(index) ?? false));
      const card = box(this.matchArea, 300 + index * 74, selected ? 800 : 818, 68, 104, selected ? THEME.accentDark : "#f3ead7");
      card.alpha = enabled ? 1 : 0.48;
      const image = new Laya.Image();
      image.skin = tileAsset(tile);
      image.pos(6, 5);
      image.size(56, 84);
      card.addChild(image);
      label(card, String((tile % 9) + 1), 14, { width: 68, align: "center", color: "#2a2118" }).pos(0, 86);
      if (enabled) card.on(Laya.Event.CLICK, null, () => this.toggleTile(index, hand, match));
    });
  }

  private renderControls(hand: Tile[], match: MatchState): void {
    const controls = box(this.matchArea, 1370, 735, 520, 245, THEME.panelBg);
    // 托管中：一个操作按钮都不给。服务端同样会拒绝（见 ws-server 的控制权闸门），
    // 这里说明一下"为什么点不动"，否则看起来像卡住了。
    if (match.control === "trustee") {
      label(controls, "托管中 · 由服务器代打", 28, { width: 480, align: "center", color: THEME.accent }).pos(20, 60);
      label(controls, "点牌桌中央的「重新接管」", 22, { width: 480, align: "center", color: THEME.textDim }).pos(20, 120);
      return;
    }
    if (match.phase === "swapping" && actionAvailable(this.liveActions, "swap")) {
      const valid = swapSelectionIsValid(hand, this.selectedIndexes);
      label(controls, valid ? "已选同花色三张牌" : `请选择同一花色的三张牌（${this.selectedIndexes.size}/3）`, 22, {
        width: 480,
        align: "center",
        color: valid ? THEME.good : THEME.warn,
      }).pos(20, 18);
      textButton(controls, "确认换牌", 30, 75, 220, 78, valid ? THEME.accentDark : THEME.panelBg2, () => {
        if (!valid || this.actionLocked) return;
        this.actionLocked = true;
        this.flow.swap(selectedTiles(hand, this.selectedIndexes));
        this.resetSelection();
      });
      textButton(controls, "自动选择", 270, 75, 220, 78, THEME.panelBg2, () => this.send(() => this.flow.autoSwap()));
      return;
    }

    if (match.phase === "missing" && actionAvailable(this.liveActions, "choose-missing")) {
      label(controls, "请选择本局定缺花色", 22, { width: 480, align: "center", color: THEME.warn }).pos(20, 18);
      (["wan", "tong", "tiao"] as const).forEach((suit, index) => {
        textButton(controls, `缺${SUIT_NAMES[suit]}`, 18 + index * 125, 70, 112, 72, THEME.accentDark, () => this.send(() => this.flow.chooseMissing(suit)));
      });
      textButton(controls, "自动", 400, 70, 102, 72, THEME.panelBg2, () => this.send(() => this.flow.autoMissing()));
      return;
    }

    const buttons: Array<{ text: string; action: () => void; color?: string }> = [];
    if (match.phase === "claiming") {
      if (actionAvailable(this.liveActions, "hu")) buttons.push({ text: "胡", action: () => this.flow.claim("hu"), color: THEME.accentDark });
      if (actionAvailable(this.liveActions, "peng")) buttons.push({ text: "碰", action: () => this.flow.claim("peng") });
      if (actionAvailable(this.liveActions, "kong")) buttons.push({ text: "杠", action: () => this.flow.claim("kong") });
      if (actionAvailable(this.liveActions, "pass")) buttons.push({ text: "过", action: () => this.flow.claim("pass") });
    } else {
      if (actionAvailable(this.liveActions, "discard")) {
        const selected = [...this.selectedIndexes][0];
        buttons.push({
          text: selected !== undefined ? `打出 ${tileName(hand[selected]!)}` : "请先选牌",
          action: () => {
            if (selected === undefined) return;
            this.flow.discard(hand[selected]!);
            this.resetSelection();
          },
          color: selected !== undefined ? THEME.accentDark : THEME.panelBg2,
        });
      }
      if (actionAvailable(this.liveActions, "hu")) buttons.push({ text: "自摸", action: () => this.flow.selfDraw(), color: THEME.accentDark });
      if (actionAvailable(this.liveActions, "kong-concealed")) buttons.push({ text: "暗杠", action: () => this.flow.concealedKong() });
      if (actionAvailable(this.liveActions, "kong-added")) buttons.push({ text: "补杠", action: () => this.flow.addedKong() });
    }

    if (buttons.length === 0) {
      label(controls, match.won ? "本局已胡，等待其他玩家" : "等待其他玩家操作…", 24, { width: 480, align: "center", color: THEME.textDim }).pos(20, 80);
      return;
    }
    const width = Math.min(150, Math.floor((480 - (buttons.length - 1) * 12) / buttons.length));
    const total = buttons.length * width + (buttons.length - 1) * 12;
    buttons.forEach((button, index) => {
      textButton(controls, button.text, (520 - total) / 2 + index * (width + 12), 70, width, 80, button.color ?? THEME.panelBg2, () => this.send(button.action));
    });
  }

  private renderResult(): void {
    const result = this.lastResult;

    // ---- 一小场那一屏：**弹在牌桌上**，只报四家的得失分 ----
    // 牌型、四家牌面、胡牌明细都不在这屏出现（按玩法），也不用玩家按任何东西：
    // 到点（服务端给的停留时长）自己收，随后开下一小场。
    //
    // 判据是 `roundPopIsLive()` 而**不是** `this.match === null`：服务端一小场结束时只发
    // 结算帧、不发 `game` 帧，`this.match` 停在结束之前的状态，那个判据一次都不会成立
    // —— 结果就是这一屏永远不出现。`lastMatchResult` 也不能当"该收屏"的信号：
    // 打满 8 小场时它随 `match-finished` 一起来，但最后一小场那屏仍要放满停留时长
    // 再交接给整局结算记录（见 flow 里 `roundPopUntil` 的说明）。
    if (result !== null && this.popVisible()) {
      const left = this.popUntil === null ? null : this.popUntil - Date.now();
      this.roundPopTitle.text = roundLabel(result.roundNumber ?? 1, result.totalRounds);
      // 四家按座位排：`deltas` 是服务端按座位顺序下发的，没有 `players` 时按下标兜底
      // （与下面整局结算那一屏同一套兜底写法）。
      const rows: NonNullable<RoomResult["players"]> = result.players
        ?? result.deltas.map<NonNullable<RoomResult["players"]>[number]>((entry, seat) => ({ playerId: entry.playerId, seat, won: false, hand: [], melds: [] }));
      this.roundPopBody.text = [...rows]
        .sort((left0, right) => left0.seat - right.seat)
        .map((player) => {
          const delta = result.deltas.find((entry) => entry.playerId === player.playerId)?.delta ?? 0;
          const name = this.snapshot?.players.find((entry) => entry.userId === player.playerId)?.nickname ?? `${player.seat} 号位`;
          return `${player.seat} 号位 ${name}  ${fmtDelta(delta)}`;
        })
        .join("\n");
      this.roundPopFoot.text = left === null ? "" : `${Math.ceil(left / 1000)} 秒后开始下一小场`;
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

    this.resultTitle.text = settled.reason === "dissolved"
      ? `本局结算记录 · 中途解散 · 已打 ${settled.completedRounds} 小场`
      : `本局结算记录 · 打满 ${settled.completedRounds} 小场`;
    // 「开始时间 · 耗时」。文案与两个浏览器客户端共用一份（`matchTimeText` 收在 client 包里），
    // 时间戳缺任一个时它返回 null，这里就整行隐藏。
    const time = matchTimeText(settled.startedAt, settled.finishedAt);
    this.resultTime.text = time ?? "";
    this.resultTime.visible = time !== null;
    this.resultBody.removeChildren();
    // 本小场那一份可能是空的：中途解散时整局结算会**先于**任何一小场结算到达。
    // 浏览器端同样允许这种情况（`matchResultPanel(result, snapshot, round = null)`），
    // 所以这里的每一处取值都要能容忍 `result === null`。
    const winnerSeats = result?.winnerSeats ?? [];
    label(this.resultBody, winnerSeats.length > 0 ? `胡牌：${winnerSeats.map((seat) => `座位${seat}`).join("、")}` : "流局", 26).pos(0, 0);
    // 每家胡了什么牌型、谁给的牌 —— 结算界面的第一信息，放在牌面之前。
    // 与两个浏览器客户端共用一份文案（win-summary 收在 client 包里）。
    let winY = 32;
    for (const win of result?.wins ?? []) {
      const who = this.snapshot?.players[win.seat]?.nickname ?? `座位${win.seat}`;
      label(this.resultBody, `${who}：${winSummaryText(win, this.snapshot)}`, 22, { width: 640, wordWrap: true }).pos(0, winY);
      winY += 46;
    }
    const nickOf = (userId: string): string => this.snapshot?.players.find((player) => player.userId === userId)?.nickname ?? userId;
    // 没有本小场那一份时退回整局结算的行（它有 `seat`，足够排四行）。
    const players: NonNullable<RoomResult["players"]> = result?.players
      ?? result?.deltas.map<NonNullable<RoomResult["players"]>[number]>((entry, seat) => ({ playerId: entry.playerId, seat, won: false, hand: [], melds: [] }))
      ?? settled.players?.map<NonNullable<RoomResult["players"]>[number]>((entry) => ({ playerId: entry.playerId, seat: entry.seat, won: false, hand: [], melds: [] }))
      ?? [];
    // 本小场得失分：单局那份优先，没有就退回整局结算里的 `rawDeltas`。
    const deltaOf = (playerId: string): number => result?.deltas.find((entry) => entry.playerId === playerId)?.delta
      ?? settled.rawDeltas.find((entry) => entry.playerId === playerId)?.delta
      ?? 0;
    const rowsTop = winY + 13;
    players.forEach((player, index) => {
      const delta = deltaOf(player.playerId);
      const y = rowsTop + index * 190;
      // 整局结算那一侧的行数据（服务端按座位拼好的）：头像、昵称、10 位 id 号、
      // 实际入账分与入账后余额都在这里。一小场结束时没有这一份。
      const settledPlayer = settled.players?.find((entry) => entry.playerId === player.playerId);
      // 这一行有两个数，别混：`delta` 是本小场，`cumulative` 是整局累计（头像下显示的那个）。
      const cumulative = player.matchDelta ?? settledPlayer?.delta;
      const total = cumulative === undefined ? "" : ` · 本场累计 ${fmtDelta(cumulative)}`;
      const nickname = settledPlayer?.nickname ?? nickOf(player.playerId);
      const idText = settledPlayer ? `（ID ${settledPlayer.playerId}）` : "";
      // 头像只有整局结算拿得到（快照的成员列表里没有头像字段，`match-finished` 才带上）。
      // 取不到就只留昵称，不留一个空图。
      let textLeft = 0;
      if (settledPlayer?.avatarUrl) {
        const avatar = new Laya.Image();
        avatar.skin = settledPlayer.avatarUrl; avatar.pos(0, y - 6); avatar.size(40, 40);
        this.resultBody.addChild(avatar);
        textLeft = 48;
      }
      label(this.resultBody, `${nickname}${idText}${player.won ? " · 已胡" : ""}  ${delta > 0 ? "赢 " : delta < 0 ? "输 " : ""}${fmtDelta(delta)} 分${total}`, 26, { color: delta >= 0 ? THEME.good : THEME.bad, width: 650 - textLeft }).pos(textLeft, y);
      const tiles = sortedHand(player.hand);
      tiles.forEach((tile, i) => {
        const image = new Laya.Image();
        image.skin = tileAsset(tile); image.pos(i * 44, y + 40); image.size(40, 60);
        this.resultBody.addChild(image);
      });
      if (settledPlayer) {
        label(this.resultBody, `账号入账：${fmtDelta(settledPlayer.accountDelta)} · 余额 ${settledPlayer.balance}`, 20).pos(0, y + 160);
      }
      let x = 0;
      player.melds.forEach((meld) => {
        for (let i = 0; i < (meld.kind === "kong" ? 4 : 3); i++) {
          const image = new Laya.Image();
          image.skin = tileAsset(meld.tile); image.pos(x, y + 108); image.size(30, 45);
          this.resultBody.addChild(image); x += 32;
        }
        x += 10;
      });
    });
    this.resultOverlay.visible = true;
  }

  private toggleTile(index: number, hand: Tile[], match: MatchState): void {
    // 这一小场已经结算：牌桌上压着结算那屏，旧手牌不该再有任何反应。
    if (this.roundFinished) return;
    if (match.phase === "swapping") {
      if (this.selectedIndexes.has(index)) this.selectedIndexes.delete(index);
      else if (this.selectedIndexes.size < 3) this.selectedIndexes.add(index);
    } else {
      this.selectedIndexes = this.selectedIndexes.has(index) ? new Set() : new Set([index]);
    }
    this.renderMatch(match);
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
    this.clockTimer = setInterval(() => this.updateClock(), 250);
  }

  private stopClock(): void {
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.turnClock = null;
  }

  private updateClock(): void {
    if (!this.turnClock || !this.match) return;
    const seconds = deadlineSeconds(this.match.actionDeadlineAt);
    this.turnClock.text = seconds === null ? "" : `${seconds}s`;
    this.turnClock.color = seconds !== null && seconds <= 5 ? THEME.bad : THEME.accent;
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
