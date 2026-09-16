import type { MatchResult, RoomResult, RoomSnapshot } from "../protocol.js";
import { element } from "./dom.js";
import { signed } from "./result-text.js";

/**
 * 结算界面「四家分数」那一排的取数与渲染。
 *
 * 单独成模块有两个原因：
 *   * 小场弹窗与整局结算记录**都要这一排**（一个显示本小场变化，一个还要带账号入账），
 *     两处各写一遍必然走样；
 *   * 取数（`seatScores`）是纯函数，能单独断言「哪一家的分数对到哪个座位」——
 *     这正是最容易错的地方（服务端给的是 playerId，界面要按座位排）。
 */

/** 排在一排里的一位玩家。 */
export interface SeatScore {
  playerId: string;
  /** 座位号，0..3。四家的先后按它排。 */
  seat: number;
  name: string;
  /** **本小场**的分数变化（换一小场归零）。服务端没给这一小场的结算时为 undefined。 */
  delta: number | undefined;
  /** **整局累计**净输赢；服务端没下发时为 undefined。 */
  matchDelta: number | undefined;
  /** 实际写入账号的分（只有整局结算有；与 `matchDelta` 不同说明触发了封顶）。 */
  accountDelta: number | undefined;
  /** 入账之后的账号余额（只有整局结算有）。 */
  balance: number | undefined;
}

/** 赢红输绿：按国内习惯（涨红跌绿那一套）。 */
export function scoreColor(value: number): string {
  if (value > 0) return "#ff6f61";
  if (value < 0) return "#6fe0a8";
  return "#c5d7cd";
}

function signedOr(value: number | undefined): string {
  return value === undefined ? "—" : signed(value);
}

function byPlayerId(entries: ReadonlyArray<{ playerId: string; delta: number }> | undefined): Map<string, number> {
  return new Map((entries ?? []).map((entry) => [entry.playerId, entry.delta]));
}

/** 一行小字：左标题 + 染色数字。 */
function line(className: string, text: string, color: string, size = "12px"): HTMLElement {
  const node = element("div", { className, text });
  node.style.cssText = `font-size:${size};color:${color};font-variant-numeric:tabular-nums`;
  return node;
}

/**
 * 把两份结算合成「按座位排好的四家」。
 *
 * 座位从哪来是有讲究的，三级回退：
 *   ① 小场结算里的 `players[]`（服务端按座位下发，最可靠）；
 *   ② 房间快照的成员列表（顺序就是座位号，见 `roomSnapshot()` 按 joinedAt 排序）；
 *   ③ 都没有就按 `deltas` 的下标当座位 —— 与各家牌面的兜底写法一致。
 *
 * 整局累计优先取小场结算里的 `matchDelta`：它连**最后一小场**的分数都算进去了，
 * 而整局结算的 `rawDeltas` 只在 `completedRounds` 打满时才有意义
 * （中途解散时它是一整局的一部分，同样对，但两处取值口径以 `matchDelta` 为准）。
 */
export function seatScores(
  view: { result?: RoomResult | null | undefined; matchResult?: MatchResult | null | undefined },
  snapshot: RoomSnapshot | null,
): SeatScore[] {
  const result = view.result ?? null;
  const matchResult = view.matchResult ?? null;
  const roundDeltas = byPlayerId(result?.deltas);
  const rawDeltas = byPlayerId(matchResult?.rawDeltas);
  const accountDeltas = byPlayerId(matchResult?.accountDeltas);
  // 余额取整局结算里那 4 行明细（服务端拼好的，含入账后的账号分）。
  // 早先帧里另有一个 `balances` 字段，与 `players[].balance` 是同一份数据 ——
  // 同一个数在两处下发迟早会对不上，已合并成只留 `players`。
  const balances = new Map((matchResult?.players ?? []).map((entry) => [entry.playerId, entry.balance]));

  const seats: Array<{ playerId: string; seat: number }> = [];
  if (result?.players && result.players.length > 0) {
    for (const player of result.players) seats.push({ playerId: player.playerId, seat: player.seat });
  } else if (result?.deltas && result.deltas.length > 0) {
    result.deltas.forEach((entry, seat) => seats.push({ playerId: entry.playerId, seat }));
  } else if (matchResult) {
    (matchResult.rawDeltas ?? []).forEach((entry, seat) => seats.push({ playerId: entry.playerId, seat }));
  } else {
    snapshot?.players.forEach((player, seat) => seats.push({ playerId: player.userId, seat }));
  }

  const roundTotals = new Map(
    (result?.players ?? [])
      .filter((player) => player.matchDelta !== undefined)
      .map((player) => [player.playerId, player.matchDelta as number]),
  );

  return seats
    .sort((left, right) => left.seat - right.seat)
    .map(({ playerId, seat }) => ({
      playerId,
      seat,
      name: snapshot?.players[seat]?.nickname ?? `${seat} 号位`,
      delta: roundDeltas.get(playerId),
      // 小场结算里的累计优先；没有就退到整局结算的 rawDeltas（打满时两者相等）。
      matchDelta: roundTotals.get(playerId) ?? rawDeltas.get(playerId),
      accountDelta: accountDeltas.get(playerId),
      balance: balances.get(playerId),
    }));
}

