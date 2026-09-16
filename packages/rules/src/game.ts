import { MIANYANG_XZ_1_0 } from "./config.js";
import { containsMissingSuit, isSevenPairs, isStandardWin } from "./hand.js";
import { calculateFan, paymentForFan } from "./scoring.js";
import { assertTile, countTiles, createTile, tileRank, tileSuit } from "./tiles.js";
import { assertZeroSum, mergeDeltas } from "./settlement.js";
import type { DeclaredMeld, FanItem, FanResult, ScoreDelta, Suit, Tile, WinContext, WinDetail, WinMethod } from "./types.js";

export type GamePhase = "swapping" | "missing" | "playing" | "claiming" | "finished";

export type ClaimAction = "hu" | "peng" | "kong" | "pass";

export type SettlementEventType = "win" | "kong" | "flower_pig" | "da_jiao" | "tax_refund";

export interface SettlementEvent {
  eventId: string;
  type: SettlementEventType;
  payer: string | null;
  payee: string;
  points: number;
  note: string;
}

export interface PlayerView {
  id: string;
  seat: number;
  handSize: number;
  melds: readonly DeclaredMeld[];
  discardCount: number;
  missingSuit: Suit | null;
  won: boolean;
}

export interface GameSnapshot {
  phase: GamePhase;
  dealerSeat: number;
  currentPlayerSeat: number | null;
  tilesLeft: number;
  players: PlayerView[];
  events: readonly SettlementEvent[];
  result?: RoundResult;
}

export interface RoundResult {
  reason: "three-winners" | "wall-exhausted";
  deltas: ScoreDelta[];
  winnerSeats: number[];
  nextDealerSeat: number;
  /**
   * 每位赢家的明细：胡牌类型（番型）与是谁点的炮。
   *
   * 按**胡牌先后**排列（血战到底一局可能有三家胡），客户端结算界面直接照着列。
   * 流局时为空数组。
   */
  wins: WinDetail[];
}

/** 杠分收入明细，流局退税时按此逐笔退回。 */
export interface KongIncomeEntry {
  payer: string;
  points: number;
}

/** 一张刚打出、还在等待响应的牌。 */
export interface PendingDiscard {
  tile: Tile;
  fromSeat: number;
  kongDiscard: boolean;
}

/** 一名玩家的完整状态，含手牌等只有服务端能看的信息。 */
export interface GamePlayerState {
  id: string;
  seat: number;
  hand: Tile[];
  winningHand?: Tile[];
  melds: DeclaredMeld[];
  discards: Tile[];
  kongIncome: KongIncomeEntry[];
  missingSuit: Suit | null;
  swapTiles: Tile[] | null;
  won: boolean;
  winFan: number;
  /**
   * 胡牌明细，用于结算界面显示「胡了什么牌型 / 谁点的炮」。
   * 全部可选：老快照里没有这些字段，恢复时按「没胡」处理。
   */
  winItems?: FanItem[];
  winRawFan?: number;
  winMethod?: WinMethod | null;
  winFromSeat?: number | null;
  winFromTile?: Tile | null;
  winPayment?: number;
  declinedFan: number | null;
  drawCount: number;
}

/**
 * 一局的完整状态，用于持久化与进程重启后恢复。
 *
 * 与只给客户端看的 `GameSnapshot` 不同：这里包含**牌墙和所有人的手牌**，属于服务端机密，
 * 只能留在服务端（写库、进程间传递）。要下发客户端请用 `snapshot()` 或 `viewFor()`。
 *
 * `MahjongGame.restore()` 会完整校验这份状态，任何缺字段、越界牌值、牌数不是 108 张
 * （且尚无人胡牌）的输入都会被拒绝，不会静默恢复出一局坏牌。
 */
export interface GameState {
  seed: number;
  dealerSeat: number;
  swapDirection: "clockwise" | "counter" | "opposite";
  phase: GamePhase;
  currentPlayerSeat: number | null;
  players: GamePlayerState[];
  wall: Tile[];
  events: SettlementEvent[];
  eventCounter: number;
  winnerSeats: number[];
  firstMultiWinDiscarderSeat: number | null;
  pendingDiscard: PendingDiscard | null;
  pendingClaims: Array<{ seat: number; action: ClaimAction }>;
  drawnFromKong: boolean;
  anyMeldMade: boolean;
  result?: RoundResult;
}

export const FLOWER_PIG_PAYMENT = 16;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledWall(seed: number): Tile[] {
  const random = mulberry32(seed);
  const wall: Tile[] = [];
  for (let suit = 0; suit < 3; suit += 1) {
    for (let rank = 1; rank <= 9; rank += 1) {
      for (let copy = 0; copy < 4; copy += 1) wall.push(createTile(suit === 0 ? "wan" : suit === 1 ? "tong" : "tiao", rank));
    }
  }
  for (let index = wall.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [wall[index], wall[swap]] = [wall[swap]!, wall[index]!];
  }
  return wall;
}

const SUITS: readonly Suit[] = ["wan", "tong", "tiao"];
const SWAP_DIRECTIONS = ["clockwise", "counter", "opposite"] as const;
const PHASES: readonly GamePhase[] = ["swapping", "missing", "playing", "claiming", "finished"];
const CLAIM_ACTIONS: readonly ClaimAction[] = ["hu", "peng", "kong", "pass"];
/** 万、筒、条各 9 种各 4 张。 */
const TILE_TOTAL = 108;

/** 换三张/定缺超时的自动策略：选当前数量最少（并列按万、条、筒）的花色。 */
export function leastHeldSuit(hand: readonly Tile[]): Suit {
  const counts = countTiles(hand);
  let best = SUITS[0]!;
  let bestCount = Number.MAX_SAFE_INTEGER;
  for (const suit of SUITS) {
    const count = counts.reduce((total, count, tile) => (tileSuit(tile) === suit ? total + count : total), 0);
    if (count < bestCount) {
      best = suit;
      bestCount = count;
    }
  }
  return best;
}

