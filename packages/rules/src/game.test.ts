import { describe, expect, it } from "vitest";
import {
  MahjongGame,
  autoSwapTiles,
  leastHeldSuit,
  mergeDeltas,
  parseTiles,
  tileSuit,
} from "./index.js";

const IDS = ["p0", "p1", "p2", "p3"] as const;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 自动换三张 + 定缺，把牌局推进到行牌阶段。 */
function startPlaying(game: MahjongGame, random: () => number): void {
  let guard = 0;
  while (game.phase === "swapping") {
    for (const id of IDS) if (game.allowedActions(id).includes("swap")) game.autoSwap(id);
    if (guard++ > 10) throw new Error("swap phase stuck");
  }
  while (game.phase === "missing") {
    for (const id of IDS) if (game.allowedActions(id).includes("choose-missing")) game.autoMissing(id);
    if (guard++ > 20) throw new Error("missing phase stuck");
  }
  void random;
}

/** 机器人策略打完整局。 */
function playFullGame(seed: number) {
  const game = new MahjongGame(seed, [...IDS]);
  const random = lcg(seed ^ 0x5f5f5f5f);
  startPlaying(game, random);
  let guard = 0;
  while (game.phase !== "finished") {
    if (guard++ > 20000) throw new Error("game loop did not terminate");
    if (game.phase === "playing") {
      const seat = game.currentPlayerSeat!;
      const id = IDS[seat]!;
      const actions = game.allowedActions(id);
      if (actions.length === 0) throw new Error(`no actions for ${id}`);
      const view = game.viewFor(id);
      if (actions.includes("hu")) {
        game.selfDrawWin(id);
        continue;
      }
      if (actions.includes("kong-added") && random() < 0.5) {
        game.addedKong(id);
        continue;
      }
      if (actions.includes("kong-concealed") && random() < 0.5) {
        game.concealedKong(id);
        continue;
      }
      // 必须先打缺门牌；之后打出数量最少的非缺门花色，尽快清门。
      const missingTiles = view.hand.filter((tile) => tileSuit(tile) === view.missingSuit);
      let tile: number;
      if (missingTiles.length > 0) {
        tile = missingTiles[0]!;
      } else {
        const suits = ["wan", "tong", "tiao"] as const;
        const nonMissing = suits.filter((suit) => suit !== view.missingSuit);
        const counts = new Map<string, number>(
          nonMissing.map((suit) => [suit, view.hand.filter((t) => tileSuit(t) === suit).length]),
        );
        const target = nonMissing
          .filter((suit) => counts.get(suit)! > 0)
          .sort((a, b) => counts.get(a)! - counts.get(b)!)[0];
        if (target === undefined) {
          tile = view.hand[0]!;
        } else {
          const candidates = view.hand.filter((t) => tileSuit(t) === target);
          tile = candidates[Math.floor(random() * candidates.length)]!;
        }
      }
      game.discard(id, tile);
      continue;
    }
    if (game.phase === "claiming") {
      let claimed = false;
      for (const id of IDS) {
        const actions = game.allowedActions(id);
        if (actions.length === 0) continue;
        if (actions.includes("hu")) {
          game.claim(id, "hu");
          claimed = true;
          break;
        }
        if (actions.includes("kong") && random() < 0.3) {
          game.claim(id, "kong");
          claimed = true;
          break;
        }
        if (actions.includes("peng") && random() < 0.4) {
          game.claim(id, "peng");
          claimed = true;
          break;
        }
      }
      if (!claimed) {
        for (const id of IDS) {
          if (game.allowedActions(id).includes("pass")) {
            game.claim(id, "pass");
            break;
          }
        }
      }
      continue;
    }
    throw new Error(`unexpected phase ${game.phase}`);
  }
  return game;
}

describe("发牌", () => {
  it("108 张牌墙、庄家 14 张、闲家 13 张，同种子结果一致", () => {
    const first = new MahjongGame(42, [...IDS]);
    const second = new MahjongGame(42, [...IDS]);
    expect(first.tilesLeft).toBe(108 - 53);
    expect([...first.players.map((player) => player.handSize)].sort((a, b) => a - b)).toEqual([13, 13, 13, 14]);
    const total =
      first.tilesLeft + first.players.reduce((sum, player) => sum + player.handSize, 0);
    expect(total).toBe(108);
    expect(first.players[0]!.hand).toEqual(second.players[0]!.hand);
    expect(first.dealerSeat).toBe(second.dealerSeat);
  });

  it("四位玩家 id 必须互不相同", () => {
    expect(() => new MahjongGame(1, ["a", "a", "b", "c"])).toThrow();
  });
});

