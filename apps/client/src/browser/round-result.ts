import type { RoomResult, RoomSnapshot } from "../protocol.js";
import { element } from "./dom.js";
import { scoreColor, seatScores } from "./score-board.js";
import { countdownText, roundLabel } from "./result-text.js";

/**
 * 一小场结束：**直接在牌桌上弹一下四家的积分变化**，然后自动开下一小场。
 *
 * 与「整局结算记录」（`match-result.ts`）是两件事，差别在这一屏的取舍：
 *   * 只在牌桌上弹 3 秒（时长由服务端下发，见 `RealtimeOptions.interRoundPauseMs`），
 *     所以**不弹面板、不压遮罩** —— 牌桌一直看得见，玩家不用按任何按钮；
 *   * 只报四个数字，**不展示牌型、不亮四家牌面、不写胡牌明细** ——
 *     那 3 秒里玩家只想知道「这一小场我赢输多少」，别的按玩法都不在这屏出现；
 *   * 账号积分不动（只在整局结算那一刻改）。
 *
 * 之所以不自己定 3 秒：停留时长是服务端的配置（测试里是 0，不等待）。
 * `hideAt` 就是服务端给的停留截止时刻；
 * 到点后调 `onExpire` 让渲染层重画一次 —— 打满 8 小场时那一刻要接着显示整局结算记录，
 * 而服务端在那之后**已经不再发任何帧**，没有这个回调就没人重画，结算记录永远不出现。
 */
export function roundScorePop(
  result: RoomResult,
  snapshot: RoomSnapshot | null,
  hideAt: number | null = null,
  onExpire?: () => void,
): HTMLElement {
  const pop = element("div");
  pop.className = "round-pop";
  // 绝对定位、居中、**没有遮罩**：它落在牌桌正中那片空白上（`#center` 在 `#board` 里），
  // 而不是盖住整个屏幕。样式内联是因为 `/debug` 那份页面没装牌桌样式表。
  pop.style.cssText = "position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);"
    + "z-index:6;width:min(78%,720px);padding:10px 14px 8px;box-sizing:border-box;"
    + "background:#0d2b22f2;border:2px solid #d5bb78;border-radius:14px;"
    + "box-shadow:0 10px 26px #0007;text-align:center";
  pop.setAttribute("role", "status");
  pop.setAttribute("aria-live", "polite");
  pop.setAttribute("aria-label", "本小场各家积分变化");

  pop.append(element("div", {
    className: "round-pop-title",
    text: roundLabel(result.roundNumber ?? 1, result.totalRounds),
  }));

  const row = element("div");
  row.className = "round-pop-scores";
  row.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:6px";
  for (const score of seatScores({ result }, snapshot)) {
    const cell = element("div");
    cell.className = "score-cell";
    cell.style.cssText = "min-width:0";
    const name = element("div", { className: "score-name", text: `${score.seat} 号位 ${score.name}` });
    name.style.cssText = "font-size:clamp(11px,1.1vw,15px);color:#b9c9bd;white-space:nowrap;"
      + "overflow:hidden;text-overflow:ellipsis";
    // 数字要醒目：这一屏只有这四组数字，3 秒里要一眼看完。
    const value = element("div", { className: "score-value", text: `${score.delta !== undefined && score.delta > 0 ? "+" : ""}${score.delta ?? 0}` });
    value.style.cssText = "font-size:clamp(26px,3.2vw,52px);font-weight:800;line-height:1.15;"
      + `font-variant-numeric:tabular-nums;color:${scoreColor(score.delta ?? 0)}`;
    value.setAttribute("aria-label", `${score.name} 本小场 ${score.delta ?? 0} 分`);
    cell.append(name, value);
    row.append(cell);
  }
  pop.append(row);

  // 倒计时那一行。不停留（或老服务端不下发时长）时 `countdownText` 返回 null，整行不显示。
  const initial = countdownText(hideAt, Date.now());
  if (initial !== null && hideAt !== null) {
    const line = element("p", { className: "countdown", text: initial });
    line.style.cssText = "margin:6px 0 0;font-size:clamp(11px,1vw,14px);color:#e7cf98";
    pop.append(line);

    // 到点通知渲染层重画（要交接给整局结算记录，见上面说明）。
    const expire = setTimeout(() => {
      if (line.isConnected) onExpire?.();
    }, Math.max(0, hideAt - Date.now()) + 30);
    // 只用一个 timer 改这一个节点的文本（不触发整页重渲染）；
    // 渲染层会整体重建 DOM，旧节点被换掉后 `isConnected` 变 false，两个定时器都自己停掉。
    const tick = setInterval(() => {
      if (!line.isConnected) {
        clearInterval(tick);
        clearTimeout(expire);
        return;
      }
      line.textContent = countdownText(hideAt, Date.now()) ?? "";
    }, 250);
  }
  return pop;
}