export function autoSwapTiles(hand: readonly Tile[]): Tile[] {
  const counts = countTiles(hand);
  let best: Suit | null = null;
  let bestCount = Number.MAX_SAFE_INTEGER;
  for (const suit of SUITS) {
    const count = counts.reduce((total, count, tile) => (tileSuit(tile) === suit ? total + count : total), 0);
    if (count >= 3 && count < bestCount) {
      best = suit;
      bestCount = count;
    }
  }
  const suit = best ?? leastHeldSuit(hand);
  const candidates = hand.filter((tile) => tileSuit(tile) === suit);
  return [...candidates.slice(0, 3)].sort((left, right) => left - right);
}

export function autoDiscardTile(hand: readonly Tile[], missingSuit: Suit): Tile {
  const required = hand.filter((tile) => tileSuit(tile) === missingSuit);
  const candidates = required.length > 0 ? required : [...hand];
  const counts = countTiles(hand);
  return [...candidates].sort((left, right) => {
    const countDifference = counts[left]! - counts[right]!;
    return countDifference !== 0 ? countDifference : left - right;
  })[0]!;
}

function removeTiles(hand: Tile[], tiles: readonly Tile[]): void {
  const remaining = [...hand];
  for (const tile of tiles) {
    const index = remaining.indexOf(tile);
    if (index < 0) throw new Error("Tile is not in hand");
    remaining.splice(index, 1);
  }
  hand.length = 0;
  hand.push(...remaining);
}

export class PlayerState {
  readonly hand: Tile[] = [];
  /** 胡牌时保留展示用牌面，不参与后续行牌和实体牌计数。 */
  winningHand: Tile[] = [];
  readonly melds: DeclaredMeld[] = [];
  readonly discards: Tile[] = [];
  readonly kongIncome: KongIncomeEntry[] = [];
  missingSuit: Suit | null = null;
  swapTiles: Tile[] | null = null;
  won = false;
  winFan = 0;
  /** 胡牌时的番型明细（中文名 + 番数），结算界面显示「胡了什么牌型」用。 */
  winItems: FanItem[] = [];
  /** 各番相加、未封顶的番数。 */
  winRawFan = 0;
  /** 自摸还是点炮。没胡时为 null。 */
  winMethod: WinMethod | null = null;
  /** 点炮者的座位；自摸为 null。 */
  winFromSeat: number | null = null;
  /** 胡的那张牌来自别人时给牌值；自摸为 null。 */
  winFromTile: Tile | null = null;
  /** 每家付多少分。 */
  winPayment = 0;
  /** 过手胡：放弃点炮胡后记录被拒的最高番数。 */
  declinedFan: number | null = null;
  /** 已完成的摸牌次数（庄家起手 14 张记为 1 次）。 */
  drawCount = 0;

  constructor(readonly id: string, readonly seat: number) {}

  get handSize(): number {
    return this.hand.length;
  }

  canWinWith(tiles: readonly Tile[]): boolean {
    if (containsMissingSuit(tiles, this.melds, this.missingSuit!)) return false;
    return isStandardWin(tiles, this.melds.length) || isSevenPairs(tiles, this.melds.length);
  }

  tenpai(): boolean {
    const counts = countTiles([...this.hand, ...this.melds.flatMap((meld) => Array<Tile>(meld.kind === "kong" ? 4 : 3).fill(meld.tile))]);
    for (let tile = 0; tile < 27; tile += 1) {
      if (counts[tile]! >= 4) continue;
      if (this.canWinWith([...this.hand, tile])) return true;
    }
    return false;
  }

  /** 查大叫：理论最大可胡番数对应的积分。 */
  bestWaitingPayment(): number {
    const counts = countTiles([...this.hand, ...this.melds.flatMap((meld) => Array<Tile>(meld.kind === "kong" ? 4 : 3).fill(meld.tile))]);
    let best = 0;
    for (let tile = 0; tile < 27; tile += 1) {
      if (counts[tile]! >= 4) continue;
      if (!this.canWinWith([...this.hand, tile])) continue;
      const context: WinContext = {
        concealedTiles: [...this.hand, tile],
        declaredMelds: this.melds,
        missingSuit: this.missingSuit!,
        method: "discard",
      };
      const fan = calculateFan(context);
      if (fan.valid) best = Math.max(best, paymentForFan(fan.finalFan));
    }
    return best;
  }

  /** 导出完整状态，含手牌；属于服务端机密，不能下发给客户端。 */
  toState(): GamePlayerState {
    return {
      id: this.id,
      seat: this.seat,
      hand: [...this.hand],
      winningHand: [...this.winningHand],
      melds: this.melds.map((meld) => ({ ...meld })),
      discards: [...this.discards],
      kongIncome: this.kongIncome.map((entry) => ({ ...entry })),
      missingSuit: this.missingSuit,
      swapTiles: this.swapTiles ? [...this.swapTiles] : null,
      won: this.won,
      winFan: this.winFan,
      winItems: this.winItems.map((item) => ({ ...item })),
      winRawFan: this.winRawFan,
      winMethod: this.winMethod,
      winFromSeat: this.winFromSeat,
      winFromTile: this.winFromTile,
      winPayment: this.winPayment,
      declinedFan: this.declinedFan,
      drawCount: this.drawCount,
    };
  }

  /** 覆盖式恢复。只接受与自身 id、座位一致的状态，避免把快照套到错误的座位上。 */
  loadState(state: GamePlayerState): void {
    if (state.id !== this.id || state.seat !== this.seat) {
      throw new Error(`Player state does not match seat ${this.seat}`);
    }
    this.hand.length = 0;
    this.hand.push(...state.hand);
    this.winningHand = [...(state.winningHand ?? [])];
    this.melds.length = 0;
    this.melds.push(...state.melds.map((meld) => ({ ...meld })));
    this.discards.length = 0;
    this.discards.push(...state.discards);
    this.kongIncome.length = 0;
    this.kongIncome.push(...state.kongIncome.map((entry) => ({ ...entry })));
    this.missingSuit = state.missingSuit;
    this.swapTiles = state.swapTiles ? [...state.swapTiles] : null;
    this.won = state.won;
    this.winFan = state.winFan;
    this.winItems = (state.winItems ?? []).map((item) => ({ ...item }));
    this.winRawFan = state.winRawFan ?? state.winFan;
    this.winMethod = state.winMethod ?? null;
    this.winFromSeat = state.winFromSeat ?? null;
    this.winFromTile = state.winFromTile ?? null;
    this.winPayment = state.winPayment ?? 0;
    this.declinedFan = state.declinedFan;
    this.drawCount = state.drawCount;
  }
}

