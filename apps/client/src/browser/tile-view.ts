import type { MatchState, Tile } from "../protocol.js";

/**
 * 牌桌上「已经打出来的牌」怎么摆：副露（碰 / 杠）与中央弃牌区。
 *
 * 单独抽出来当纯函数，是因为这里有两处很容易错、错了又不显眼的地方：
 *
 *   * **一副副露摆几张牌** —— 引擎里 `meld.tile` 只存一个牌值（同值成组），
 *     杠少摆一张的话，牌桌上少了一张牌却没人会察觉；
 *   * **弃牌该取哪一份** —— 每条连接的 `match.discards` 只有自己的，
 *     而弃牌是**公开信息**，取自 `players[]` 才四家齐。
 *
 * 只算数据、不碰 DOM，所以能单独测。
 */

export type MeldView = MatchState["melds"][number];

/**
 * 一副副露在牌桌上要摆几张牌：碰 3 张，杠 4 张。
 *
 * 杠多出来的那一张不是装饰 —— 血战到底里杠是加番的（杠上花），
 * 摆错张数就等于把牌桌上的牌数算错了。
 */
export function meldTiles(meld: MeldView): Tile[] {
  return Array.from({ length: meld.kind === "kong" ? 4 : 3 }, () => meld.tile);
}

/**
 * 副露的中文名。
 *
 * 暗杠与明杠都叫「杠」，但两者在这套规则里后果不同（**暗杠不破门清**），
 * 所以名字里直接分开写，不靠颜色暗示 —— 摆错牌型的代价比多打两个字大。
 */
export function meldKindLabel(meld: MeldView): string {
  if (meld.kind !== "kong") return "碰";
  return meld.concealed ? "暗杠" : "杠";
}

export interface DiscardGroup {
  seat: number;
  tiles: Tile[];
}

/**
 * 中央弃牌区的内容：按座位号排好，一家一份。
 *
 * 取 `match.players[].discards` 而不是各连接自己的 `match.discards`：
 * 弃牌本来就是公开信息，服务端对**所有**玩家都下发；而且这样任意一条连接
 * 的状态就足够画出全桌，少一家连上也不会缺一块。
 *
 * 返回新数组，不改动传入的状态。
 */
export function discardGroups(match: MatchState): DiscardGroup[] {
  return [...match.players]
    .sort((left, right) => left.seat - right.seat)
    .map((player) => ({ seat: player.seat, tiles: [...player.discards] }));
}

/**
 * 刚打出的那一张属于谁 —— 需要被强调的那个座位；没有则返回 null。
 *
 * 只在 `claiming` 阶段成立：那时 `currentPlayerSeat` 仍是刚出牌的人，而全场都在看
 * 他打出的那张牌（能不能碰 / 杠 / 胡）。行牌阶段这个字段指的是**下一个**要出牌的人，
 * 拿它去高亮弃牌会框错人的牌。
 */
export function freshDiscardSeat(match: MatchState): number | null {
  return match.phase === "claiming" ? match.currentPlayerSeat : null;
}
