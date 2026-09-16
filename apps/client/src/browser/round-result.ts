import type { RoomResult, RoomSnapshot } from "../protocol.js";
import { element } from "./dom.js";
import { scoreBoard, seatScores } from "./score-board.js";
import { tileChip } from "./tile-chips.js";
import { countdownText, roundReasonText, winSummaryText } from "./result-text.js";

const dismissed = new WeakSet<RoomResult>();

/**
 * 这一小场的分数弹窗被玩家按掉了吗？
 *
 * 打满 8 小场时**两件事连着发生**：最后一小场的分数弹窗，和整局的结算记录。
 * 调用方要先问这里，才知道该显示哪一个（见 `/multi` 与 `/debug` 的渲染层）。
 */
export function isRoundResultDismissed(result: RoomResult): boolean {
  return dismissed.has(result);
}

/**
 * 一小场结束的弹窗。
 *
 * 它显示的是**这一小场**四家的分数变化（顶上一排大数字）与本小场亮出的四家牌面；
 * 与「整局结算记录」（`match-result.ts`）是两件事：
 *   * 这里不入账，账号积分不动 —— 打的过程中一直是开局前那个值；
 *   * 账号积分只在整局打满 8 小场、出结算记录时才改。
 *
 * `nextRoundAt` 是**下一小场开始的本地时刻**（没有停留时为 null）—— 传进来是为了显示
 * 「N 秒后开始下一小场」：局间停 5 秒，不给提示的话玩家只是看着一个不动的界面在等。
 *
 * `onDismiss` 在玩家按下「继续」时回调。渲染层必须用它**重画一次** ——
 * 打满 8 小场那种情况下，按掉这个弹窗之后要接着显示整局结算记录，
 * 而那一刻服务端已经不再发任何帧，没有这个回调就没人去重画（那会让结算记录永远不出现）。
 */
export function roundResultPanel(
  result: RoomResult,
  snapshot: RoomSnapshot | null,
  nextRoundAt: number | null = null,
  onDismiss?: () => void,
): HTMLElement {
  const panel = element("section", { className: "panel" });
  const roundNo = result.roundNumber;
  const totalRounds = result.totalRounds;
  const where = roundNo === undefined ? "本小场" : `第 ${roundNo}/${totalRounds ?? 8} 小场`;
  const lastOne = roundNo !== undefined && totalRounds !== undefined && roundNo >= totalRounds;
  if (!dismissed.has(result)) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", `${where}结束`);
    panel.style.cssText = "position:fixed;inset:4vh 3vw;z-index:1000;overflow:auto;background:#17392f;color:#fff;padding:20px;border:2px solid #d5bb78;border-radius:16px;box-shadow:0 0 0 10vmax #0009";
    // 最后一小场按下去接的是整局结算记录，所以按钮说的是下一步是什么，不是笼统的「继续」。
    const close = element("button", { text: lastOne ? "看本局结算" : "继续" });
    close.onclick = () => {
      dismissed.add(result);
      panel.removeAttribute("style");
      panel.removeAttribute("role");
      close.remove();
      onDismiss?.();
    };
    panel.append(close);
  }
  panel.append(element("h2", { text: `${where}结束 · ${roundReasonText(result.reason)}` }));

  // 四家的分数变化摆在最前面：这是玩家第一眼要找的东西。
  panel.append(scoreBoard(seatScores({ result }, snapshot), { primary: "round", showAccount: false }));

  // 倒计时。只用一个 timer 改这一个节点的文本（不触发整页重渲染）；
  // 渲染层会整体重建 DOM，旧节点被换掉后 `isConnected` 变 false，timer 自己停掉。
  const initial = countdownText(nextRoundAt, Date.now());
  if (initial !== null) {
    const line = element("p", { className: "countdown", text: initial });
    const timer = setInterval(() => {
      if (!line.isConnected) { clearInterval(timer); return; }
      line.textContent = countdownText(nextRoundAt, Date.now()) ?? "";
    }, 250);
    panel.append(line);
  }

  // 胡了什么牌型、谁给的牌 —— 放在牌面之前：玩家第一眼要找的是这个，
  // 而四家的牌面是拿来对照的细节。流局时这一段为空，整块不显示。
  for (const win of result.wins ?? []) {
    const name = snapshot?.players[win.seat]?.nickname ?? `${win.seat} 号位`;
    panel.append(element("p", {
      className: "win-summary",
      text: `${win.seat} 号位（${name}）　${winSummaryText(win, snapshot)}`,
    }));
  }

  const players = result.players ?? result.deltas.map((entry, seat) => ({ playerId: entry.playerId, seat, won: result.winnerSeats.includes(seat), hand: [], melds: [] }));
  for (const player of players) {
    const delta = result.deltas.find((entry) => entry.playerId === player.playerId)?.delta ?? 0;
    const name = snapshot?.players.find((entry) => entry.userId === player.playerId)?.nickname ?? `玩家${player.seat + 1}`;
    const row = element("div", { className: "result-player" });
    // 赢家这一行直接写明「怎么胡的」—— 上面那排是给四家横向对比看的，
    // 这里是给「这一家的牌是怎么成的」看的，两处都写才不用来回对号。
    const win = (result.wins ?? []).find((entry) => entry.seat === player.seat);
    const how = win ? ` · ${winSummaryText(win, snapshot)}` : "";
    row.append(element("p", { text: `${name}${player.won ? " · 已胡" : " · 未胡"}　${delta > 0 ? "赢 +" : delta < 0 ? "输 " : ""}${delta} 分${how}` }));
    const hand = element("div", { className: "melds" });
    for (const tile of [...player.hand].sort((a, b) => a - b)) hand.append(tileChip(tile));
    row.append(hand);
    for (const meld of player.melds) {
      const group = element("div", { className: "meld-group" });
      group.append(element("span", { text: meld.kind === "pong" ? "碰" : meld.concealed ? "暗杠" : "杠" }));
      for (let i = 0; i < (meld.kind === "kong" ? 4 : 3); i++) group.append(tileChip(meld.tile));
      row.append(group);
    }
    panel.append(row);
  }
  return panel;
}
