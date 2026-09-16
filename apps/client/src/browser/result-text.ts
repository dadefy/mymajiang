import type { MatchResult, RoomResult, RoomSnapshot, WinDetail } from "../protocol.js";
import { tileLabel } from "./tile-label.js";

/**
 * 结算摘要的两段文本。
 *
 * 之所以单独成模块：**单局结算与整场结算在两个包里同名（`RoomResult`）但字段完全不同**，
 * 之前协议层只声明了单局那一个形状，`match-finished` 送来的整场结果被当成单局读，
 * `result.deltas` 取到 undefined，三个客户端**都在整场结束时抛异常**
 * （`/multi` 的中央区、`/debug` 的结算块、`/apk` 的结算浮层一起废掉）。
 *
 * 现在两个形状分成两个类型，这两个函数也各管一种，混用会被编译器挡住。
 * 纯字符串拼接、不碰 DOM，所以能单独测。
 */

/** 座位号换「X 号位」；対不上时退化成 id 后四位，绝不返回 undefined。 */
function who(snapshot: RoomSnapshot | null, playerId: string): string {
  const index = snapshot?.players.findIndex((player) => player.userId === playerId) ?? -1;
  return index >= 0 ? `${index} 号位` : playerId.slice(-4);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

/** 单局结束的原因，翻成中文。服务端给的是枚举。 */
const ROUND_REASON: Record<RoomResult["reason"], string> = {
  "three-winners": "三家胡",
  "wall-exhausted": "流局",
  dissolved: "中途解散",
};

const MATCH_REASON: Record<MatchResult["reason"], string> = {
  completed: "打满 8 局",
  dissolved: "中途解散",
};

/** 单局结算的一行摘要（含每家这一局的得失分）。 */
export function roundResultText(result: RoomResult, snapshot: RoomSnapshot | null): string {
  const deltas = (result.deltas ?? [])
    .map((entry) => `${who(snapshot, entry.playerId)} ${signed(entry.delta)}`)
    .join("　");
  const winners = result.winnerSeats.length > 0
    ? `赢家座位 ${result.winnerSeats.join("、")}`
    : "无人胡牌";
  return `上一局（${ROUND_REASON[result.reason] ?? result.reason}）${winners}　${deltas}`;
}

/**
 * 结算界面上的倒计时文案：`5 秒后开始下一局`。
 *
 * 入参是**时刻**而不是剩余秒数 —— 渲染层隔一会儿拿当前时间调一次，文案才会自己往前走。
 * `nextRoundAt` 为 null 表示不停留（或对着的是不下发该字段的旧服务端），
 * 返回 null 让调用方整块不显示，而不是显示一个「0 秒」。
 */
export function countdownText(nextRoundAt: number | null, now: number): string | null {
  if (nextRoundAt === null) return null;
  const remaining = nextRoundAt - now;
  // 到点后可能还要等一小会儿才收到新局帧（网络那一跳），别说「0 秒」让人干等。
  if (remaining <= 0) return "正在开始下一局…";
  return `${Math.ceil(remaining / 1000)} 秒后开始下一局`;
}

/** 座位号换昵称；对不上时退化成「X 号位」，绝不返回 undefined。 */
function seatName(snapshot: RoomSnapshot | null, seat: number): string {
  return snapshot?.players[seat]?.nickname ?? `${seat} 号位`;
}

/**
 * 番型明细的一段话：`对对胡1 + 门清1 + 自摸1 = 3番`。
 *
 * 每项都带自己的番数 —— 只写「3 番」的话，玩家看不出这 3 番是怎么来的，
 * 而这正是他要对照规则表确认的东西。0 番的项（平胡）不写数字，免得像「平胡 0」。
 */
export function fanListText(win: WinDetail): string {
  const parts = win.items.map((item) => (item.fan > 0 ? `${item.name}${item.fan}` : item.name));
  const capped = win.rawFan > win.finalFan ? `（封顶 ${win.finalFan} 番）` : "";
  return `${parts.join(" + ") || "平胡"} = ${win.rawFan} 番${capped}`;
}

/**
 * 一位赢家的结算说明：**胡了什么牌型、谁给的牌、收了多少分**。
 *
 * 三件事按玩家关心的顺序排：先「怎么胡的」（自摸 / 谁点的炮），
 * 再「什么牌型」（番型明细），最后「收多少」。
 *
 * 抢杠胡单独说 —— 那张牌不是打出来的，是被抢的补杠，写成「胡 X 打出的牌」不对。
 * 判据用番型里的 `ROB_KONG`，不看 `method`（抢杠在引擎里也是 `discard` 结构）。
 */
export function winSummaryText(win: WinDetail, snapshot: RoomSnapshot | null): string {
  const robbed = win.items.some((item) => item.code === "ROB_KONG");
  const giver = win.fromSeat === null ? "对家" : seatName(snapshot, win.fromSeat);
  const tile = win.fromTile === null ? null : tileLabel(win.fromTile);

  let source: string;
  if (win.method === "self-draw") source = "自摸";
  else if (robbed) source = tile ? `抢杠 ${giver} 的 ${tile}` : `抢杠 ${giver}`;
  else source = tile ? `胡 ${giver} 打出的 ${tile}` : `胡 ${giver} 打出的牌`;

  // 自摸几家付款会随「已胡的人不再付」变化，所以写实际家数，不写死三家。
  const payers = win.payerCount > 1 && win.paymentPerOpponent > 0
    ? `${win.payerCount} 家各付 ${win.paymentPerOpponent} · `
    : "";
  return `${source} · ${fanListText(win)} · ${payers}实收 ${win.points} 分`;
}

/**
 * 一局里所有赢家的结算说明，按胡牌先后。
 *
 * 流局（`wins` 为空）返回空数组 —— 调用方据此决定「要不要显示胡牌那块」，
 * 而不是显示一行「（无）」。
 */
export function winLines(result: RoomResult, snapshot: RoomSnapshot | null): string[] {
  return (result.wins ?? []).map((win) =>
    `${win.seat} 号位（${seatName(snapshot, win.seat)}）　${winSummaryText(win, snapshot)}`);
}

/**
 * 整场结算的一行摘要。
 *
 * 用 `rawDeltas`（这一场的净胜负，未按封顶/负分包处理）—— 那是玩家最关心的数。
 * `accountDeltas` 才是实际写入账号的分值，两者不同时说明触发了封顶或禁止负分，
 * 所以这里只在**两者不一致**时把账号分补在后面。
 */
export function matchResultText(result: MatchResult, snapshot: RoomSnapshot | null): string {
  const raw = result.rawDeltas ?? [];
  const account = result.accountDeltas ?? [];
  const accountOf = new Map(account.map((entry) => [entry.playerId, entry.delta]));
  const parts = raw.map((entry) => {
    const settled = accountOf.get(entry.playerId);
    const suffix = settled !== undefined && settled !== entry.delta ? `（结算 ${signed(settled)}）` : "";
    return `${who(snapshot, entry.playerId)} ${signed(entry.delta)}${suffix}`;
  });
  return `整场结束（${MATCH_REASON[result.reason] ?? result.reason}，共 ${result.completedRounds} 局）　${parts.join("　")}`;
}
