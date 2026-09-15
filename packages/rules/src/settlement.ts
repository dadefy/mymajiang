import type { ScoreDelta } from "./types.js";

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
}

export function settleWin(winnerId: string, payerIds: readonly string[], paymentPerOpponent: number): ScoreDelta[] {
  assertInteger(paymentPerOpponent, "paymentPerOpponent");
  if (paymentPerOpponent < 0) throw new RangeError("paymentPerOpponent cannot be negative");
  const uniquePayers = [...new Set(payerIds)];
  if (uniquePayers.includes(winnerId)) throw new Error("Winner cannot also be a payer");
  return [
    { playerId: winnerId, delta: uniquePayers.length * paymentPerOpponent },
    ...uniquePayers.map((playerId) => ({ playerId, delta: -paymentPerOpponent })),
  ];
}

export function mergeDeltas(deltas: readonly ScoreDelta[]): ScoreDelta[] {
  const merged = new Map<string, number>();
  for (const entry of deltas) {
    assertInteger(entry.delta, "delta");
    merged.set(entry.playerId, (merged.get(entry.playerId) ?? 0) + entry.delta);
  }
  return [...merged.entries()]
    .map(([playerId, delta]) => ({ playerId, delta }))
    .filter((entry) => entry.delta !== 0)
    .sort((left, right) => left.playerId.localeCompare(right.playerId));
}

export function assertZeroSum(deltas: readonly ScoreDelta[]): void {
  const total = deltas.reduce((sum, entry) => sum + entry.delta, 0);
  if (total !== 0) throw new Error(`Settlement must be zero-sum, received ${total}`);
}

export function capLossesByOpeningBalance(
  rawDeltas: readonly ScoreDelta[],
  openingBalances: Readonly<Record<string, number>>,
): ScoreDelta[] {
  const merged = mergeDeltas(rawDeltas);
  assertZeroSum(merged);
  const winners = merged.filter((entry) => entry.delta > 0);
  const losers = merged.filter((entry) => entry.delta < 0);

  const cappedLosers = losers.map((entry) => {
    const balance = openingBalances[entry.playerId];
    if (balance === undefined) throw new Error(`Missing opening balance for ${entry.playerId}`);
    assertInteger(balance, "opening balance");
    if (balance < 0) throw new RangeError("Opening balance cannot be negative");
    return { playerId: entry.playerId, delta: -Math.min(-entry.delta, balance) };
  });

  const actualLoss = -cappedLosers.reduce((sum, entry) => sum + entry.delta, 0);
  const rawWin = winners.reduce((sum, entry) => sum + entry.delta, 0);
  if (actualLoss === 0 || rawWin === 0) return cappedLosers.filter((entry) => entry.delta !== 0);

  const allocations = winners.map((entry) => {
    const exactNumerator = actualLoss * entry.delta;
    return {
      playerId: entry.playerId,
      delta: Math.floor(exactNumerator / rawWin),
      remainder: exactNumerator % rawWin,
    };
  });
  let unallocated = actualLoss - allocations.reduce((sum, entry) => sum + entry.delta, 0);
  allocations.sort((left, right) => right.remainder - left.remainder || left.playerId.localeCompare(right.playerId));
  for (const allocation of allocations) {
    if (unallocated === 0) break;
    allocation.delta += 1;
    unallocated -= 1;
  }

  const result = mergeDeltas([
    ...cappedLosers,
    ...allocations.map(({ playerId, delta }) => ({ playerId, delta })),
  ]);
  assertZeroSum(result);
  return result;
}