export class MahjongGame {
  readonly players: PlayerState[];
  readonly events: SettlementEvent[] = [];
  phase: GamePhase = "swapping";
  currentPlayerSeat: number | null = null;
  result?: RoundResult;

  private readonly seed: number;
  private readonly wall: Tile[];
  private readonly random: () => number;
  /** 发牌时定下；之后只有 `restore` 会改写它。 */
  private swapDirection: "clockwise" | "counter" | "opposite";
  private pendingDiscard: PendingDiscard | null = null;
  private readonly pendingClaims = new Map<number, ClaimAction>();
  private drawnFromKong = false;
  private anyMeldMade = false;
  private eventCounter = 0;
  private readonly winnerSeats: number[] = [];
  private firstMultiWinDiscarderSeat: number | null = null;

  constructor(
    seed: number,
    playerIds: readonly [string, string, string, string],
    readonly dealerSeat = Math.floor(mulberry32(seed ^ 0x9e3779b9)() * 4),
  ) {
    if (new Set(playerIds).size !== 4) throw new Error("Four distinct player ids are required");
    this.seed = seed;
    this.random = mulberry32(seed);
    this.wall = shuffledWall(seed);
    this.swapDirection = (["clockwise", "counter", "opposite"] as const)[Math.floor(this.random() * 3)]!;
    this.players = playerIds.map((id, seat) => new PlayerState(id, seat));
    for (let round = 0; round < 13; round += 1) {
      for (const player of this.players) player.hand.push(this.wall.shift()!);
    }
    this.players[dealerSeat]!.hand.push(this.wall.shift()!);
    this.players[dealerSeat]!.drawCount = 1;
    this.currentPlayerSeat = dealerSeat;
  }

  get tilesLeft(): number {
    return this.wall.length;
  }

  private player(id: string): PlayerState {
    const player = this.players.find((candidate) => candidate.id === id);
    if (!player) throw new Error(`Unknown player: ${id}`);
    return player;
  }

  private requirePhase(phase: GamePhase): void {
    if (this.phase !== phase) throw new Error(`Expected phase ${phase}, but game is ${this.phase}`);
  }

  snapshot(): GameSnapshot {
    return {
      phase: this.phase,
      dealerSeat: this.dealerSeat,
      currentPlayerSeat: this.currentPlayerSeat,
      tilesLeft: this.tilesLeft,
      players: this.players.map((player) => ({
        id: player.id,
        seat: player.seat,
        handSize: player.handSize,
        melds: [...player.melds],
        discardCount: player.discards.length,
        missingSuit: player.missingSuit,
        won: player.won,
      })),
      events: [...this.events],
      ...(this.result ? { result: this.result } : {}),
    };
  }

  /** 客户端/测试视角的脱敏视图：只包含自己的手牌。 */
  viewFor(playerId: string): PlayerView & { hand: readonly Tile[] } {
    const player = this.player(playerId);
    return {
      id: player.id,
      seat: player.seat,
      handSize: player.handSize,
      melds: [...player.melds],
      discardCount: player.discards.length,
      missingSuit: player.missingSuit,
      won: player.won,
      hand: [...player.hand],
    };
  }

  /**
   * 导出完整状态，用于写库或进程间传递。
   *
   * **含牌墙与全部手牌**，属于服务端机密，绝不能下发给客户端；客户端视图请用 `snapshot()`
   * 或 `viewFor()`。导出结果与内部状态完全解耦，可以安全地 JSON 序列化。
   */
  serialize(): GameState {
    return {
      seed: this.seed,
      dealerSeat: this.dealerSeat,
      swapDirection: this.swapDirection,
      phase: this.phase,
      currentPlayerSeat: this.currentPlayerSeat,
      players: this.players.map((player) => player.toState()),
      wall: [...this.wall],
      events: this.events.map((event) => ({ ...event })),
      eventCounter: this.eventCounter,
      winnerSeats: [...this.winnerSeats],
      firstMultiWinDiscarderSeat: this.firstMultiWinDiscarderSeat,
      pendingDiscard: this.pendingDiscard ? { ...this.pendingDiscard } : null,
      pendingClaims: [...this.pendingClaims.entries()].map(([seat, action]) => ({ seat, action })),
      drawnFromKong: this.drawnFromKong,
      anyMeldMade: this.anyMeldMade,
      ...(this.result ? { result: copyRoundResult(this.result) } : {}),
    };
  }

  /**
   * 从快照恢复一局。
   *
   * 先完整校验再构造：缺字段、非法牌值、座位重复、牌数对不上（且尚无人胡牌）都会被拒绝，
   * 不会静默恢复出一局坏牌。恢复后的实例与快照来源行为一致：同样的状态、同样的操作得到同样的结果。
   */
  static restore(state: GameState): MahjongGame {
    assertGameState(state);
    const playerIds = state.players.map((player) => player.id) as [string, string, string, string];
    // 构造函数会按同一个种子重新洗牌发牌，随后立刻被 `loadState` 全部覆盖。这样做是为了让
    // 「四个玩家、座位密集 0..3」这类不变量只在校验里写一遍，不用维护两条构造路径。
    const game = new MahjongGame(state.seed, playerIds, state.dealerSeat);
    game.loadState(state);
    return game;
  }