/**
 * 那一排分数：四家并排、数字放大。
 *
 * 玩法上它是结算界面的第一信息 —— 玩家第一眼要找的就是「这一小场（或这一整局）谁赢了多少」。
 * 早先分数混在下面每家的文字行里（「张三 · 已胡 赢 +6 分 · 自摸 平胡」），
 * 四家要一行行读完才知道输赢。
 *
 * `primary` 决定那个大字是**本小场**的变化（小场弹窗）还是**整局累计**（结算记录）：
 * 两处的第一信息不同。另一个数当小字跟在下面。
 *
 * `showAccount` 只在整局结算时打开：打的过程中账号积分还没变（要等结算才入账），
 * 那时把「入账」摆出来会让人以为分已经进账号了。
 *
 * **样式内联**：这份面板是 `/multi` 与 `/debug` 共用的，而两个页面各有一套自己的样式表
 * （`/debug` 根本没装牌桌那份 `installTableLayout`）—— 靠外部 class 的话
 * `/debug` 上会退化成没有边框、字号大小不分的裸文本。
 */
export function scoreBoard(
  scores: readonly SeatScore[],
  options: { primary: "round" | "match"; showAccount: boolean },
): HTMLElement {
  const board = element("div");
  board.className = "score-board";
  board.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:10px 0 16px";

  for (const score of scores) {
    const cell = element("div");
    cell.className = "score-cell";
    cell.style.cssText = "padding:8px 4px;border-radius:10px;background:#0d2b22;border:1px solid #b7a26b55;text-align:center;overflow:hidden";

    const name = element("div", { className: "score-name", text: `${score.seat} 号位 ${score.name}` });
    name.style.cssText = "font-size:13px;color:#b9c9bd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    cell.append(name);

    const main = options.primary === "match" ? score.matchDelta : score.delta;
    const value = element("div", { className: "score-value", text: signedOr(main) });
    value.style.cssText = `font-size:clamp(24px,3.4vw,46px);font-weight:800;line-height:1.2;font-variant-numeric:tabular-nums;color:${main === undefined ? "#c5d7cd" : scoreColor(main)}`;
    value.setAttribute("aria-label", `${score.name} ${options.primary === "match" ? "本场累计" : "本小场"} ${signedOr(main)} 分`);
    cell.append(value);

    // 副行放另一个口径的数：小场弹窗里是「本场累计」，结算记录里是「本小场」。
    if (options.primary === "match") {
      if (score.delta !== undefined) {
        cell.append(line("score-round", `本小场 ${signed(score.delta)}`, scoreColor(score.delta)));
      }
    } else if (score.matchDelta !== undefined) {
      cell.append(line("score-total", `本场累计 ${signed(score.matchDelta)}`, scoreColor(score.matchDelta)));
    }

    if (options.showAccount && (score.accountDelta !== undefined || score.balance !== undefined)) {
      // 只有入账分与累计分不一样时才点明「结算」——否则一排数字里全是重复值，反而看不清。
      const paid = score.accountDelta !== undefined && score.accountDelta !== score.matchDelta
        ? `入账 ${signed(score.accountDelta)} · `
        : "";
      const balance = score.balance === undefined ? "" : `账号 ${score.balance} 分`;
      cell.append(line("score-account", `${paid}${balance}`.replace(/ · $/, ""), "#e7cf98"));
    }

    board.append(cell);
  }
  return board;
}
