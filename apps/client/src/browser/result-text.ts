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
export { signed };

/**
 * 一小场结束的原因，翻成中文。服务端给的是枚举。
 *
 * 术语按玩法统一：**小场**是打一局牌（血战到底打到底），**一整局**由 8 小场组成，
 * 账号积分只在整局结算时改。所以这里写「三家胡」而不是「三家胡牌」，
 * 也刻意不出现「局」字 —— 那个字归整局用（见 `matchResultText`）。
 */
const ROUND_REASON: Record<RoomResult["reason"], string> = {
  "three-winners": "三家胡",
  "wall-exhausted": "流局",
  dissolved: "中途解散",
};

/** 一小场结束的原因文案；认不出的取值原样返回，不返回 undefined。 */
export function roundReasonText(reason: RoomResult["reason"]): string {
  return ROUND_REASON[reason] ?? reason;
}

/**
 * 「第 3/8 小场」。**只有这一处拼这个串** —— 术语要统一，散着写必然出现
 * 「第 3 局」「第 3 小场」混用，玩家看到的就不知道是同一件事。
 *
 * `totalRounds` 缺省时按 8 兜底：那是 `MIANYANG_XZ_1_0.rounds`，规则写死的；
 * 服务端会下发这个数（`MatchState.totalRounds`），这里只是对着不下发它的旧服务端兜底。
 */
export function roundLabel(roundNumber: number, totalRounds?: number): string {
  return `第 ${roundNumber}/${totalRounds ?? 8} 小场`;
}

/**
 * 毫秒时间戳 → `2026-09-17 01:03`（**本地时间**）。
 *
 * 自己拼而不用 `toLocaleString`：三端（浏览器 / LayaAir / Node 测试）的 locale 与时区库
 * 各不相同，同一个时刻会渲染成「9/17/2026, 1:03:46 AM」「2026/9/17 01:03」等各种样子，
 * 而结算记录是**对账用的**，四个玩家屏幕上必须是同一串字。
 *
 * 认不出（undefined / NaN）时返回 null，让调用方整块不显示 ——
 * 「开始时间 —」比不显示更让人怀疑数据丢了。
 */
export function clockText(epochMs: number | undefined): string | null {
  if (epochMs === undefined || !Number.isFinite(epochMs)) return null;
  const at = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 时长 → `42 分 18 秒`。
 *
 * 三档按「读到哪一位才有意义」分：不足 1 分钟只报秒；不足 1 小时报到秒
 * （打一局牌差几秒是玩家真会讨论的事）；满 1 小时就只报到分 —— 再往下没人关心，
 * 而且整点分钟数（`2 分`）不该拖一个 `0 秒`。
 */
export function durationText(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  return `${seconds} 秒`;
}

/**
 * 结算界面的那一行时间：`开始 2026-09-17 01:03　耗时 42 分 18 秒`。
 *
 * 两个时间戳缺任一个就返回 null —— 只报得出一个数的「耗时」是错的而不是不完整的。
 */
export function matchTimeText(startedAt?: number, finishedAt?: number): string | null {
  const start = clockText(startedAt);
  if (start === null || startedAt === undefined || finishedAt === undefined) return null;
  const spent = durationText(finishedAt - startedAt);
  if (spent === null) return null;
  return `开始 ${start}　耗时 ${spent}`;
}

/** 一小场结算的一行摘要（含每家这一小场的得失分）。 */
export function roundResultText(result: RoomResult, snapshot: RoomSnapshot | null): string {
  const deltas = (result.deltas ?? [])
    .map((entry) => `${who(snapshot, entry.playerId)} ${signed(entry.delta)}`)
    .join("　");
  const winners = result.winnerSeats.length > 0
    ? `赢家座位 ${result.winnerSeats.join("、")}`
    : "无人胡牌";
  return `上一小场（${roundReasonText(result.reason)}）${winners}　${deltas}`;
}

/**
 * 结算界面上的倒计时文案：`5 秒后开始下一小场`。
 *
 * 入参是**时刻**而不是剩余秒数 —— 渲染层隔一会儿拿当前时间调一次，文案才会自己往前走。
 * `nextRoundAt` 为 null 表示不停留（或对着的是不下发该字段的旧服务端），
 * 返回 null 让调用方整块不显示，而不是显示一个「0 秒」。
 */
export function countdownText(nextRoundAt: number | null, now: number): string | null {
  if (nextRoundAt === null) return null;
  const remaining = nextRoundAt - now;
  // 到点后可能还要等一小会儿才收到新局帧（网络那一跳），别说「0 秒」让人干等。
  if (remaining <= 0) return "正在开始下一小场…";
  return `${Math.ceil(remaining / 1000)} 秒后开始下一小场`;
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
 * 整局结算的一行摘要。
 *
 * 用 `rawDeltas`（这一整局的净胜负，未按封顶/负分包处理）—— 那是玩家最关心的数。
 * `accountDeltas` 才是实际写入账号的分值，两者不同时说明触发了封顶或禁止负分，
 * 所以这里只在**两者不一致**时把账号分补在后面。
 *
 * 「打满 8 小场」这个数不写死 8，直接报服务端给的 `completedRounds` ——
 * 中途解散时它是「已打了几个小场」，同样要说得出来。
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
  const reason = result.reason === "dissolved"
    ? `中途解散，已打 ${result.completedRounds} 小场`
    : `打满 ${result.completedRounds} 小场`;
  return `本局结束（${reason}）　${parts.join("　")}`;
}
