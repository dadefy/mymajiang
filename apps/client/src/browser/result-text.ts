import type { MatchResult, RoomResult, RoomSnapshot } from "../protocol.js";

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