  private loadState(state: GameState): void {
    this.swapDirection = state.swapDirection;
    this.phase = state.phase;
    this.currentPlayerSeat = state.currentPlayerSeat;

    this.players.forEach((player, index) => player.loadState(state.players[index]!));

    this.wall.length = 0;
    this.wall.push(...state.wall);

    this.events.length = 0;
    this.events.push(...state.events.map((event) => ({ ...event })));
    this.eventCounter = state.eventCounter;

    this.winnerSeats.length = 0;
    this.winnerSeats.push(...state.winnerSeats);
    this.firstMultiWinDiscarderSeat = state.firstMultiWinDiscarderSeat;

    this.pendingDiscard = state.pendingDiscard ? { ...state.pendingDiscard } : null;
    this.pendingClaims.clear();
    for (const claim of state.pendingClaims) this.pendingClaims.set(claim.seat, claim.action);

    this.drawnFromKong = state.drawnFromKong;
    this.anyMeldMade = state.anyMeldMade;

    if (state.result) this.result = copyRoundResult(state.result);
    else delete this.result;
  }

  // ---------- 换三张 ----------

  submitSwap(playerId: string, tiles: readonly Tile[]): void {
    this.requirePhase("swapping");
    const player = this.player(playerId);
    if (player.swapTiles) throw new Error("Swap already submitted");
    if (tiles.length !== 3) throw new Error("Exactly three tiles are required");
    const suit = tileSuit(tiles[0]!);
    if (!tiles.every((tile) => tileSuit(tile) === suit)) throw new Error("Swap tiles must share one suit");
    const proof = [...player.hand];
    removeTiles(proof, tiles);
    player.swapTiles = [...tiles];
    this.maybeResolveSwaps();
  }

  autoSwap(playerId: string): void {
    this.requirePhase("swapping");
    const player = this.player(playerId);
    if (player.swapTiles) throw new Error("Swap already submitted");
    player.swapTiles = autoSwapTiles(player.hand);
    this.maybeResolveSwaps();
  }

  private maybeResolveSwaps(): void {
    if (this.players.some((player) => !player.swapTiles)) return;
    const offset = this.swapDirection === "clockwise" ? 1 : this.swapDirection === "counter" ? 3 : 2;
    const given = this.players.map((player) => player.swapTiles!);
    for (const player of this.players) removeTiles(player.hand, player.swapTiles!);
    for (const player of this.players) {
      const giver = this.players[(player.seat + offset) % 4]!;
      player.hand.push(...given[giver.seat]!);
      player.swapTiles = null;
    }
    this.phase = "missing";
  }

  // ---------- 定缺 ----------

  submitMissing(playerId: string, suit: Suit): void {
    this.requirePhase("missing");
    const player = this.player(playerId);
    if (player.missingSuit) throw new Error("Missing suit already chosen");
    player.missingSuit = suit;
    this.maybeStartPlaying();
  }

  autoMissing(playerId: string): void {
    this.requirePhase("missing");
    const player = this.player(playerId);
    if (player.missingSuit) throw new Error("Missing suit already chosen");
    player.missingSuit = leastHeldSuit(player.hand);
    this.maybeStartPlaying();
  }

  private maybeStartPlaying(): void {
    if (this.players.some((player) => !player.missingSuit)) return;
    this.phase = "playing";
  }

  // ---------- 行牌 ----------

  private requireTurn(player: PlayerState): void {
    this.requirePhase("playing");
    if (this.currentPlayerSeat !== player.seat) throw new Error("Not the player's turn");
    if (player.won) throw new Error("Winner cannot act");
  }

  /** 当前玩家手牌中是否仍有缺门牌（决定强制打缺）。 */
  hasMissingTiles(player: PlayerState): boolean {
    return player.hand.some((tile) => tileSuit(tile) === player.missingSuit);
  }

  discard(playerId: string, tile: Tile): void {
    const player = this.player(playerId);
    this.requireTurn(player);
    if (this.hasMissingTiles(player) && tileSuit(tile) !== player.missingSuit) {
      throw new Error("Missing suit tiles must be discarded first");
    }
    removeTiles(player.hand, [tile]);
    player.discards.push(tile);
    player.declinedFan = null;
    this.phase = "claiming";
    this.pendingDiscard = { tile, fromSeat: player.seat, kongDiscard: this.drawnFromKong };
    this.drawnFromKong = false;
    this.pendingClaims.clear();
    // 没有任何玩家可以响应时直接轮到下家。
    if (this.claimCandidates().length === 0) this.resolveClaims();
  }

  private claimCandidates(): PlayerState[] {
    const discard = this.pendingDiscard!;
    return this.players.filter((player) => {
      if (player.won || player.seat === discard.fromSeat) return false;
      if (this.canWinOnDiscard(player, discard.tile)) return true;
      if (tileSuit(discard.tile) === player.missingSuit) return false;
      const copies = player.hand.filter((tile) => tile === discard.tile).length;
      return copies >= 2; // 碰需 2 张，直杠需 3 张。
    });
  }

  private canWinOnDiscard(player: PlayerState, tile: Tile): boolean {
    if (!player.canWinWith([...player.hand, tile])) return false;
    const context: WinContext = {
      concealedTiles: [...player.hand, tile],
      declaredMelds: player.melds,
      missingSuit: player.missingSuit!,
      method: "discard",
      ...(this.pendingDiscard?.kongDiscard ? { kongDiscard: true } : {}),
    };
    const fan = calculateFan(context);
    if (!fan.valid) return false;
    // 过手胡：放弃后不能胡相同或更低番数的点炮牌。
    if (player.declinedFan !== null && fan.finalFan <= player.declinedFan) return false;
    return true;
  }

