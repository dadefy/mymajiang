import type { ClientFlow, Screen } from "../flow.js";
import { button, element } from "./dom.js";
import { DiscardSelection } from "./discard-selection.js";
import { SwapSelection } from "./swap-selection.js";
import { actionButtons, runAction } from "./action-buttons.js";
import { playerProfile } from "./player-profile.js";
import { installTableLayout } from "./table-layout.js";
import { meldBox, tileChip } from "./tile-chips.js";
import { nicknameOf, sortedHand } from "./table-order.js";
import { SUITS, SUIT_LABEL, tileLabel } from "./tile-label.js";
import { roundLabel } from "./result-text.js";

const positions = ["bottom", "right", "top", "left"] as const;
export const relativePosition = (seat: number, viewer: number): string => positions[(seat - viewer + 4) % 4]!;

/** One renderer per login page; selection state never belongs to another account. */
export class SingleTable {
  private swap = new SwapSelection();
  private discard = new DiscardSelection();
  private timer: ReturnType<typeof setInterval> | undefined;

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  render(screen: Extract<Screen, { name: "room" }>, flow: ClientFlow, repaint: () => void): HTMLElement {
    this.dispose();
    installTableLayout();
    const board = element("section"); board.id = "board";
    const match = screen.match;
    if (!match) return board;
    const actions = screen.roundFinished ? [] : screen.actions;
    this.swap.sync(match, actions, screen.notice);
    this.discard.sync(match, actions, screen.notice);
    const grid = element("div", { className: "discard-grid" });
    for (const player of match.players) {
      const mine = player.seat === match.seat;
      const position = relativePosition(player.seat, match.seat);
      const seat = element("div", { className: `seat ${position}${player.won ? " won" : ""}` });
      seat.dataset.seat = String(player.seat);
      const card = element("div", { className: "seat-card" });
      const settled = screen.roundFinished ? screen.lastResult?.players?.find(p => p.seat === player.seat) : undefined;
      card.append(playerProfile({
        nickname: nicknameOf(screen.snapshot, player.seat),
        ...(player.avatarUrl ? { avatarUrl: player.avatarUrl } : {}),
        matchDelta: settled?.matchDelta ?? player.matchDelta,
        dealer: match.dealerSeat === player.seat,
        missingSuit: player.missingSuit,
      }));
      const hand = element("div", { className: "hand" });
      hand.setAttribute("aria-label", mine ? "我的手牌" : `${nicknameOf(screen.snapshot, player.seat)}的手牌，${player.handSize}张`);
      if (mine) {
        sortedHand(match.hand).forEach((tile, index) => {
          const chosen = match.phase === "swapping" ? this.swap.has(index) : this.discard.index === index;
          const node = button(tileLabel(tile), () => {
            if (match.phase === "swapping") this.swap.toggle(index);
            else {
              const value = this.discard.click(match, index);
              if (value !== undefined) flow.discard(value);
            }
            repaint();
          }, `tile${chosen ? " chosen" : ""}`);
          node.disabled = match.phase === "swapping" ? !this.swap.enabled : !this.discard.canSelect(match, tile);
          hand.append(node);
        });
        const ops = element("div", { className: "ops row" });
        if (match.phase === "swapping" && this.swap.enabled) {
          const submit = button(`换这三张（${this.swap.length}/3）`, () => {
            const tiles = this.swap.tiles(sortedHand(match.hand));
            this.swap.submit(() => flow.swap(tiles)); repaint();
          }, "primary");
          submit.disabled = !this.swap.valid(sortedHand(match.hand));
          ops.append(submit, button("自动换三张", () => { this.swap.submit(() => flow.autoSwap()); repaint(); }));
        }
        if (match.phase === "missing" && actions.includes("choose-missing")) {
          for (const suit of SUITS) ops.append(button(`定缺${SUIT_LABEL[suit]}`, () => flow.chooseMissing(suit)));
        }
        for (const spec of actionButtons(actions, match.phase)) {
          ops.append(button(spec.label, () => runAction(flow, spec.kind), spec.primary ? "primary" : ""));
        }
        if (ops.childElementCount) card.append(ops);
      } else {
        for (let i = 0; i < player.handSize; i++) {
          const back = button("", () => {}, "tile card-back"); back.disabled = true;
          back.setAttribute("aria-label", "牌背"); hand.append(back);
        }
      }
      card.append(hand, element("div", { className: "tiles-area" }, meldBox(mine ? match.melds : player.melds)));
      seat.append(card); board.append(seat);
      const tiles = element("div", { className: "discard-tiles" });
      for (const tile of player.discards) tiles.append(tileChip(tile));
      const cell = element("div", { className: `discard-cell ${position}` }, tiles);
      cell.setAttribute("aria-label", `${nicknameOf(screen.snapshot, player.seat)}的弃牌`); grid.append(cell);
    }
    const center = element("div", { className: "center" }); center.id = "center";
    const phase = {swapping:"换三张",missing:"定缺",playing:"行牌",claiming:"等待碰杠胡",finished:"本小场结束"}[match.phase];
    const status = screen.roundFinished ? "本小场结束" : match.phase === "playing"
      ? (match.currentPlayerSeat === match.seat ? "轮到你出牌 · 点同一张牌两次确认" : `等待${nicknameOf(screen.snapshot, match.currentPlayerSeat ?? 0)}出牌`)
      : phase;
    center.append(element("div", { className: "banner", text: `${roundLabel(match.roundNumber, match.totalRounds)} · ${status}` }), grid);
    const hub = element("div", { className: "table-hub" });
    ["东", "南", "西", "北"].forEach((wind, seat) => {
      const active = !screen.roundFinished && (match.phase === "playing" ? match.currentPlayerSeat === seat : seat === match.seat && actions.length > 0);
      hub.append(element("span", {className:`wind ${relativePosition(seat, match.seat)}${active ? " active" : ""}`,text:wind}));
    });
    const clock = element("span", {className:"turn-clock",text:"—"}); clock.setAttribute("aria-label", "当前操作剩余秒数");
    if (!screen.roundFinished && match.actionDeadlineAt) {
      const update = (): void => {
        const seconds = Math.max(0, Math.ceil((match.actionDeadlineAt! - Date.now()) / 1000));
        clock.textContent = String(seconds); clock.classList.toggle("urgent", seconds <= 3);
      };
      update(); this.timer = setInterval(update, 200);
    }
    hub.append(clock);
    center.append(hub, element("div", {className:"wall-counter"}, element("span", {text:"余牌"}), element("strong", {text:String(match.tilesLeft)})));
    board.append(center);
    return board;
  }
}
