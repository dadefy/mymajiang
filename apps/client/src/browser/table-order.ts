import type { MatchState, RoomSnapshot } from "../protocol.js";

/**
 * 牌桌上的「轮到谁」与出牌顺序。
 *
 * 全是纯函数，不碰 DOM —— 这样才能单独测。方位算错在血战到底后期特别难发现：
 * 那时已经有人胡牌、退出了轮转，肉眼看着「下家」还以为是隔壁座位。
 */

/**
 * 出牌顺序里的下一个还在打的座位。
 *
 * 语义照抄规则引擎的 `MahjongGame.nextSeat`：`(from + step) % 4`，即**座位号递增**；
 * 并且**跳过已经胡牌的人** —— 血战到底里胡了就不再摸打。
 * 漏掉「跳过」这一步，血战后期标出来的「下家」会指向一个已经不在轮转里的人。
 *
 * 返回 `null` 表示除 `from` 以外没有人在轮转里了。
 */
export function nextActiveSeat(match: MatchState, from: number): number | null {
  for (let step = 1; step <= 4; step += 1) {
    const seat = (from + step) % 4;
    const player = match.players.find((each) => each.seat === seat);
    if (player && !player.won) return seat;
  }
  return null;
}

/**
 * 从我的下家开始、按出牌顺序走一圈，给出对手的座位（不含我，也不含已胡的人）。
 */
export function activeRing(match: MatchState): number[] {
  const ring: number[] = [];
  let cursor = match.seat;
  for (let step = 0; step < 4; step += 1) {
    const next = nextActiveSeat(match, cursor);
    if (next === null || next === match.seat || ring.includes(next)) break;
    ring.push(next);
    cursor = next;
  }
  return ring;
}

/**
 * 方位标签。
 *
 * 三个对手时是「下家 / 对家 / 上家」；有人胡了之后轮转里只剩两个，
 * 那时只标「下家 / 上家」—— 再叫「对家」就名不副实了。
 */
export function relationLabel(ring: readonly number[], index: number): string {
  if (ring.length === 3) return ["下家", "对家", "上家"][index] ?? "对手";
  if (ring.length === 2) return ["下家", "上家"][index] ?? "对手";
  return "对手";
}

/** 昵称。与 `RoomPage` 同一套约定：房间快照的 `players` 下标就是座位号。 */
export function nicknameOf(snapshot: RoomSnapshot | null, seat: number): string {
  return snapshot?.players[seat]?.nickname ?? `${seat} 号位`;
}

/** 完整的一圈：从我开始，后面跟还在打的对手。 */
export function turnOrder(match: MatchState): number[] {
  return [match.seat, ...activeRing(match)];
}