  claim(playerId: string, action: ClaimAction): void {
    this.requirePhase("claiming");
    const player = this.player(playerId);
    const discard = this.pendingDiscard!;
    if (player.won || player.seat === discard.fromSeat) throw new Error("Player cannot claim this discard");
    if (this.pendingClaims.has(player.seat)) throw new Error("Claim already submitted");
    if (action !== "pass" && !this.claimCandidates().includes(player)) {
      throw new Error(`Player cannot ${action} this discard`);
    }
    // 最后 4 张有胡必胡。
    if (action === "pass" && this.wall.length <= 4 && this.canWinOnDiscard(player, discard.tile)) {
      throw new Error("Must win on the final four tiles");
    }
    this.pendingClaims.set(player.seat, action);
    if (this.claimCandidates().every((candidate) => this.pendingClaims.has(candidate.seat))) this.resolveClaims();
  }

  private recordEvent(type: SettlementEventType, payer: string | null, payee: string, points: number, note: string): void {
    this.events.push({ eventId: `event-${this.eventCounter++}`, type, payer, payee, points, note });
  }

  private resolveClaims(): void {
    const discard = this.pendingDiscard!;
    const claims = [...this.pendingClaims.entries()]
      .map(([seat, action]) => ({ player: this.players[seat]!, action }))
      .filter((entry) => this.claimCandidates().includes(entry.player));

    const winners = claims.filter((entry) => entry.action === "hu");
    if (winners.length > 0) {
      if (this.winnerSeats.length === 0 && winners.length > 1) {
        this.firstMultiWinDiscarderSeat = discard.fromSeat;
      }
      for (const { player } of winners) {
        player.hand.push(discard.tile);
        this.settleDiscardWin(player, discard.fromSeat, discard.kongDiscard, discard.tile);
      }
      this.pendingDiscard = null;
      this.afterWinsOrContinue();
      return;
    }

    const meldClaims = claims.filter((entry) => entry.action !== "pass");
    if (meldClaims.length > 0) {
      // 距离出牌者最近的下一顺位优先。
      meldClaims.sort(
        (left, right) =>
          ((left.player.seat - discard.fromSeat + 4) % 4) - ((right.player.seat - discard.fromSeat + 4) % 4),
      );
      const chosen = meldClaims[0]!;
      const player = chosen.player;
      const copies = player.hand.filter((tile) => tile === discard.tile).length;
      if (chosen.action === "kong" && copies < 3) throw new Error("Direct kong requires three tiles in hand");
      removeTiles(player.hand, Array(copies === 3 ? 3 : 2).fill(discard.tile) as Tile[]);
      // 被碰/杠的牌离开出牌者的弃牌堆。
      const discarder = this.players[discard.fromSeat]!;
      const discardIndex = discarder.discards.lastIndexOf(discard.tile);
      discarder.discards.splice(discardIndex, 1);
      if (chosen.action === "peng") {
        player.melds.push({ kind: "pong", tile: discard.tile });
        this.anyMeldMade = true;
        player.declinedFan = null;
        this.phase = "playing";
        this.pendingDiscard = null;
        this.currentPlayerSeat = player.seat;
        return;
      }
      // 直杠：点杠者支付 2 分。
      player.melds.push({ kind: "kong", tile: discard.tile });
      this.anyMeldMade = true;
      const from = this.players[discard.fromSeat]!;
      this.recordEvent("kong", from.id, player.id, 2, "直杠");
      player.kongIncome.push({ payer: from.id, points: 2 });
      this.pendingDiscard = null;
      this.drawReplacement(player);
      return;
    }

    // 全部过牌：轮到下一位未胡玩家摸牌。
    // 出手人就是刚打牌的那位 —— 必须在 pendingDiscard 置空**之前**取出来。
    const lastActorSeat = discard.fromSeat;
    this.pendingDiscard = null;
    this.advanceTurn(lastActorSeat);
  }

  private nextSeat(from: number): number {
    for (let step = 1; step <= 4; step += 1) {
      const seat = (from + step) % 4;
      if (!this.players[seat]!.won) return seat;
    }
    throw new Error("No player left to act");
  }

  /**
   * 把回合交给 `fromSeat` 的下一顺位并让他摸牌。
   *
   * `fromSeat` 必须是**刚刚出牌的那一位**，由调用方直接给出。
   * 这里曾经想自己「猜」：用一个 `handSize % 3 === 2`（即 14/11/8 张，正要出牌）
   * 的谓词去找刚行动的人，猜不到就兜底到庄家。但本方法是在**出牌之后、
   * 下一家摸牌之前**运行的 —— 那一刻所有人都已经出完牌、手上都是 13 张（13 % 3 === 1），
   * 没有人满足条件，于是**每一轮都兜底回庄家**。
   *
   * 后果不是「轮转变慢」而是「轮转基本不转」：实测 300 局里有整局只有一个人出过牌
   * （如 p0 出 55 次、另外两家 0 次），牌墙被一个人抽干，因此 99% 的局都以流局收场，
   * 听牌率只有 11.8%，自摸与点炮之比高达 764:6。
   *
   * 猜不出来是因为**信息本来就有**，不该丢。见 `resolveClaims` 的调用处。
   */
  private advanceTurn(fromSeat: number): void {
    if (this.aliveWinners() >= 3) {
      this.finish("three-winners");
      return;
    }
    if (this.wall.length === 0) {
      this.settleDraw();
      return;
    }
    const seat = this.nextSeat(fromSeat);
    this.players[seat]!.hand.push(this.wall.shift()!);
    this.players[seat]!.declinedFan = null;
    this.currentPlayerSeat = seat;
    this.phase = "playing";
  }

  // ---------- 当前玩家在自己回合的操作 ----------

  private winContext(player: PlayerState, method: "self-draw" | "discard"): WinContext {
    return {
      concealedTiles: [...player.hand],
      declaredMelds: player.melds,
      missingSuit: player.missingSuit!,
      method,
      ...(this.drawnFromKong ? { kongAfterDraw: true } : {}),
      ...(method === "self-draw" && this.isHeavenly(player) ? { heavenly: true } : {}),
      ...(method === "self-draw" && this.isEarthly(player) ? { earthly: true } : {}),
    };
  }

  private isHeavenly(player: PlayerState): boolean {
    return player.seat === this.dealerSeat && player.drawCount === 1 && !this.anyMeldMade;
  }

