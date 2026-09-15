import { describe, expect, it } from "vitest";
import { MahjongGame, tileSuit, type GamePhase, type GameState } from "./index.js";

const IDS = ["p0", "p1", "p2", "p3"] as const;

/**
 * 完全确定性的机器人：不碰杠、有胡必胡、先打缺门牌，否则打最小的牌。
 *
 * 特意不用随机数，这样「同一份状态 + 同样的操作 = 同样的结果」这条性质可以直接断言，
 * 不需要同步两个随机数发生器。
 */
function act(game: MahjongGame): void {
  if (game.phase === "swapping") {
    const id = IDS.find((candidate) => game.allowedActions(candidate).includes("swap"));
    if (id !== undefined) {
      game.autoSwap(id);
      return;
    }
  }
  if (game.phase === "missing") {
    const id = IDS.find((candidate) => game.allowedActions(candidate).includes("choose-missing"));
    if (id !== undefined) {
      game.autoMissing(id);
      return;
    }
  }
  if (game.phase === "playing") {
    const id = IDS[game.currentPlayerSeat!]!;
    if (game.allowedActions(id).includes("hu")) {
      game.selfDrawWin(id);
      return;
    }
    const view = game.viewFor(id);
    const missing = view.hand.filter((tile) => tileSuit(tile) === view.missingSuit);
    const tile = missing.length > 0 ? missing[0]! : [...view.hand].sort((left, right) => left - right)[0]!;
    game.discard(id, tile);
    return;
  }
  if (game.phase === "claiming") {
    const winner = IDS.find((candidate) => game.allowedActions(candidate).includes("hu"));
    if (winner !== undefined) {
      game.claim(winner, "hu");
      return;
    }
    const passer = IDS.find((candidate) => game.allowedActions(candidate).includes("pass"));
    if (passer !== undefined) {
      game.claim(passer, "pass");
      return;
    }
  }
  throw new Error(`No deterministic action available in phase ${game.phase}`);
}

/** 推进牌局；`maxSteps` 同时是步数上限与死循环保护。 */
function drive(game: MahjongGame, options: { maxSteps?: number; afterStep?: (game: MahjongGame) => void } = {}): number {
  const budget = options.maxSteps ?? 20_000;
  let step = 0;
  while (game.phase !== "finished" && step < budget) {
    act(game);
    step += 1;
    options.afterStep?.(game);
  }
  return step;
}

function stateInPhase(seed: number, phase: GamePhase): GameState {
  const game = new MahjongGame(seed, [...IDS]);
  let guard = 0;
  while (game.phase !== phase) {
    if (guard++ > 20_000) throw new Error(`Never reached phase ${phase}`);
    act(game);
  }
  return game.serialize();
}

/** 真实持久化路径：JSON 一来一回。 */
function viaJson(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function corrupt(state: GameState, mutate: (copy: GameState) => void): GameState {
  const copy = viaJson(state);
  mutate(copy);
  return copy;
}

describe("对局状态序列化", () => {
  it("在牌局的每一个状态都能原样往返", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const game = new MahjongGame(seed, [...IDS]);
      const check = () => {
        const state = game.serialize();
        expect(MahjongGame.restore(viaJson(state)).serialize()).toEqual(state);
      };
      check();
      drive(game, { afterStep: check });
      expect(game.phase).toBe("finished");
    }
  });

  it("往返之后行为一致：同样的操作得到同样的结果", () => {
    const original = new MahjongGame(20260915, [...IDS]);
    const played = drive(original, { maxSteps: 60 });
    expect(played).toBe(60);
    expect(original.phase).not.toBe("finished");

    const restored = MahjongGame.restore(viaJson(original.serialize()));
    expect(restored.serialize()).toEqual(original.serialize());

    // 两份状态各自继续打完，每一步都必须保持一致。
    const step = () => {
      act(original);
      act(restored);
      expect(restored.serialize()).toEqual(original.serialize());
      return original.phase === "finished";
    };
    let guard = 0;
    while (!step()) {
      if (guard++ > 20_000) throw new Error("replay loop did not terminate");
    }
    expect(restored.result).toEqual(original.result);
    expect(restored.events).toEqual(original.events);
  });

  it("导出的状态与牌局内部状态互不影响", () => {
    const game = new MahjongGame(31, [...IDS]);
    act(game);
    const state = game.serialize();

    state.wall.pop();
    state.players[0]!.hand.pop();
    state.players[0]!.melds.push({ kind: "pong", tile: 0 });
    state.events.push({ eventId: "tampered", type: "win", payer: null, payee: "p0", points: 1, note: "" });

    const fresh = game.serialize();
    expect(fresh.wall).toHaveLength(state.wall.length + 1);
    expect(fresh.players[0]!.melds).toHaveLength(state.players[0]!.melds.length - 1);
    expect(fresh.events.some((event) => event.eventId === "tampered")).toBe(false);

    const restored = MahjongGame.restore(fresh);
    restored.players[0]!.hand.push(0);
    expect(game.serialize().players[0]!.hand).toEqual(fresh.players[0]!.hand);
  });

  it("客户端快照不含牌墙与他人手牌，完整状态才含", () => {
    const game = new MahjongGame(5, [...IDS]);
    while (game.phase === "swapping") act(game);

    const snapshot = game.snapshot();
    expect(snapshot).not.toHaveProperty("wall");
    for (const player of snapshot.players) {
      expect(player).not.toHaveProperty("hand");
      expect(player).toHaveProperty("handSize");
    }
    expect(game.viewFor("p0").hand.length).toBeGreaterThan(0);

    const state = game.serialize();
    expect(state.wall.length).toBeGreaterThan(0);
    expect(state.players.every((player) => player.hand.length > 0)).toBe(true);
  });

  it("已结束的牌局也能恢复，结果与事件不变", () => {
    const game = new MahjongGame(7, [...IDS]);
    while (game.phase === "swapping") act(game);
    while (game.phase === "missing") act(game);
    drive(game, { maxSteps: 20_000 });
    expect(game.phase).toBe("finished");

    const restored = MahjongGame.restore(viaJson(game.serialize()));
    expect(restored.phase).toBe("finished");
    expect(restored.result).toEqual(game.result);
    expect(restored.currentPlayerSeat).toBeNull();
  });
});