describe("换三张", () => {
  it("允许换出两张同值牌，并按手牌实际张数校验、保持换牌守恒", () => {
    const game = new MahjongGame(7, [...IDS]);
    const hand = game.players[0]!.hand;
    hand.splice(0, hand.length, ...parseTiles("113456789m23456p"));
    expect(() => game.submitSwap("p0", [0, 0, 0])).toThrow("Tile is not in hand");
    expect(game.players[0]!.swapTiles).toBeNull();
    const before = game.players.flatMap((player) => player.hand).sort((a,b) => a-b);
    game.submitSwap("p0", [0, 0, 2]);
    expect(game.players[0]!.swapTiles).toEqual([0, 0, 2]);
    expect(game.allowedActions("p0")).not.toContain("swap");
    expect(() => game.submitSwap("p0", [0, 0, 2])).toThrow("Swap already submitted");
    for (const id of IDS.slice(1)) game.autoSwap(id);
    expect(game.phase).toBe("missing");
    expect(game.players.flatMap((player) => player.hand).sort((a,b) => a-b)).toEqual(before);
  });

  it("三张必须同花色且都在手牌中", () => {
    const game = new MahjongGame(7, [...IDS]);
    const hand = game.players[0]!.hand;
    const bySuit = new Map<string, number[]>();
    for (const tile of hand) {
      const suit = tileSuit(tile);
      bySuit.set(suit, [...(bySuit.get(suit) ?? []), tile]);
    }
    const suitTiles = [...bySuit.values()].find((tiles) => tiles.length >= 3)!;
    expect(() => game.submitSwap("p0", [suitTiles[0]!, suitTiles[1]!])).toThrow();
    const otherSuitTile = hand.find((tile) => tileSuit(tile) !== tileSuit(suitTiles[0]!))!;
    expect(() => game.submitSwap("p0", [suitTiles[0]!, suitTiles[1]!, otherSuitTile])).toThrow();
  });

  it("自动换牌选择数量最少且不少于 3 张的花色", () => {
    const hand = parseTiles("1199m234567s123p");
    expect(leastHeldSuit(hand)).toBe("tong");
    const swap = autoSwapTiles(hand);
    expect(swap).toHaveLength(3);
    expect(new Set(swap.map(tileSuit))).toHaveProperty("size", 1);
    expect(swap.every((tile) => tileSuit(tile) === "tong")).toBe(true);
  });

  it("全部提交后按方向同时交换，手牌总数不变", () => {
    const game = new MahjongGame(7, [...IDS]);
    const sizes = game.players.map((player) => player.handSize);
    for (const id of IDS) game.autoSwap(id);
    expect(game.phase).toBe("missing");
    expect(game.players.map((player) => player.handSize)).toEqual(sizes);
  });
});