  private isEarthly(player: PlayerState): boolean {
    return (
      player.seat !== this.dealerSeat &&
      player.drawCount === 1 &&
      !this.anyMeldMade &&
      this.aliveWinners() === 0
    );
  }

  selfDrawWin(playerId: string): void {
    const player = this.player(playerId);
    this.requireTurn(player);
    if (!player.canWinWith(player.hand)) throw new Error("Not a winning hand");
    const context = this.winContext(player, "self-draw");
    const fan = calculateFan(context);
    if (!fan.valid) throw new Error("Hand contains missing suit tiles");
    const payers = this.players.filter((candidate) => candidate !== player && !candidate.won);
    for (const payer of payers) {
      this.recordEvent("win", payer.id, player.id, fan.paymentPerOpponent, "自摸");
    }
    // 自摸不是别人给的牌，所以 fromSeat / fromTile 都为 null。
    this.finalizeWin(player, fan, { method: "self-draw", fromSeat: null, fromTile: null });
    this.drawnFromKong = false;
    this.afterWinsOrContinue();
  }

  private settleDiscardWin(player: PlayerState, fromSeat: number, kongDiscard: boolean, tile: Tile): void {
    const context: WinContext = {
      concealedTiles: [...player.hand],
      declaredMelds: player.melds,
      missingSuit: player.missingSuit!,
      method: "discard",
      ...(kongDiscard ? { kongDiscard: true } : {}),
    };
    const fan = calculateFan(context);
    if (!fan.valid) throw new Error("Winning hand contains missing suit tiles");
    const from = this.players[fromSeat]!;
    this.recordEvent("win", from.id, player.id, fan.paymentPerOpponent, "点炮");
    this.finalizeWin(player, fan, { method: "discard", fromSeat, fromTile: tile });
  }

  private finalizeWin(
    player: PlayerState,
    fan: FanResult,
    source: { method: WinMethod; fromSeat: number | null; fromTile: Tile | null },
  ): void {
    player.winningHand = [...player.hand];
    player.won = true;
    player.winFan = fan.finalFan;
    // 番型明细一并留下：结算界面要显示「胡了什么牌型」，而番型只在结算那一刻算得出来。
    player.winItems = fan.items.map((item) => ({ ...item }));
    player.winRawFan = fan.rawFan;
    player.winMethod = source.method;
    player.winFromSeat = source.fromSeat;
    player.winFromTile = source.fromTile;
    player.winPayment = fan.paymentPerOpponent;
    this.winnerSeats.push(player.seat);
    removeTiles(player.hand, player.hand);
  }

  private aliveWinners(): number {
    return this.players.filter((player) => player.won).length;
  }

  private afterWinsOrContinue(): void {
    if (this.aliveWinners() >= 3) {
      this.finish("three-winners");
      return;
    }
    // 出牌被胡后轮到下家摸牌；自摸后胡家退出，下家摸牌。
    if (this.wall.length === 0) {
      this.settleDraw();
      return;
    }
    const lastSeat = this.currentPlayerSeat ?? this.dealerSeat;
    const seat = this.nextSeat(lastSeat);
    this.players[seat]!.hand.push(this.wall.shift()!);
    this.players[seat]!.drawCount += 1;
    this.players[seat]!.declinedFan = null;
    this.currentPlayerSeat = seat;
    this.phase = "playing";
  }

  concealedKong(playerId: string): void {
    const player = this.player(playerId);
    this.requireTurn(player);
    const counts = countTiles(player.hand);
    const tile = counts.findIndex((count) => count === 4);
    if (tile < 0) throw new Error("No concealed kong available");
    if (tileSuit(tile) === player.missingSuit) throw new Error("Missing suit tiles cannot form a kong");
    removeTiles(player.hand, [tile, tile, tile, tile]);
    player.melds.push({ kind: "kong", tile, concealed: true });
    this.anyMeldMade = true;
    for (const payer of this.players) {
      if (payer === player || payer.won) continue;
      this.recordEvent("kong", payer.id, player.id, 2, "暗杠");
      player.kongIncome.push({ payer: payer.id, points: 2 });
    }
    this.drawReplacement(player);
  }

  addedKong(playerId: string): void {
    const player = this.player(playerId);
    this.requireTurn(player);
    const pong = player.melds.find((meld) => meld.kind === "pong" && player.hand.includes(meld.tile));
    if (!pong) throw new Error("No added kong available");
    const tile = pong.tile;
    // 抢杠：任意未胡玩家可以用这张牌胡（抢杠胡 +1 番，补杠取消）。
    const robbers = this.players.filter(
      (candidate) => candidate !== player && !candidate.won && candidate.canWinWith([...candidate.hand, tile]),
    );
    if (robbers.length > 0) {
      if (this.winnerSeats.length === 0 && robbers.length > 1) {
        this.firstMultiWinDiscarderSeat = player.seat;
      }
      for (const robber of robbers) {
        robber.hand.push(tile);
        const context: WinContext = {
          concealedTiles: [...robber.hand],
          declaredMelds: robber.melds,
          missingSuit: robber.missingSuit!,
          method: "discard",
          robKong: true,
        };
        const fan = calculateFan(context);
        if (!fan.valid) throw new Error("Rob kong hand contains missing suit tiles");
        // 补杠取消，不产生杠分；按点炮结构由补杠者支付。
        this.recordEvent("win", player.id, robber.id, fan.paymentPerOpponent, "抢杠胡");
        // 抢杠胡算点炮结构：给牌的是被抢杠的那一家，牌就是那张被补的牌。
        this.finalizeWin(robber, fan, { method: "discard", fromSeat: player.seat, fromTile: tile });
      }
      this.drawnFromKong = false;
      this.afterWinsOrContinue();
      return;
    }
    removeTiles(player.hand, [tile]);
    const meldIndex = player.melds.findIndex((meld) => meld.kind === "pong" && meld.tile === tile);
    player.melds.splice(meldIndex, 1, { kind: "kong", tile });
    for (const payer of this.players) {
      if (payer === player || payer.won) continue;
      this.recordEvent("kong", payer.id, player.id, 1, "补杠");
      player.kongIncome.push({ payer: payer.id, points: 1 });
    }
    this.drawReplacement(player);
  }

