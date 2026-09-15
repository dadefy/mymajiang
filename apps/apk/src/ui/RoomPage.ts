import type { ApiClient, ClientFlow, MatchState, RoomResult, RoomSnapshot, Screen, Suit } from "@mianyang-mahjong/client";
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

/** 0..3 号位玩家的名字；RoomPlayerView 不带座位，按加入顺序与座位一一对应。 */
function playerName(snapshot: RoomSnapshot | null, seat: number): string {
  const player = snapshot?.players[seat];
  return player ? player.nickname : `玩家${seat}`;
}

/**
 * 房间页：等待房间里的人与准备状态、开局后的脱敏牌局快照、单局结算。
 *
 * A1 阶段只做展示与房间生命周期（准备/开局/退出），换三张、定缺、出牌等
 * 牌桌交互归 D1。等待期的成员变化由轮询刷新 —— 页面流目前只在进房时拉一次快照。
 */
export class RoomPage {
  readonly view: Laya.Box;
  private readonly statusLabel: Laya.Label;
  private readonly exitButton: Laya.Box;
  private readonly noticeLabel: Laya.Label;
  private readonly playerList: Laya.VBox;
  private readonly waitingControls: Laya.Box;
  private readonly readyButton: Laya.Box;
  private readonly startButton: Laya.Box;
  private readonly matchArea: Laya.Box;
  private readonly resultOverlay: Laya.Box;
  private readonly resultTitle: Laya.Label;
  private readonly resultBody: Laya.Box;
  private roomId = "";
  private snapshot: RoomSnapshot | null = null;
  private match: MatchState | null = null;
  private actions: string[] = [];
  private lastResult: RoomResult | null = null;
  private resultDismissed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly flow: ClientFlow,
    private readonly api: ApiClient,
    parent: Laya.Stage,
    private readonly getMe: () => { userId: string } | undefined,
  ) {
    this.view = new Laya.Box();
    this.view.size(750, 1334);
    parent.addChild(this.view);

    // 顶栏：房间号 + 状态 + 退出
    const header = box(this.view, 0, 0, 750, 100, THEME.panelBg);
    this.statusLabel = label(header, "", 30, { bold: true });
    this.statusLabel.pos(30, 34);
    this.exitButton = textButton(header, "退出", 610, 20, 110, 60, THEME.panelBg2, () => void this.flow.leaveRoom());

    this.noticeLabel = label(this.view, "", 24, { width: 690, align: "center", color: THEME.warn, wordWrap: true });
    this.noticeLabel.pos(30, 115);
    this.noticeLabel.visible = false;

    // 成员列表
    label(this.view, "玩家", 28, { bold: true }).pos(75, 175);
    this.playerList = scrollList(this.view, 75, 220, 600, 300);

    // 等待期操作：准备 / 开局
    this.waitingControls = box(this.view, 0, 560, 750, 110);
    this.readyButton = textButton(this.waitingControls, "准备", 75, 0, 220, 88, THEME.accentDark, () => void this.toggleReady());
    this.startButton = textButton(this.waitingControls, "开始对局", 345, 0, 220, 88, THEME.accentDark, () => void this.flow.startMatch());

    // 牌局展示（开局后填充）。高度吃满剩余屏幕，行距按最长手牌换三行预留。
    this.matchArea = box(this.view, 0, 560, 750, 770);

    // 结算浮层
    this.resultOverlay = box(this.view, 75, 380, 600, 560, THEME.panelBg2);
    this.resultTitle = label(this.resultOverlay, "", 34, { width: 600, align: "center", bold: true, color: THEME.accent });
    this.resultTitle.pos(0, 30);
    this.resultBody = box(this.resultOverlay, 40, 110, 520, 330);
    textButton(this.resultOverlay, "继续", 175, 470, 250, 70, THEME.accentDark, () => {
      this.resultDismissed = true;
      this.resultOverlay.visible = false;
    });
    this.resultOverlay.visible = false;
  }

  show(screen: Screen): void {
    if (screen.name !== "room") return;
    if (this.roomId !== screen.roomId) {
      // 换了一个房间：丢弃上一间的本地状态。
      this.roomId = screen.roomId;
      this.snapshot = screen.snapshot;
      this.match = null;
      this.lastResult = null;
      this.resultDismissed = false;
    } else if (!this.snapshot && screen.snapshot) {
      this.snapshot = screen.snapshot;
    }
    this.match = screen.match;
    this.actions = screen.actions;
    if (screen.lastResult && screen.lastResult !== this.lastResult) this.resultDismissed = false;
    this.lastResult = screen.lastResult;
    this.renderAll(screen.notice);
    this.schedulePolling();
  }

  hide(): void {
    this.stopPolling();
  }

  // ---------- 展示 ----------

  private renderAll(notice?: string): void {
    this.noticeLabel.visible = notice !== undefined;
    this.noticeLabel.text = notice ?? "";
    const waiting = this.snapshot?.status === "waiting" && this.match === null;
    this.statusLabel.text = `房间 ${this.roomId} · ${this.match ? STATUS_NAMES.playing : this.snapshot ? STATUS_NAMES[this.snapshot.status] : "连接中"}`;
    // 正在打的牌局没有出口（血战到底，中途退出由解散投票负责，见 D1）；
    // 等待期与整场结束后都可以离开。整场结束后快照要靠轮询刷新成 finished 才会亮出按钮。
    const inProgress = this.match !== null || this.snapshot?.status === "playing";
    this.exitButton.visible = !inProgress;

    this.renderPlayers();
    this.waitingControls.visible = waiting;
    this.matchArea.visible = this.match !== null;
    if (waiting) this.renderWaitingControls();
    if (this.match) this.renderMatch(this.match);
    this.renderResult();
  }

  private renderPlayers(): void {
    const players = this.snapshot?.players ?? [];
    const me = this.getMe();
    refill(this.playerList, players.length, (index, row) => {
      const player = players[index]!;
      const marks = [
        player.ready ? "✓已准备" : "未准备",
        player.connected ? "" : "· 离线",
      ].filter(Boolean).join(" ");
      const title = label(row, `座位${index} · ${player.nickname}${me?.userId === player.userId ? "（我）" : ""}`, 26, { width: 460 });
      title.pos(20, 10);
      const detail = label(row, `${player.points} 分 ${marks}`, 22, { width: 560, color: THEME.textDim });
      detail.pos(20, 46);
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
    const seatName = match.currentPlayerSeat === null ? "—" : `座位${match.currentPlayerSeat} ${playerName(this.snapshot, match.currentPlayerSeat)}`;
    const info = label(
      this.matchArea,
      `第 ${match.roundNumber} 局 · ${PHASE_NAMES[match.phase]} · 剩 ${match.tilesLeft} 张 · 行动: ${seatName}${match.won ? " · 我已胡" : ""}`,
      24,
      { width: 690, color: THEME.warn, wordWrap: true },
    );
    info.pos(30, 0);

    const missing = match.missingSuit ? `我的定缺: ${SUIT_NAMES[match.missingSuit]}` : "我的定缺: 待定";
    label(this.matchArea, missing, 24, { width: 690, color: THEME.textDim }).pos(30, 80);

    label(this.matchArea, "我的手牌", 26, { bold: true }).pos(75, 125);
    const hand = label(this.matchArea, tileRun(match.hand), 30, { width: 620, color: THEME.accent, wordWrap: true });
    hand.pos(75, 160);

    const melds = match.melds.map((meld) => `${meld.kind === "pong" ? "碰" : meld.concealed ? "暗杠" : "杠"} ${tileName(meld.tile)}`).join("  ");
    label(this.matchArea, `副露: ${melds || "无"}`, 24, { width: 690 }).pos(75, 305);

    label(this.matchArea, "我的弃牌", 24, { width: 690, color: THEME.textDim }).pos(75, 350);
    const discards = label(this.matchArea, tileRun(match.discards), 24, { width: 620, wordWrap: true });
    discards.pos(75, 385);

    // 其他三家：手牌数与弃牌（快照里没有他们的昵称，用座位与快照玩家对上）
    for (let seat = 0; seat < 4; seat += 1) {
      if (seat === match.seat) continue;
      const other = match.players.find((player) => player.seat === seat);
      if (!other) continue;
      const row = label(
        this.matchArea,
        `座位${seat} ${playerName(this.snapshot, seat)}: ${other.handSize} 张${other.won ? " · 已胡" : ""}  弃牌 ${tileRun(other.discards)}`,
        22,
        { width: 620, wordWrap: true, color: THEME.textDim },
      );
      row.pos(75, 460 + (seat > match.seat ? seat - 1 : seat) * 75);
    }

    if (this.actions.length > 0) {
      label(this.matchArea, `当前可执行: ${this.actions.join(" / ")}（牌桌交互在后续版本提供）`, 22, {
        width: 690,
        color: THEME.textDim,
        wordWrap: true,
      }).pos(30, 700);
    }
  }

  private renderResult(): void {
    if (!this.lastResult || this.resultDismissed) {
      this.resultOverlay.visible = false;
      return;
    }
    this.resultTitle.text = this.match ? "本局结算" : "整场结算";
    this.resultBody.removeChildren();
    if (this.lastResult.winnerSeats.length > 0) {
      label(this.resultBody, `胡牌: ${this.lastResult.winnerSeats.map((seat) => `座位${seat}`).join("、")}`, 26).pos(0, 0);
    } else {
      label(this.resultBody, "流局", 26).pos(0, 0);
    }
    const nickOf = (userId: string): string => this.snapshot?.players.find((player) => player.userId === userId)?.nickname ?? userId;
    this.lastResult.deltas.forEach((entry, index) => {
      const delta = label(this.resultBody, `${nickOf(entry.playerId)}  ${fmtDelta(entry.delta)}`, 28, {
        color: entry.delta >= 0 ? THEME.good : THEME.bad,
      });
      delta.pos(0, 50 + index * 55);
    });
    this.resultOverlay.visible = true;
  }

  // ---------- 动作与轮询 ----------

  private async toggleReady(): Promise<void> {
    const me = this.getMe();
    const mine = this.snapshot?.players.find((player) => player.userId === me?.userId);
    await this.flow.setReady(!(mine?.ready ?? false));
    void this.poll();
  }

  /**
   * 等待期轮询房间快照：页面流只在进房时拉一次快照，之后成员加入、准备、
   * 离开都不会推全量状态（socket 只有 status/playerCount），所以这里定时重拉。
   */
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
    // 三种情况需要重拉：还没拿到过快照（进房时拉取失败）；等待期成员/准备状态在变；
    // 整场刚结束时快照还停在 playing。
    const needsRefresh = !this.snapshot || status === "waiting" || (status === "playing" && this.match === null);
    if (!needsRefresh) return;
    const fetched = await this.api.room(this.roomId);
    if (!fetched.ok) return; // 单次失败不打断，下个周期再试
    this.snapshot = fetched.value;
    this.renderAll();
  }
}