describe("行牌与结算", () => {
  it("纯托管可以把整局推进到结束", () => {
    const game = new MahjongGame(20260915, [...IDS]);
    let guard = 0;
    while (game.phase !== "finished") {
      if (guard++ > 20000) throw new Error("auto game loop did not terminate");
      const actor = IDS.find((id) => game.allowedActions(id).length > 0);
      if (!actor) throw new Error(`no auto action in phase ${game.phase}`);
      game.autoAct(actor);
    }
    expect(game.result).toBeDefined();
    expect(game.result!.deltas.reduce((sum, entry) => sum + entry.delta, 0)).toBe(0);
  });

  it("手里还有缺门牌时必须先打缺门", () => {
    const game = new MahjongGame(99, [...IDS]);
    startPlaying(game, () => 0.5);
    for (const id of IDS) if (game.allowedActions(id).includes("choose-missing")) game.autoMissing(id);
    const seat = game.currentPlayerSeat!;
    const player = game.players[seat]!;
    const id = IDS[seat]!;
    const missing = player.hand.find((tile) => tileSuit(tile) === player.missingSuit);
    if (missing !== undefined) {
      const other = player.hand.find((tile) => tileSuit(tile) !== player.missingSuit)!;
      expect(() => game.discard(id, other)).toThrow(/缺门|Missing/);
      game.discard(id, missing);
    }
  });

  it("重复的换三张提交被拒绝", () => {
    const game = new MahjongGame(11, [...IDS]);
    const hand = game.players[0]!.hand;
    const suit = tileSuit(hand[0]!);
    const three = hand.filter((tile) => tileSuit(tile) === suit).slice(0, 3);
    game.submitSwap("p0", three);
    expect(() => game.submitSwap("p0", three)).toThrow(/already/);
  });

  it("30 局机器人全自动对局：可完整结束、结算零和、事件守恒", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const game = playFullGame(seed);
      expect(game.phase).toBe("finished");
      const result = game.result!;
      const merged = mergeDeltas(
        game.events.flatMap((event) => [
          { playerId: event.payee, delta: event.points },
          ...(event.payer ? [{ playerId: event.payer, delta: -event.points }] : []),
        ]),
      );
      expect(result.deltas).toEqual(merged);
      const total = result.deltas.reduce((sum, entry) => sum + entry.delta, 0);
      expect(total).toBe(0);
      for (const event of game.events) {
        expect(event.points).toBeGreaterThan(0);
        expect(event.payer).not.toBe(event.payee);
      }
      // 流局且人人听牌时可以没有事件；有事件则必须与积分变化一致（上面已校验）。
      // 胡过玩家的番数已记录。
      for (const player of game.players) {
        if (player.won) expect(player.winFan).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("多局中既有胡牌结束也有流局结束，且流局产生查叫事件", () => {
    const reasons = new Set<string>();
    const eventTypes = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const game = playFullGame(seed);
      reasons.add(game.result!.reason);
      for (const event of game.events) eventTypes.add(event.type);
    }
    expect(reasons.has("three-winners")).toBe(true);
    expect(reasons.has("wall-exhausted")).toBe(true);
    expect(eventTypes.has("win")).toBe(true);
    expect(eventTypes.has("kong")).toBe(true);
    // 这里原本断言的是 `flower_pig` —— 而那个断言**只有在回合轮转坏掉时才成立**：
    // 轮转一坏，有人整局拿不到出牌机会，手里的缺门牌永远打不出去，流局时就成了花猪。
    //
    // 轮转修好之后，每个玩家每次出牌都被强制先打缺门；而流局的触发点是
    // 「某人出完牌 → 下一家该摸牌时发现牌墙已空」，也就是那一刻**所有人都刚出过牌**，
    // 因此结构上不可能有人还捏着缺门牌 —— 实测 200 局里花猪事件为 0。
    // （真要对花猪做覆盖，得专门构造「刚摸到缺门牌牌墙就空」的状态，
    //   靠随机对局是构造不出来的。）
    //
    // 改成断言查大叫事件，这也正是本用例名字里说的「流局产生查叫事件」。
    expect(eventTypes.has("da_jiao")).toBe(true);
  });

  it("回合按座位顺序轮转：没有人被跳过，也没有人被卡住", () => {
    // 回归测试。`advanceTurn` 曾经用 `handSize % 3 === 2`（14/11/8 张，正要出牌）
    // 去**猜**刚行动的人，猜不到就兜底到庄家 —— 但它在出牌之后、下一家摸牌之前运行，
    // 那时所有人都已出完牌、手上都是 13 张，没人满足条件，于是每轮都从庄家下家重来。
    //
    // 症状：整局只有一个人能出牌（实测 p0 出 55 次、另两家各 0 次），牌墙被一个人抽干，
    // 300 局里 298 局以流局收场，听牌率仅 11.8%，自摸与点炮之比高达 764:6。
    //
    // 出牌次数不必严格相等 —— 碰/杠会让某家少摸几次牌，属正常再分配。
    // 但「有人一次都没出过」和「一家独占大半出牌」都是轮转坏掉的铁证。
    for (let seed = 1; seed <= 30; seed += 1) {
      const game = playFullGame(seed);
      const counts = game.players.map((player) => player.discards.length);
      const total = counts.reduce((sum, count) => sum + count, 0);
      expect(total, `seed=${seed} 一局总得有人出牌`).toBeGreaterThan(0);
      expect(Math.min(...counts), `seed=${seed} 出牌次数 ${counts.join("/")}`).toBeGreaterThan(0);
      expect(
        Math.max(...counts),
        `seed=${seed} 出牌次数 ${counts.join("/")}，某一家占了大半`,
      ).toBeLessThanOrEqual(Math.ceil(total / 2));
    }
  });

  it("种子相同牌局可完整复现（回放一致性）", () => {
    const first = playFullGame(17);
    const second = playFullGame(17);
    expect(first.result).toEqual(second.result);
    expect(first.events).toEqual(second.events);
    expect(first.players.map((player) => player.discards)).toEqual(
      second.players.map((player) => player.discards),
    );
  });
});