describe("对局状态校验", () => {
  it("拒绝不是四名玩家的状态", () => {
    const state = stateInPhase(11, "playing");
    expect(() => MahjongGame.restore(corrupt(state, (copy) => copy.players.pop()))).toThrow(/exactly four players/);
  });

  it("拒绝重复的座位或玩家", () => {
    const state = stateInPhase(12, "playing");
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.players[1]!.seat = 0; })))
      .toThrow(/Duplicate player seat/);
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.players[1]!.id = copy.players[0]!.id; })))
      .toThrow(/Duplicate player id/);
  });

  it("拒绝非法牌值", () => {
    const state = stateInPhase(13, "playing");
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.players[0]!.hand[0] = 27; })))
      .toThrow(/invalid tile: 27/);
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.wall[0] = -1; })))
      .toThrow(/invalid tile: -1/);
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.players[0]!.melds = [{ kind: "pong", tile: 1.5 }]; })))
      .toThrow(/invalid tile: 1.5/);
  });

  it("拒绝未知的阶段、座位、副露与结算原因", () => {
    const state = stateInPhase(14, "playing");
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.phase = "eating" as GamePhase; })))
      .toThrow(/Unknown game phase/);
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.currentPlayerSeat = 9; })))
      .toThrow(/not a seat: 9/);
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.players[0]!.missingSuit = "bamboo" as never; })))
      .toThrow(/Unknown missing suit/);

    const finished = viaJson(stateInPhase(15, "finished"));
    expect(() => MahjongGame.restore(corrupt(finished, (copy) => { copy.result!.reason = "cheated" as never; })))
      .toThrow(/Unknown round result reason/);
    expect(() => MahjongGame.restore(corrupt(finished, (copy) => {
      copy.result!.deltas = [{ playerId: "p0", delta: 5 }];
    }))).toThrow();
  });

  it("拒绝丢掉牌的状态", () => {
    const state = stateInPhase(16, "playing");
    expect(() => MahjongGame.restore(corrupt(state, (copy) => copy.wall.pop())))
      .toThrow(/holds 107 tiles instead of 108/);
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.players[1]!.hand.pop(); })))
      .toThrow(/holds 107 tiles instead of 108/);
    expect(() => MahjongGame.restore(corrupt(state, (copy) => {
      copy.players[2]!.melds = [{ kind: "pong", tile: 0 }];
    }))).toThrow(/holds 111 tiles instead of 108/);
  });

  it("拒绝与事件对不上的计数器", () => {
    const state = stateInPhase(17, "claiming");
    expect(() => MahjongGame.restore(corrupt(state, (copy) => { copy.eventCounter = -1; })))
      .toThrow(/Event counter/);
  });

  it("胡牌之后不再要求 108 张（赢家手牌会被清空）", () => {
    const finished = stateInPhase(18, "finished");
    expect(finished.players.some((player) => player.won)).toBe(true);
    expect(() => MahjongGame.restore(viaJson(finished))).not.toThrow();
  });
});
