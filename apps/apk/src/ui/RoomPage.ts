import type { ApiClient, ClientFlow, MatchState, MatchResult, RoomResult, RoomSnapshot, Screen, Suit, Tile } from "@mianyang-mahjong/client";
import { roundLabel, winSummaryText } from "@mianyang-mahjong/client";
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
  private readonly noticeLabel: Laya.Label;
  private readonly playerHeading: Laya.Label;
  private readonly playerList: Laya.VBox;
  private readonly waitingControls: Laya.Box;
  private readonly readyButton: Laya.Box;
  private readonly startButton: Laya.Box;
  private readonly matchArea: Laya.Box;
  private readonly resultOverlay: Laya.Box;
  private readonly resultTitle: Laya.Label;
  private readonly resultBody: Laya.Box;
  private roomId = "";
  /** 6 位房间号：给玩家看、让玩家转述的那串。快照回来之前可能还不知道。 */
  private roomNo = "";
  private snapshot: RoomSnapshot | null = null;
  private match: MatchState | null = null;
  private actions: string[] = [];
  private lastResult: RoomResult | null = null;
  private lastMatchResult: MatchResult | null = null;
  private resultDismissed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
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
    this.exitButton = textButton(header, "退出", 610, 20, 110, 60, THEME.panelBg2, () => void this.flow.leaveRoom());

    this.noticeLabel = label(this.view, "", 24, { width: 690, align: "center", color: THEME.warn, wordWrap: true });
    this.noticeLabel.pos(30, 112);
    this.noticeLabel.visible = false;

    this.playerHeading = label(this.view, "玩家", 28, { bold: true });
    this.playerHeading.pos(75, 175);
    this.playerList = scrollList(this.view, 75, 220, 600, 300);

    this.waitingControls = box(this.view, 0, 560, 750, 110);
    this.readyButton = textButton(this.waitingControls, "准备", 75, 0, 220, 88, THEME.accentDark, () => void this.toggleReady());
    this.startButton = textButton(this.waitingControls, "开始对局", 345, 0, 220, 88, THEME.accentDark, () => void this.flow.startMatch());

    this.matchArea = box(this.view, 0, 150, 750, 1184);

    this.resultOverlay = box(this.view, 25, 130, 700, 1080, THEME.panelBg2);
    this.resultTitle = label(this.resultOverlay, "", 34, { width: 700, align: "center", bold: true, color: THEME.accent });
    this.resultTitle.pos(0, 30);
    this.resultBody = box(this.resultOverlay, 25, 100, 650, 840);
    textButton(this.resultOverlay, "继续", 225, 980, 250, 70, THEME.accentDark, () => {
      this.resultDismissed = true;
      this.resultOverlay.visible = false;
    });
    this.resultOverlay.visible = false;
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
    this.match = screen.match;
    this.actions = screen.actions;
    this.actionLocked = false;
    this.syncSelection(screen.match);
    if (screen.lastResult && screen.lastResult !== this.lastResult) this.resultDismissed = false;
    this.lastResult = screen.lastResult;
    this.lastMatchResult = screen.lastMatchResult;
    this.renderAll(screen.notice);
    this.schedulePolling();
  }

  hide(): void {
    this.stopPolling();
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

    this.playerHeading.visible = waiting;
    this.playerList.parent.visible = waiting;
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
    const players = this.snapshot?.players ?? [];
    const me = this.getMe();
    refill(this.playerList, players.length, (index, row) => {
      const player = players[index]!;
      const marks = [player.ready ? "✓已准备" : "未准备", player.connected ? "" : "· 离线"].filter(Boolean).join(" ");
      label(row, `座位${index} · ${player.nickname}${me?.userId === player.userId ? "（我）" : ""}`, 26, { width: 460 }).pos(20, 10);
      label(row, `${player.points} 分 ${marks}`, 22, { width: 560, color: THEME.textDim }).pos(20, 46);
      row.size(600, 84);
      row.bgColor = me?.userId === player.userId ? THEME.panelBg2 : THEME.panelBg;
    });
  }

  private renderWaitingControls(): void {
    const me = this.getMe();
    const mine = this.snapshot?.players.find((player) => player.userId === me?.userId);
    setButtonText(this.readyButton, mine?.ready ? "取消准备" : "准备");
    this.startButton.visible = this.snapshot?.ownerId === me?.userId;
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
      const text = `${playerName(this.snapshot, player.seat)} · ${player.handSize}张${player.won ? " · 已胡" : ""}${melds ? ` · ${melds}` : ""}`;
      const row = box(this.matchArea, 30 + index * 235, 82, 220, 78, player.won ? THEME.accentDark : THEME.panelBg2);
      label(row, text, 20, { width: 200, align: "center", wordWrap: true }).pos(10, 13);
    });
  }

  private renderHand(hand: Tile[], match: MatchState): void {
    const discardable = discardableIndexes(hand, match.missingSuit);
    const canDiscard = actionAvailable(this.actions, "discard") && match.phase === "playing";
    hand.forEach((tile, index) => {
      const selected = this.selectedIndexes.has(index);
      const enabled = (match.phase === "swapping" && actionAvailable(this.actions, "swap")) || (canDiscard && discardable.has(index));
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
    // 新一局已经开始（`this.match` 非空）就收起浮层。
    // 服务端一局结束后会**立刻**开下一局，所以 `lastResult` 在新局里依然有值 ——
    // 只看它会让上一局的结算一直压在新牌局上面（两个浏览器客户端同一处坑）。
    if (!this.lastResult || this.resultDismissed || this.match !== null) {
      this.resultOverlay.visible = false;
      return;
    }
    // 标题分两种：还在一整局里时这是**一小场**的分数（账号积分不动）；
    // 打满 8 小场之后同一个浮层变成整局结算记录（账号积分正是在那一刻入账的）。
    this.resultTitle.text = this.lastMatchResult
      ? `本局结算记录 · 打满 ${this.lastMatchResult.completedRounds} 小场`
      : `${roundLabel(this.lastResult.roundNumber ?? 1, this.lastResult.totalRounds)}结束`;
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
    const result = this.lastResult;
    const players: NonNullable<RoomResult["players"]> = result.players ?? result.deltas.map<NonNullable<RoomResult["players"]>[number]>((entry, seat) => ({ playerId: entry.playerId, seat, won: false, hand: [], melds: [] }));
    const rowsTop = winY + 13;
    players.forEach((player, index) => {
      const delta = result.deltas.find((entry) => entry.playerId === player.playerId)?.delta ?? 0;
      const y = rowsTop + index * 190;
      // 这一行有两个数，别混：`delta` 是本小场，`cumulative` 是整局累计（头像下显示的那个）。
      const cumulative = player.matchDelta;
      const total = cumulative === undefined ? "" : ` · 本场累计 ${fmtDelta(cumulative)}`;
      label(this.resultBody, `${nickOf(player.playerId)}${player.won ? " · 已胡" : ""}  ${delta > 0 ? "赢 " : delta < 0 ? "输 " : ""}${fmtDelta(delta)} 分${total}`, 26, { color: delta >= 0 ? THEME.good : THEME.bad }).pos(0, y);
      const tiles = sortedHand(player.hand);
      tiles.forEach((tile, i) => {
        const image = new Laya.Image();
        image.skin = tileAsset(tile); image.pos(i * 44, y + 40); image.size(40, 60);
        this.resultBody.addChild(image);
      });
      const settled = this.lastMatchResult?.accountDeltas.find((entry) => entry.playerId === player.playerId);
      const balance = this.lastMatchResult?.balances?.find((entry) => entry.playerId === player.playerId)?.balance;
      if (settled) {
        label(this.resultBody, `账号入账：${fmtDelta(settled.delta)}${balance === undefined ? "" : ` · 余额 ${balance}`}`, 20).pos(0, y + 160);
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

  private async toggleReady(): Promise<void> {
    const me = this.getMe();
    const mine = this.snapshot?.players.find((player) => player.userId === me?.userId);
    await this.flow.setReady(!(mine?.ready ?? false));
    void this.poll();
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
