import { MIANYANG_XZ_1_0 } from "./config.js";
import {
  allPhysicalTiles,
  containsMissingSuit,
  countRoots,
  isAllPungs,
  isSevenPairs,
  isStandardWin,
} from "./hand.js";
import { countTiles, tileRank, tileSuit } from "./tiles.js";
import type { FanItem, FanResult, WinContext } from "./types.js";

function addItem(items: FanItem[], code: string, name: string, fan: number): void {
  items.push({ code, name, fan });
}

function isCleanSuit(context: WinContext): boolean {
  return new Set(allPhysicalTiles(context.concealedTiles, context.declaredMelds).map(tileSuit)).size === 1;
}

function isMiddleTiles(context: WinContext): boolean {
  return allPhysicalTiles(context.concealedTiles, context.declaredMelds).every((tile) => {
    const rank = tileRank(tile);
    return rank >= 2 && rank <= 8;
  });
}

function isClosed(context: WinContext): boolean {
  return context.declaredMelds.every((meld) => meld.kind === "kong" && meld.concealed === true);
}

function isJiangDui(context: WinContext, allPungs: boolean): boolean {
  return allPungs && allPhysicalTiles(context.concealedTiles, context.declaredMelds).every((tile) =>
    [2, 5, 8].includes(tileRank(tile)),
  );
}

function isGoldHook(context: WinContext, allPungs: boolean): boolean {
  return allPungs && context.declaredMelds.length === 4 && context.concealedTiles.length === 2;
}

function isAllTerminals(context: WinContext): boolean {
  if (isSevenPairs(context.concealedTiles, context.declaredMelds.length)) {
    return context.concealedTiles.every((tile) => [1, 9].includes(tileRank(tile)));
  }
  if (context.declaredMelds.some((meld) => ![1, 9].includes(tileRank(meld.tile)))) return false;

  const counts = countTiles(context.concealedTiles);
  const meldsNeeded = 4 - context.declaredMelds.length;
  for (let pair = 0; pair < counts.length; pair += 1) {
    if (counts[pair]! < 2 || ![1, 9].includes(tileRank(pair))) continue;
    counts[pair]! -= 2;
    if (canFormTerminalMelds(counts, meldsNeeded)) {
      counts[pair]! += 2;
      return true;
    }
    counts[pair]! += 2;
  }
  return false;
}

function canFormTerminalMelds(counts: number[], remaining: number): boolean {
  if (remaining === 0) return counts.every((count) => count === 0);
  const tile = counts.findIndex((count) => count > 0);
  if (tile < 0) return false;
  const rank = tileRank(tile);

  if ([1, 9].includes(rank) && counts[tile]! >= 3) {
    counts[tile]! -= 3;
    if (canFormTerminalMelds(counts, remaining - 1)) {
      counts[tile]! += 3;
      return true;
    }
    counts[tile]! += 3;
  }
  if ((rank === 1 || rank === 7) && counts[tile + 1]! > 0 && counts[tile + 2]! > 0) {
    counts[tile]!--;
    counts[tile + 1]!--;
    counts[tile + 2]!--;
    if (canFormTerminalMelds(counts, remaining - 1)) {
      counts[tile]!++;
      counts[tile + 1]!++;
      counts[tile + 2]!++;
      return true;
    }
    counts[tile]!++;
    counts[tile + 1]!++;
    counts[tile + 2]!++;
  }
  return false;
}

export function paymentForFan(fan: number): number {
  const finalFan = Math.max(0, Math.min(MIANYANG_XZ_1_0.maxFan, Math.floor(fan)));
  return MIANYANG_XZ_1_0.basePoint * 2 ** finalFan;
}

export function calculateFan(context: WinContext): FanResult {
  if (containsMissingSuit(context.concealedTiles, context.declaredMelds, context.missingSuit)) {
    return { valid: false, rawFan: 0, finalFan: 0, paymentPerOpponent: 0, items: [] };
  }

  const sevenPairs = isSevenPairs(context.concealedTiles, context.declaredMelds.length);
  const standard = isStandardWin(context.concealedTiles, context.declaredMelds.length);
  if (!sevenPairs && !standard) {
    return { valid: false, rawFan: 0, finalFan: 0, paymentPerOpponent: 0, items: [] };
  }

  const items: FanItem[] = [];
  if (context.heavenly || context.earthly) {
    addItem(items, context.heavenly ? "HEAVENLY" : "EARTHLY", context.heavenly ? "天胡" : "地胡", 4);
  } else {
    const cleanSuit = isCleanSuit(context);
    const allPungs = standard && isAllPungs(context.concealedTiles, context.declaredMelds);
    const roots = countRoots(context.concealedTiles, context.declaredMelds);
    const goldHook = isGoldHook(context, allPungs);
    const jiangDui = isJiangDui(context, allPungs);
    const terminals = isAllTerminals(context);

    if (sevenPairs) {
      addItem(items, roots > 0 ? "DRAGON_SEVEN_PAIRS" : "SEVEN_PAIRS", roots > 0 ? "龙七对" : "七对", 2 + Math.min(roots, 1));
      if (roots > 1) addItem(items, "EXTRA_ROOTS", "额外根", roots - 1);
    } else if (goldHook) {
      addItem(items, "GOLD_HOOK", "金钩钓", 2);
      if (roots > 0) addItem(items, "ROOTS", "根", roots);
    } else if (jiangDui) {
      addItem(items, "JIANG_DUI", "将对", 3);
      if (roots > 0) addItem(items, "ROOTS", "根", roots);
    } else if (terminals) {
      addItem(items, "ALL_TERMINALS", "全幺九", 3);
      if (roots > 0) addItem(items, "ROOTS", "根", roots);
    } else {
      if (allPungs) addItem(items, "ALL_PUNGS", "对对胡", 1);
      if (roots > 0) addItem(items, "ROOTS", "根", roots);
    }

    if (cleanSuit) addItem(items, "CLEAN_SUIT", "清一色", 2);
    if (!sevenPairs && isClosed(context)) addItem(items, "CLOSED", "门清", 1);
    if (isMiddleTiles(context)) addItem(items, "MIDDLE", "中张", 1);
    if (context.kongAfterDraw) addItem(items, "KONG_FLOWER", "杠上花", 1);
    if (context.kongDiscard) addItem(items, "KONG_DISCARD", "杠上炮", 1);
    if (context.robKong) addItem(items, "ROB_KONG", "抢杠胡", 1);
    if (context.method === "self-draw") addItem(items, "SELF_DRAW", "自摸", 1);
    if (items.length === 0) addItem(items, "PLAIN", "平胡", 0);
  }

  const rawFan = items.reduce((total, item) => total + item.fan, 0);
  const finalFan = Math.min(MIANYANG_XZ_1_0.maxFan, rawFan);
  return { valid: true, rawFan, finalFan, paymentPerOpponent: paymentForFan(finalFan), items };
}

