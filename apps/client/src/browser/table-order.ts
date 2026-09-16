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

/**
 * 把一条客户端连接对回座位号。
 *
 * 只有四家同屏那个页面上需要 —— 单人版里「我在几号位」就是 `match.seat`，
 * 但同屏版要在一个屏幕上摆四条连接，且**等待期还没有对局视图**，
 * 那时只能拿房间成员列表的下标去反查（服务端的约定就是 `players[i]` 坐 i 号位）。
 *
 * 三级回退，顺序不能换：
 *   1. `matchSeat` —— 服务端权威给定的，最可靠；
 *   2. 成员列表里按 `userId` 找下标；
 *   3. `fallback`（同屏版传连接序号）—— 保证四家各占一个方位、互不覆盖。
 *
 * 注意第 1 步必须用 `!== null` 判断：**座位 0 是合法值**，写成真值判断会让
 * 坐 0 号位的那家被当成「还没有座位」，然后掉到回退里去 —— 表现是四个方位
 * 随机错位，而且只在部分账号上复现。
 */
export function resolveSeat(input: {
  matchSeat: number | null;
  userId: string | null;
  players: ReadonlyArray<{ userId: string }> | null;
  fallback: number;
}): number {
  if (input.matchSeat !== null) return input.matchSeat;
  if (input.userId !== null && input.players !== null) {
    const index = input.players.findIndex((player) => player.userId === input.userId);
    if (index >= 0 && index < 4) return index;
  }
  return input.fallback;
}
