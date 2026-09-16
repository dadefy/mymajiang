import type { MatchResult, MatchResultPlayer, RoomResult, RoomSnapshot } from "../protocol.js";
import { element } from "./dom.js";
import { scoreBoard, scoreColor, seatScores } from "./score-board.js";
import { matchResultText, matchTimeText, signed, winLines } from "./result-text.js";

const dismissed = new WeakSet<MatchResult>();

/** 整局结算记录被玩家收起了吗？渲染层据此决定还要不要压着浮层。 */
export function isMatchResultDismissed(result: MatchResult): boolean {
  return dismissed.has(result);
}

/** 一行的第二行小字：入账分（只在触发封顶/负分保护时写）+ 入账后的账号余额。 */
function accountLine(player: MatchResultPlayer): string {
  const capped = player.accountDelta !== player.delta ? `入账 ${signed(player.accountDelta)} · ` : "";
  return `${capped}账号 ${player.balance} 分`;
}

/**
 * 一位玩家一行：**头像 + 昵称 + 10 位 id 号 + 本局积分变化**。
 *
 * 这是「哪一行是谁」的落点：上面那排四列分数只带座位号，
 * 玩家要核对「我这局赢了多少、分进账号没有」时得先找到自己那一行。
 * 昵称、座位号、id 号三样都写 —— 昵称可能重名，id 号不会。
 *
 * 样式内联，理由同 `score-board`：`/multi` 与 `/debug` 各有一套样式表，
 * 靠外部 class 会在 `/debug` 上退化成没边框、字号不分的裸文本。
 */
function matchPlayerRow(player: MatchResultPlayer): HTMLElement {
  const row = element("div");
  row.className = "match-player-row";
  row.style.cssText = "display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:10px;"
    + "align-items:center;padding:8px 10px;border-radius:10px;background:#0d2b22;"
    + "border:1px solid #b7a26b55;margin-bottom:6px";

  const avatar = element("div", { text: player.nickname.slice(0, 1) || "人" });
  avatar.className = "match-player-avatar";
  avatar.style.cssText = "position:relative;width:42px;height:42px;border-radius:8px;"
    + "background:linear-gradient(145deg,#b5b8b5,#787f7b);display:flex;align-items:center;"
    + "justify-content:center;font-size:18px;color:#fff;overflow:hidden";
  avatar.setAttribute("aria-label", `${player.nickname}的头像`);
  if (player.avatarUrl) {
    const image = element("img");
    image.alt = player.nickname;
    image.src = player.avatarUrl;
    // 头像 URL 是玩家自己填的，取不到就退回昵称首字，绝不留一个破图标。
    image.referrerPolicy = "no-referrer";
    image.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
    image.addEventListener("error", () => image.remove(), { once: true });
    avatar.append(image);
  }

  const info = element("div");
  info.style.cssText = "min-width:0";
  const name = element("div", { text: player.nickname });
  name.className = "match-player-name";
  name.style.cssText = "font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  const identity = element("div", { text: `${player.seat} 号位 · ID ${player.playerId}` });
  identity.className = "match-player-id";
  identity.style.cssText = "font-size:12px;color:#b9c9bd;font-variant-numeric:tabular-nums";
  info.append(name, identity);

  const numbers = element("div");
  numbers.style.cssText = "text-align:right";
  const delta = element("div", { text: signed(player.delta) });
  delta.className = "match-player-delta";
  delta.style.cssText = "font-size:24px;font-weight:800;line-height:1.15;"
    + `font-variant-numeric:tabular-nums;color:${scoreColor(player.delta)}`;
  delta.setAttribute("aria-label", `${player.nickname} 本局积分变化 ${signed(player.delta)} 分`);
  const account = element("div", { text: accountLine(player) });
  account.className = "match-player-account";
  account.style.cssText = "font-size:12px;color:#e7cf98;font-variant-numeric:tabular-nums";
  numbers.append(delta, account);

  row.append(avatar, info, numbers);
  return row;
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
 * 所以这一屏要回答四件事，缺一样玩家就会怀疑分到底进没进账号：
 *   ① 这一整局什么时候开始打的、打了多久（`startedAt` / `finishedAt` 两个时间戳）；
 *   ② 各家净赢多少（四列分数板，一眼看输赢）；
 *   ③ 每一行是谁 —— 头像、昵称、10 位 id 号，以及本局积分变化；
 *   ④ 实际入账多少、入账之后账号是多少。
 *
 * `round` 是最后一小场的结算（可能没有，比如中途解散时）；有它才能显示 ④ 与本小场的数。
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

  // 开始时间与耗时。玩家对账时第一个要看的就是它（「我们这局打了一个多小时」），
  // 服务端没下发时间戳时整行不显示 —— 写「开始 —」不如不写。
  const time = matchTimeText(result.startedAt, result.finishedAt);
  if (time !== null) panel.append(element("p", { className: "match-time", text: time }));

  const scores = seatScores({ result: round, matchResult: result }, snapshot);
  panel.append(scoreBoard(scores, { primary: "match", showAccount: true }));

  // 四行明细，顺序由服务端定（按座位）。缺 `players` 时整块不显示 ——
  // 那样至少上面那排分数还在，不至于整屏空白。
  if (result.players && result.players.length > 0) {
    panel.append(element("h3", { className: "match-rows-title", text: "每位玩家" }));
    for (const player of result.players) panel.append(matchPlayerRow(player));
  }

  // 入账这件事必须明说。数字排在上面，但那几个数是不是已经进账号了，
  // 玩家从数字上看不出来 —— 而「打的过程中不动账号、只在整局结算时改」正是这一局的规则。
  panel.append(element("p", {
    className: "account-note",
    text: "账号积分已在上面这一刻结算入账（每行「账号」就是入账后的余额）；打的过程中不动账号。",
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
