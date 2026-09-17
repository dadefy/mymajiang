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
import { THEME, box, fmtDelta, label, refill, scrollList, setButtonText, textButton, tileName, tileRun } from "./widgets.js";

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

function playerName(snapshot: RoomSnapshot | null, seat: number): string {
  const player = snapshot?.players[seat];
  return player ? player.nickname : `玩家${seat}`;
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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 一小场那屏数字到点自己收的定时器（到点重画一次，好交接给整局结算记录）。 */
  private popTimer: ReturnType<typeof setTimeout> | null = null;
  private selectedIndexes = new Set<number>();
  private handSignature = "";
  private actionLocked = false;

  constructor(
    private readonly flow: ClientFlow,
    private readonly api: ApiClient,
    parent: Laya.Stage,
    private readonly getMe: () => { userId: string } | undefined,
  ) {
    this.view = new Laya.Box();
    this.view.size(750, 1334);
    parent.addChild(this.view);

    const header = box(this.view, 0, 0, 750, 100, THEME.panelBg);
    this.statusLabel = label(header, "", 30, { bold: true });
    this.statusLabel.pos(30, 34);
    // 两种退出在同一个位置上互斥出现：
    //   等人/未开局 → 「退出」= 真的离开房间（waiting 期合法，服务端会放行）
    //   牌局进行中  → 「菜单」= 继续游戏 / 返回大厅 / 退出游戏
    //                  （这一阶段服务端拒绝"离开房间"，必须走托管那条路）
    this.exitButton = textButton(header, "退出", 610, 20, 110, 60, THEME.panelBg2, () => void this.flow.leaveRoom());
    this.menuButton = textButton(header, "菜单", 610, 20, 110, 60, THEME.panelBg2, () => this.openTableMenu());
    this.menuButton.visible = false;

    this.noticeLabel = label(this.view, "", 24, { width: 690, align: "center", color: THEME.warn, wordWrap: true });
    this.noticeLabel.pos(30, 112);
    this.noticeLabel.visible = false;

    this.playerHeading = label(this.view, "玩家", 28, { bold: true });
    this.playerHeading.pos(75, 175);
    this.playerList = scrollList(this.view, 75, 220, 600, 300);

    this.waitingControls = box(this.view, 0, 560, 750, 110);
    this.waitingTable = box(this.view, 25, 180, 700, 750, "#195b3d");
    this.waitingControls.y = 970;
    textButton(this.waitingControls, "分享名片", 35, 0, 260, 80, THEME.accentDark, () => shareDialog(this.view, this.flow));
    textButton(this.view, "返回大厅", 260, 1220, 230, 70, THEME.accentDark, () => { void this.flow.backHome(); });
    this.startButton = textButton(this.waitingControls, "开始对局", 345, 0, 220, 88, THEME.accentDark, () => void this.flow.startMatch());

    this.matchArea = box(this.view, 0, 150, 750, 1184);

    this.resultOverlay = box(this.view, 25, 130, 700, 1080, THEME.panelBg2);
    this.resultTitle = label(this.resultOverlay, "", 34, { width: 700, align: "center", bold: true, color: THEME.accent });
    this.resultTitle.pos(0, 30);
    // 标题与正文之间那一档（正文从 y=100 起）：够放一行 20 号字，不需要动正文的布局。
    this.resultTime = label(this.resultOverlay, "", 20, { width: 700, align: "center" });
    this.resultTime.pos(0, 70);
    this.resultTime.visible = false;
    this.resultBody = box(this.resultOverlay, 25, 100, 650, 840);
    // 一小场那屏：**压在牌桌正中**的一小块，不是整屏浮层 —— 牌桌一直看得见，
    // 也点不到任何按钮，3 秒（服务端给的停留时长）后自己收掉。
    // 只有四行「号位 + 昵称 + 得失分」，牌型与牌面按玩法都不在这屏出现。
    this.roundPop = box(this.view, 55, 600, 640, 260, THEME.panelBg2);
    this.roundPopTitle = label(this.roundPop, "", 26, { width: 640, align: "center", color: THEME.accent });
    this.roundPopTitle.pos(0, 14);
    // 四家各一行（用显式换行而不是自动折行：四家的行数固定，自动折行反而会因昵称长度跑版）。
    this.roundPopBody = label(this.roundPop, "", 34, { width: 640, align: "center", wordWrap: true, bold: true });
    this.roundPopBody.pos(0, 56);
    this.roundPopFoot = label(this.roundPop, "", 20, { width: 640, align: "center" });
    this.roundPopFoot.pos(0, 222);
    this.roundPop.visible = false;
    textButton(this.resultOverlay, "继续", 225, 980, 250, 70, THEME.accentDark, () => {
      this.resultDismissed = true;
      this.resultOverlay.visible = false;
    });
    this.resultOverlay.visible = false;

    // 托管浮层：压在后牌桌正中，**不全屏遮挡** —— 牌面看得见正是这个状态要传达的信息
    // （另外三家在替你打）。这里只让人点不到牌，并给出唯一的出路：重新接管。
    this.trusteePanel = box(this.view, 75, 560, 600, 250, THEME.panelBg2);
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
      this.resultDismissed = false;
      this.resetSelection();
    } else if (!this.snapshot && screen.snapshot) {
      this.snapshot = screen.snapshot;
    }
    // 房间号进房时不一定知道（快照才带），所以每次都跟最新值走，别退回空字符串。
    this.roomNo = screen.roomNo ?? this.roomNo;
    this.snapshot = screen.snapshot ?? this.snapshot;
    this.match = screen.match;
    this.actions = screen.actions;
    this.actionLocked = false;
    this.syncSelection(screen.match);
    if (screen.lastResult && screen.lastResult !== this.lastResult) this.resultDismissed = false;
    this.lastResult = screen.lastResult;
    this.lastMatchResult = screen.lastMatchResult;
    this.popUntil = screen.roundPopUntil;
    this.renderAll(screen.notice);
    this.schedulePolling();
  }

  hide(): void {
    this.stopPolling();
  }

  /**
   * 牌桌菜单：继续游戏 / 返回大厅 / 退出游戏。
   *
   * 三个动作的语义完全不同，所以文案里把差别写清楚 ——
   * 「返回大厅」只是暂时离开牌桌（控制权还在玩家手上，回来直接接着打）；
   * 「退出游戏」是把座位交给服务器托管（要回来得点「重新接管」）。
   */
  private openTableMenu(): void {
    const overlay = box(this.view, 0, 0, 750, 1334, "#0b1120e6");
    overlay.zOrder = 100;
    label(overlay, "牌桌菜单", 36, { width: 620, color: THEME.text, bold: true, align: "center" }).pos(65, 360);
    textButton(overlay, "继续游戏", 175, 450, 400, 88, THEME.accentDark, () => overlay.destroy(true));
    textButton(overlay, "返回大厅", 175, 560, 400, 88, THEME.panelBg2, () => {
      overlay.destroy(true);
      void this.flow.backHome();
    });
    textButton(overlay, "退出游戏", 175, 670, 400, 88, THEME.panelBg2, () => {
      overlay.destroy(true);
      this.confirmQuitGame();
    });
    label(overlay, "返回大厅：暂时离开牌桌，你仍属于这一局，随时可以回来接着打。", 22, { width: 620, color: THEME.textDim, wordWrap: true }).pos(65, 800);
    label(overlay, "退出游戏：由服务器接管你的座位并自动代打，牌、座次与积分都保留。", 22, { width: 620, color: THEME.textDim, wordWrap: true }).pos(65, 890);
  }

  /**
   * 退出前的二次确认。
   *
   * 这个动作不可逆地交出了操作权（要拿回来得点「重新接管」），所以必须让人明确点一次，
   * 而不是在一次误触里就离开牌桌。
   */
  private confirmQuitGame(): void {
    const overlay = box(this.view, 0, 0, 750, 1334, "#0b1120f2");
    overlay.zOrder = 110;
    label(overlay, "确定退出当前游戏吗？", 36, { width: 620, color: THEME.accent, bold: true, align: "center" }).pos(65, 440);
    label(overlay, "退出后系统将自动托管你的座位，\n本次大局结束前你可以回来重新接管。", 26, {
      width: 620,
      color: THEME.text,
      align: "center",
      wordWrap: true,
    }).pos(65, 520);
    textButton(overlay, "取消", 100, 680, 250, 88, THEME.panelBg2, () => overlay.destroy(true));
    textButton(overlay, "确认退出", 400, 680, 250, 88, THEME.accentDark, () => {
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
    this.statusLabel.text = `${number} · ${this.match ? STATUS_NAMES.playing : this.snapshot ? STATUS_NAMES[this.snapshot.status] : "连接中"}`;
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
    this.matchArea.visible = this.match !== null;
    if (waiting) {
      this.renderPlayers();
      this.renderWaitingControls();
    }
    if (this.match) this.renderMatch(this.match);
    this.renderResult();
  }

  private renderPlayers(): void {
    this.waitingTable.removeChildren();
    const players = this.snapshot?.players ?? [];
    const me = Math.max(0, players.findIndex((player) => player.userId === this.getMe()?.userId));
    const positions = [[255, 560], [495, 285], [255, 30], [15, 285]];
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
    label(this.waitingTable, `房间 ${this.roomNo}\n${players.length}/4 人`, 30, { width: 290, align: "center", wordWrap: true }).pos(205, 330);
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
    const acting = match.currentPlayerSeat === null ? "—" : `${playerName(this.snapshot, match.currentPlayerSeat)}（${match.currentPlayerSeat}号位）`;
    label(
      this.matchArea,
      `第 ${match.roundNumber}/8 局 · ${PHASE_NAMES[match.phase]} · 牌墙 ${match.tilesLeft} · 当前 ${acting}${match.won ? " · 我已胡" : ""}`,
      24,
      { width: 690, color: THEME.warn, wordWrap: true },
    ).pos(30, 0);

    this.renderOpponentRows(match);

    const table = box(this.matchArea, 30, 190, 690, 330, THEME.fieldBg);
    label(table, "牌桌弃牌", 22, { color: THEME.textDim }).pos(20, 15);
    match.players.forEach((player, rowIndex) => {
      const prefix = player.seat === match.seat ? "我" : playerName(this.snapshot, player.seat);
      const state = `${player.won ? " · 已胡" : ""}${player.missingSuit ? ` · 缺${SUIT_NAMES[player.missingSuit]}` : ""}`;
      label(table, `${prefix}${state}`, 21, { width: 170, color: player.seat === match.seat ? THEME.accent : THEME.text }).pos(20, 55 + rowIndex * 65);
      label(table, tileRun(player.discards), 20, { width: 470, wordWrap: true, color: THEME.textDim }).pos(185, 55 + rowIndex * 65);
    });

    const melds = match.melds.map((meld) => `${meld.kind === "pong" ? "碰" : meld.concealed ? "暗杠" : "杠"}${tileName(meld.tile)}`).join("　");
    label(this.matchArea, `我的副露：${melds || "无"}`, 22, { width: 480 }).pos(30, 540);
    label(this.matchArea, match.missingSuit ? `我的定缺：${SUIT_NAMES[match.missingSuit]}` : "我的定缺：待定", 22, { color: THEME.textDim }).pos(530, 540);

    const hand = sortedHand(match.hand);
    label(this.matchArea, "我的手牌", 25, { bold: true }).pos(30, 585);
    this.renderHand(hand, match);
    this.renderControls(hand, match);
  }

  private renderOpponentRows(match: MatchState): void {
    const others = match.players.filter((player) => player.seat !== match.seat).sort((left, right) => left.seat - right.seat);
    others.forEach((player, index) => {
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
      const text = `${playerName(this.snapshot, player.seat)} · ${player.handSize}张${player.won ? " · 已胡" : ""}${presence}${melds ? ` · ${melds}` : ""}`;
      const row = box(this.matchArea, 30 + index * 235, 82, 220, 78, player.won ? THEME.accentDark : THEME.panelBg2);
      label(row, text, 20, { width: 200, align: "center", wordWrap: true }).pos(10, 13);
    });
  }

  private renderHand(hand: Tile[], match: MatchState): void {
    const discardable = discardableIndexes(hand, match.missingSuit);
    const canDiscard = actionAvailable(this.actions, "discard") && match.phase === "playing";
    // 托管中：牌照常显示（看得见牌局），但一张都不能点 —— 这一座现在由服务器操作。
    // 服务端那边也会拒（`SEAT_UNDER_TRUSTEE`），这里只是别让人点了没反应。
    const trustee = match.control === "trustee";
    hand.forEach((tile, index) => {
      const selected = this.selectedIndexes.has(index);
      const enabled = !trustee && ((match.phase === "swapping" && actionAvailable(this.actions, "swap")) || (canDiscard && discardable.has(index)));
      const card = box(this.matchArea, 27 + index * 49, selected ? 620 : 634, 45, 69, selected ? THEME.accentDark : "#f3ead7");
      card.alpha = enabled ? 1 : 0.48;
      const image = new Laya.Image();
      image.skin = tileAsset(tile);
      image.pos(5, 5);
      image.size(35, 52);
      card.addChild(image);
      label(card, String((tile % 9) + 1), 14, { width: 45, align: "center", color: "#2a2118" }).pos(0, 53);
      if (enabled) card.on(Laya.Event.CLICK, null, () => this.toggleTile(index, hand, match));
    });
  }

  private renderControls(hand: Tile[], match: MatchState): void {
    const controls = box(this.matchArea, 30, 735, 690, 220, THEME.panelBg);
    // 托管中：一个操作按钮都不给。服务端同样会拒绝（见 ws-server 的控制权闸门），
    // 这里说明一下"为什么点不动"，否则看起来像卡住了。
    if (match.control === "trustee") {
      label(controls, "托管中 · 由服务器代打", 28, { width: 650, align: "center", color: THEME.accent }).pos(20, 60);
      label(controls, "想自己打就点牌桌中间的「重新接管」", 22, { width: 650, align: "center", color: THEME.textDim }).pos(20, 120);
      return;
    }
    if (match.phase === "swapping" && actionAvailable(this.actions, "swap")) {
      const valid = swapSelectionIsValid(hand, this.selectedIndexes);
      label(controls, valid ? "已选同花色三张牌" : `请选择同一花色的三张牌（${this.selectedIndexes.size}/3）`, 22, {
        width: 650,
        align: "center",
        color: valid ? THEME.good : THEME.warn,
      }).pos(20, 18);
      textButton(controls, "确认换牌", 80, 75, 240, 78, valid ? THEME.accentDark : THEME.panelBg2, () => {
        if (!valid || this.actionLocked) return;
        this.actionLocked = true;
        this.flow.swap(selectedTiles(hand, this.selectedIndexes));
        this.resetSelection();
      });
      textButton(controls, "自动选择", 370, 75, 240, 78, THEME.panelBg2, () => this.send(() => this.flow.autoSwap()));
      return;
    }

    if (match.phase === "missing" && actionAvailable(this.actions, "choose-missing")) {
      label(controls, "请选择本局定缺花色", 22, { width: 650, align: "center", color: THEME.warn }).pos(20, 18);
      (["wan", "tong", "tiao"] as const).forEach((suit, index) => {
        textButton(controls, `缺${SUIT_NAMES[suit]}`, 35 + index * 165, 70, 140, 72, THEME.accentDark, () => this.send(() => this.flow.chooseMissing(suit)));
      });
      textButton(controls, "自动", 535, 70, 120, 72, THEME.panelBg2, () => this.send(() => this.flow.autoMissing()));
      return;
    }

    const buttons: Array<{ text: string; action: () => void; color?: string }> = [];
    if (match.phase === "claiming") {
      if (actionAvailable(this.actions, "hu")) buttons.push({ text: "胡", action: () => this.flow.claim("hu"), color: THEME.accentDark });
      if (actionAvailable(this.actions, "peng")) buttons.push({ text: "碰", action: () => this.flow.claim("peng") });
      if (actionAvailable(this.actions, "kong")) buttons.push({ text: "杠", action: () => this.flow.claim("kong") });
      if (actionAvailable(this.actions, "pass")) buttons.push({ text: "过", action: () => this.flow.claim("pass") });
    } else {
      if (actionAvailable(this.actions, "discard")) {
        const selected = [...this.selectedIndexes][0];
        const discardable = discardableIndexes(hand, match.missingSuit);
        buttons.push({
          text: selected !== undefined && discardable.has(selected) ? `打出 ${tileName(hand[selected]!)}` : "请先选牌",
          action: () => {
            if (selected === undefined || !discardable.has(selected)) return;
            this.flow.discard(hand[selected]!);
            this.resetSelection();
          },
          color: selected !== undefined ? THEME.accentDark : THEME.panelBg2,
        });
      }
      if (actionAvailable(this.actions, "hu")) buttons.push({ text: "自摸", action: () => this.flow.selfDraw(), color: THEME.accentDark });
      if (actionAvailable(this.actions, "kong-concealed")) buttons.push({ text: "暗杠", action: () => this.flow.concealedKong() });
      if (actionAvailable(this.actions, "kong-added")) buttons.push({ text: "补杠", action: () => this.flow.addedKong() });
    }

    if (buttons.length === 0) {
      label(controls, match.won ? "本局已胡，等待其他玩家" : "等待其他玩家操作…", 24, { width: 650, align: "center", color: THEME.textDim }).pos(20, 80);
      return;
    }
    const width = Math.min(180, Math.floor((650 - (buttons.length - 1) * 12) / buttons.length));
    const total = buttons.length * width + (buttons.length - 1) * 12;
    buttons.forEach((button, index) => {
      textButton(controls, button.text, (690 - total) / 2 + index * (width + 12), 70, width, 80, button.color ?? THEME.panelBg2, () => this.send(button.action));
    });
  }

  private renderResult(): void {
    const result = this.lastResult;
    // 新一局已经开始（`this.match` 非空）就收掉。服务端一小场结束后会**立刻**开下一小场，
    // 所以 `lastResult` 在新局里依然有值 —— 只看它会让上一小场那屏一直压在新牌局上面
    // （两个浏览器客户端同一处坑）。
    const live = result !== null && !this.resultDismissed && this.match === null;

    // ---- 一小场那一屏：**弹在牌桌上**，只报四家的得失分 ----
    // 牌型、四家牌面、胡牌明细都不在这屏出现（按玩法），也不用玩家按任何东西：
    // 到点（服务端给的停留时长）自己收，随后开下一小场。
    if (live && result && this.lastMatchResult === null) {
      const left = this.popUntil === null ? null : this.popUntil - Date.now();
      if (left !== null && left <= 0) {
        // 时限到了（下一小场马上就来）：收掉，别再画。
        this.roundPop.visible = false;
        return;
      }
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

    const settled = this.lastMatchResult;
    if (!live || result === null || settled === null) {
      this.resultOverlay.visible = false;
      return;
    }

    // ---- 整局结算记录（打满 8 小场 / 中途解散）----
    this.resultTitle.text = `本局结算记录 · 打满 ${settled.completedRounds} 小场`;
    // 「开始时间 · 耗时」。文案与两个浏览器客户端共用一份（`matchTimeText` 收在 client 包里），
    // 时间戳缺任一个时它返回 null，这里就整行隐藏。
    const time = matchTimeText(settled.startedAt, settled.finishedAt);
    this.resultTime.text = time ?? "";
    this.resultTime.visible = time !== null;
    this.resultBody.removeChildren();
    label(this.resultBody, this.lastResult.winnerSeats.length > 0 ? `胡牌：${this.lastResult.winnerSeats.map((seat) => `座位${seat}`).join("、")}` : "流局", 26).pos(0, 0);
    // 每家胡了什么牌型、谁给的牌 —— 结算界面的第一信息，放在牌面之前。
    // 与两个浏览器客户端共用一份文案（win-summary 收在 client 包里）。
    let winY = 32;
    for (const win of this.lastResult.wins ?? []) {
      const who = this.snapshot?.players[win.seat]?.nickname ?? `座位${win.seat}`;
      label(this.resultBody, `${who}：${winSummaryText(win, this.snapshot)}`, 22, { width: 640, wordWrap: true }).pos(0, winY);
      winY += 46;
    }
    const nickOf = (userId: string): string => this.snapshot?.players.find((player) => player.userId === userId)?.nickname ?? userId;
    const players: NonNullable<RoomResult["players"]> = result.players ?? result.deltas.map<NonNullable<RoomResult["players"]>[number]>((entry, seat) => ({ playerId: entry.playerId, seat, won: false, hand: [], melds: [] }));
    const rowsTop = winY + 13;
    players.forEach((player, index) => {
      const delta = result.deltas.find((entry) => entry.playerId === player.playerId)?.delta ?? 0;
      const y = rowsTop + index * 190;
      // 整局结算那一侧的行数据（服务端按座位拼好的）：头像、昵称、10 位 id 号、
      // 实际入账分与入账后余额都在这里。一小场结束时没有这一份。
      const settledPlayer = settled.players?.find((entry) => entry.playerId === player.playerId);
      // 这一行有两个数，别混：`delta` 是本小场，`cumulative` 是整局累计（头像下显示的那个）。
      const cumulative = player.matchDelta;
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

  private async poll(): Promise<void> {
    const status = this.snapshot?.status;
    const needsRefresh = !this.snapshot || status === "waiting" || (status === "playing" && this.match === null);
    if (!needsRefresh) return;
    const fetched = await this.api.room(this.roomId);
    if (!fetched.ok) return;
    this.snapshot = fetched.value;
    this.renderAll();
  }
}
