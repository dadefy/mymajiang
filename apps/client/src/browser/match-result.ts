import type { MatchResult, RoomResult, RoomSnapshot } from "../protocol.js";
import { element } from "./dom.js";
import { scoreBoard, seatScores } from "./score-board.js";
import { matchResultText, winLines } from "./result-text.js";

const dismissed = new WeakSet<MatchResult>();

/** 整局结算记录被玩家收起了吗？渲染层据此决定还要不要压着浮层。 */
export function isMatchResultDismissed(result: MatchResult): boolean {
  return dismissed.has(result);
}

/**
 * 整局（8 小场）结算记录。**只有一整局打完才出**。
 *
 * 与「一小场的分数弹窗」（`round-result.ts`）的分工：
 *   * 每小场结束弹的是那**一小场**四家的分数变化，不开账号、不算账；
 *   * 一整局打满 8 小场（或中途解散）之后才出**这张记录**，而账号积分正是在这一刻改的
 *     —— 服务端在 `recordCompletedRound` 走到最后一小场时 `finalize()`：
 *     先按封顶与「积分不为负」处理出 `accountDeltas`，写进账号，再发出 `match-finished`。
 *
 * 所以这一屏要回答三件事，缺一样玩家就会怀疑分到底进没进账号：
 *   ① 这一整局各家净赢多少（本场累计）；
 *   ② 最后一小场各家多少（本小场）—— 与前面每小场弹窗的口径一致；
 *   ③ 实际入账多少、入账之后账号是多少。
 *
 * `round` 是最后一小场的结算（可能没有，比如中途解散时）；有它才能显示 ③ 与本小场的数。
 * `onDismiss` 让渲染层在收起浮层后重画一次 —— 收起之后正文还在页面上（见下面的注释）。
 */
export function matchResultPanel(
  result: MatchResult,
  snapshot: RoomSnapshot | null,
  round: RoomResult | null = null,
  onDismiss?: () => void,
): HTMLElement {
  const panel = element("section", { className: "panel" });
  const reason = result.reason === "dissolved"
    ? `中途解散 · 已打 ${result.completedRounds} 小场`
    : `打满 ${result.completedRounds} 小场`;
  if (!dismissed.has(result)) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "本局结算记录");
    panel.style.cssText = "position:fixed;inset:4vh 3vw;z-index:1001;overflow:auto;background:#17392f;color:#fff;padding:20px;border:2px solid #d5bb78;border-radius:16px;box-shadow:0 0 0 10vmax #0009";
    const close = element("button", { text: "知道了" });
    close.onclick = () => {
      dismissed.add(result);
      // 收起浮层但**不删正文**：这是整局的最终账，玩家多半还要再看两眼
      // （谁赢了多少、账号变成多少）。收起的只是遮罩与居中那套样式。
      panel.removeAttribute("style");
      panel.removeAttribute("role");
      close.remove();
      onDismiss?.();
    };
    panel.append(close);
  }
  panel.append(element("h2", { text: `本局结算记录 · ${reason}` }));

  const scores = seatScores({ result: round, matchResult: result }, snapshot);
  panel.append(scoreBoard(scores, { primary: "match", showAccount: true }));

  // 入账这件事必须明说。数字排在上面，但那几个数是不是已经进账号了，
  // 玩家从数字上看不出来 —— 而「打的过程中不动账号、只在整局结算时改」正是这一局的规则。
  panel.append(element("p", {
    className: "account-note",
    text: "账号积分已在上面这一刻结算入账（「账号」那一列就是入账后的余额）；打的过程中不动账号。",
  }));

  // 权威摘要：带上封顶/负分保护造成的「实际结算分」差异（见 matchResultText）。
  panel.append(element("p", { className: "hint", text: matchResultText(result, snapshot) }));

  // 最后一小场怎么胡的也留一份：小场弹窗是可以按掉的，按掉之后这一屏就是唯一的落点。
  if (round) {
    for (const line of winLines(round, snapshot)) {
      panel.append(element("p", { className: "hint", text: `最后一小场　${line}` }));
    }
  }
  return panel;
}