  private drawReplacement(player: PlayerState): void {
    if (this.wall.length === 0) {
      this.settleDraw();
      return;
    }
    player.hand.push(this.wall.pop()!);
    player.drawCount += 1;
    player.declinedFan = null;
    this.drawnFromKong = true;
    this.currentPlayerSeat = player.seat;
    this.phase = "playing";
  }

  // ---------- 流局结算 ----------

  private settleDraw(): void {
    const losers = this.players.filter((player) => !player.won);
    const flowerPigs = losers.filter((player) => containsMissingSuit(player.hand, player.melds, player.missingSuit!));
    const clean = losers.filter((player) => !flowerPigs.includes(player));

    for (const pig of flowerPigs) {
      for (const other of clean) {
        this.recordEvent("flower_pig", pig.id, other.id, FLOWER_PIG_PAYMENT, "查花猪");
      }
    }

    const tenpaiPlayers = clean.filter((player) => player.tenpai());
    // 未听牌玩家（含花猪）退税：退回本局全部杠分。
    const refunders = [...flowerPigs, ...clean.filter((player) => !tenpaiPlayers.includes(player))];
    for (const debtor of clean.filter((player) => !tenpaiPlayers.includes(player))) {
      for (const creditor of tenpaiPlayers) {
        const points = creditor.bestWaitingPayment();
        if (points > 0) this.recordEvent("da_jiao", debtor.id, creditor.id, points, "查大叫");
      }
    }
    for (const debtor of refunders) {
      for (const income of debtor.kongIncome) {
        this.recordEvent("tax_refund", debtor.id, income.payer, income.points, "退税");
      }
    }

    this.finish("wall-exhausted");
  }

  private finish(reason: "three-winners" | "wall-exhausted"): void {
    const deltas = mergeDeltas(
      this.events.flatMap((event) => {
        const entries: ScoreDelta[] = [{ playerId: event.payee, delta: event.points }];
        if (event.payer) entries.push({ playerId: event.payer, delta: -event.points });
        return entries;
      }),
    );
    assertZeroSum(deltas);
    const nextDealerSeat = this.firstMultiWinDiscarderSeat ?? this.winnerSeats[0] ?? this.dealerSeat;
    this.result = {
      reason,
      deltas,
      winnerSeats: [...this.winnerSeats],
      nextDealerSeat,
      wins: this.winnerSeats.map((seat) => this.winDetail(seat)),
    };
    this.phase = "finished";
    this.currentPlayerSeat = null;
  }

  /**
   * 一位赢家的结算明细。
   *
   * 「实收多少 / 几家付」**从账本 `events` 反推**，不另存一份：账本本来就是权威，
   * 而自摸的付款家数会随「已胡的人不再付」变化（血战后期常常只剩两家付），
   * 单独存一份迟早会与账本不一致。番型明细则存在玩家身上 —— 它只在结算那一刻算得出来。
   */
  private winDetail(seat: number): WinDetail {
    const player = this.players[seat]!;
    const payments = this.events.filter((event) => event.type === "win" && event.payee === player.id);
    return {
      seat,
      // 没有 method 只可能是老快照恢复出来的（那时不存这些字段），按自摸兜底。
      method: player.winMethod ?? ("self-draw" as const),
      fromSeat: player.winFromSeat,
      fromTile: player.winFromTile,
      items: player.winItems.map((item) => ({ ...item })),
      rawFan: player.winRawFan,
      finalFan: player.winFan,
      paymentPerOpponent: player.winPayment,
      payerCount: payments.length,
      points: payments.reduce((total, event) => total + event.points, 0),
    };
  }

  /** 服务器权威：向各玩家返回当前允许的操作集合。 */
  allowedActions(playerId: string): string[] {
    const player = this.player(playerId);
    if (this.phase === "swapping") return player.swapTiles ? [] : ["swap"];
    if (this.phase === "missing") return player.missingSuit ? [] : ["choose-missing"];
    if (this.phase === "claiming") {
      if (!this.pendingDiscard || player.won || player.seat === this.pendingDiscard.fromSeat) return [];
      if (this.pendingClaims.has(player.seat)) return [];
      const actions: string[] = ["pass"];
      if (this.canWinOnDiscard(player, this.pendingDiscard.tile)) actions.push("hu");
      const copies = player.hand.filter((tile) => tile === this.pendingDiscard!.tile).length;
      if (tileSuit(this.pendingDiscard.tile) !== player.missingSuit && copies >= 2) {
        actions.push("peng");
        if (copies >= 3) actions.push("kong");
      }
      return actions;
    }
    if (this.phase === "playing" && this.currentPlayerSeat === player.seat && !player.won) {
      const actions: string[] = ["discard"];
      if (player.canWinWith(player.hand)) actions.push("hu");
      if (countTiles(player.hand).some((count) => count === 4)) actions.push("kong-concealed");
      if (player.melds.some((meld) => meld.kind === "pong" && player.hand.includes(meld.tile))) {
        actions.push("kong-added");
      }
      return actions;
    }
    return [];
  }

  /** 超时或断线托管：有胡必胡，不主动碰杠，其余按确定性策略出牌。 */
  autoAct(playerId: string): void {
    const actions = this.allowedActions(playerId);
    if (actions.length === 0) throw new Error("Player has no available action");
    if (this.phase === "swapping") {
      this.autoSwap(playerId);
      return;
    }
    if (this.phase === "missing") {
      this.autoMissing(playerId);
      return;
    }
    if (this.phase === "claiming") {
      this.claim(playerId, actions.includes("hu") ? "hu" : "pass");
      return;
    }
    if (actions.includes("hu")) {
      this.selfDrawWin(playerId);
      return;
    }
    const player = this.player(playerId);
    this.discard(playerId, autoDiscardTile(player.hand, player.missingSuit!));
  }
}

function copyRoundResult(result: RoundResult): RoundResult {
  return {
    reason: result.reason,
    deltas: result.deltas.map((delta) => ({ ...delta })),
    winnerSeats: [...result.winnerSeats],
    nextDealerSeat: result.nextDealerSeat,
    // 深拷贝：番型明细是嵌套数组，浅拷贝会让快照与内部状态共享同一份 items。
    wins: result.wins.map((win) => ({ ...win, items: win.items.map((item) => ({ ...item })) })),
  };
}

/** 一局里还留在牌桌上的牌：牌墙 + 手牌 + 副露 + 弃牌。 */
function tilesOnTable(state: GameState): number {
  return state.players.reduce(
    (total, player) =>
      total +
      player.hand.length +
      player.discards.length +
      player.melds.reduce((meldTotal, meld) => meldTotal + (meld.kind === "kong" ? 4 : 3), 0),
    state.wall.length,
  );
}

function assertSeat(seat: number, context: string): void {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) {
    throw new Error(`${context} is not a seat: ${String(seat)}`);
  }
}

function assertTileList(tiles: readonly Tile[], context: string): void {
  if (!Array.isArray(tiles)) throw new Error(`${context} is not an array of tiles`);
  for (const tile of tiles) {
    try {
      assertTile(tile);
    } catch {
      throw new Error(`${context} contains an invalid tile: ${String(tile)}`);
    }
  }
}

/**
 * 校验一份完整状态是否可以恢复。
 *
 * 这类数据来自数据库，宁可拒绝启动也不要恢复出一局算错的牌：座位、牌值、副露形态、事件计数、
 * 结算零和都会被检查；只要还没人胡牌，还必须正好 108 张牌（胡牌后赢家手牌会被清空，不再适用）。
 */
function assertGameState(state: GameState): void {
  if (!Number.isInteger(state.seed)) throw new Error("Game state has no usable seed");
  assertSeat(state.dealerSeat, "dealerSeat");
  if (!SWAP_DIRECTIONS.includes(state.swapDirection)) {
    throw new Error(`Unknown swap direction: ${String(state.swapDirection)}`);
  }
  if (!PHASES.includes(state.phase)) throw new Error(`Unknown game phase: ${String(state.phase)}`);
  if (state.currentPlayerSeat !== null) assertSeat(state.currentPlayerSeat, "currentPlayerSeat");

  if (!Array.isArray(state.players) || state.players.length !== 4) {
    throw new Error("A game state must contain exactly four players");
  }
  assertTileList(state.wall, "wall");

  const seats = new Set<number>();
  const ids = new Set<string>();
  for (const player of state.players) {
    assertSeat(player.seat, "player seat");
    if (seats.has(player.seat)) throw new Error(`Duplicate player seat: ${player.seat}`);
    if (ids.has(player.id)) throw new Error(`Duplicate player id: ${player.id}`);
    seats.add(player.seat);
    ids.add(player.id);

    assertTileList(player.hand, `hand of seat ${player.seat}`);
    if (player.winningHand !== undefined) assertTileList(player.winningHand, `winning hand of seat ${player.seat}`);
    assertTileList(player.discards, `discards of seat ${player.seat}`);
    if (player.swapTiles !== null) assertTileList(player.swapTiles, `swap tiles of seat ${player.seat}`);
    for (const meld of player.melds) {
      assertTileList([meld.tile], `meld of seat ${player.seat}`);
      if (meld.kind !== "pong" && meld.kind !== "kong") throw new Error(`Unknown meld kind: ${String(meld.kind)}`);
      if (meld.concealed && meld.kind !== "kong") throw new Error("Only a kong can be concealed");
    }
    for (const income of player.kongIncome) {
      if (!Number.isInteger(income.points) || income.points <= 0) {
        throw new Error(`Invalid kong income for seat ${player.seat}`);
      }
    }
    if (!Number.isInteger(player.winFan) || player.winFan < 0) {
      throw new Error(`Invalid win fan for seat ${player.seat}`);
    }
    if (!Number.isInteger(player.drawCount) || player.drawCount < 0) {
      throw new Error(`Invalid draw count for seat ${player.seat}`);
    }
    if (player.declinedFan !== null && (!Number.isInteger(player.declinedFan) || player.declinedFan <= 0)) {
      throw new Error(`Invalid declined fan for seat ${player.seat}`);
    }
    if (player.missingSuit !== null && !SUITS.includes(player.missingSuit)) {
      throw new Error(`Unknown missing suit: ${String(player.missingSuit)}`);
    }
  }

  if (state.pendingDiscard) {
    assertTileList([state.pendingDiscard.tile], "pending discard");
    assertSeat(state.pendingDiscard.fromSeat, "pending discard seat");
  }
  for (const claim of state.pendingClaims) {
    assertSeat(claim.seat, "pending claim seat");
    if (!CLAIM_ACTIONS.includes(claim.action)) throw new Error(`Unknown claim action: ${String(claim.action)}`);
  }
  if (state.firstMultiWinDiscarderSeat !== null) {
    assertSeat(state.firstMultiWinDiscarderSeat, "first multi-win discarder seat");
  }
  if (!Number.isInteger(state.eventCounter) || state.eventCounter < state.events.length) {
    throw new Error("Event counter does not match the recorded events");
  }
  if (state.result) {
    if (state.result.reason !== "three-winners" && state.result.reason !== "wall-exhausted") {
      throw new Error(`Unknown round result reason: ${String(state.result.reason)}`);
    }
    assertSeat(state.result.nextDealerSeat, "next dealer seat");
    assertZeroSum(state.result.deltas);
  }

  if (!state.players.some((player) => player.won)) {
    const total = tilesOnTable(state);
    if (total !== TILE_TOTAL) {
      throw new Error(`Game state holds ${total} tiles instead of ${TILE_TOTAL}`);
    }
  }
}
