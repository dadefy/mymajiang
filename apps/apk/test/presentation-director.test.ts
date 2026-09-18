import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessageView, MatchState, RoomResult, Screen, Tile } from "@mianyang-mahjong/client";
import { AnimationCoordinator, type AnimationCue, type AnimationDriver, type ConfirmedAnimation } from "../src/presentation/animation/AnimationCoordinator.js";
import type { AnimationPayload } from "../src/presentation/animation/animation-spec.js";
import { AudioManager, type AudioDriver, type ConfirmedAudioEvent, type UiCue } from "../src/presentation/audio/AudioManager.js";
import { PresentationDirector } from "../src/presentation/PresentationDirector.js";

type RoomScreen = Extract<Screen, { name: "room" }>;
type ChatScreen = Extract<Screen, { name: "chat" }>;

/** 每个用例建的 director 都在这里登记，收尾统一 dispose（它在牌桌上挂了自有定时器）。 */
const openDirectors: PresentationDirector[] = [];

afterEach(() => {
  while (openDirectors.length) openDirectors.pop()?.dispose();
});

/** 放完即结束的动画驱动：本文件测的是「发了什么事件」，不是引擎怎么画。 */
const quietAnimationDriver: AnimationDriver = {
  play: () => Promise.resolve(),
  cancelAll: () => undefined,
};

const quietAudioDriver: AudioDriver = {
  play: () => undefined,
  stopCategory: () => undefined,
  pauseCategory: () => undefined,
  resumeCategory: () => undefined,
};

interface Seen {
  /** 真响了的声音（过了去重 / 冷却 / 并发闸门之后）。 */
  readonly cues: string[];
  /** 真放了的动画：cue + payload。 */
  readonly animations: Array<{ cue: AnimationCue; source: string; payload?: AnimationPayload }>;
  /** 持续态流水：呼吸环与倒计时环。 */
  readonly sustained: string[];
}

/**
 * director + 真实的 AudioManager / AnimationCoordinator，只在两个边界上记一笔。
 *
 * 用真管理器而不是假对象：§12 那几条（不重复触发、重连不重复订阅）本身就依赖管理器里的
 * 去重表，换成桩就测不到了。
 */
function harness(): Seen & {
  readonly director: PresentationDirector;
  readonly coordinator: AnimationCoordinator;
  /** 喂一帧并等在途动画落定（假驱动是立刻放完的，这一步只是冲刷微任务）。 */
  feed(screen: Screen): Promise<void>;
  /** 推进假时钟（倒计时与冷却都读它）。 */
  advance(ms: number): void;
} {
  const seen: Seen = { cues: [], animations: [], sustained: [] };
  let now = 10_000;

  const audio = new (class extends AudioManager {
    constructor() { super(quietAudioDriver, () => now); }
    override playUi(cue: UiCue): boolean {
      if (!super.playUi(cue)) return false;
      seen.cues.push(cue);
      return true;
    }
    override playConfirmed(event: ConfirmedAudioEvent): boolean {
      if (!super.playConfirmed(event)) return false;
      seen.cues.push(event.cue);
      return true;
    }
  })();

  const animations = new (class extends AnimationCoordinator {
    constructor() { super(quietAnimationDriver); }
    override async playConfirmed(event: ConfirmedAnimation): Promise<boolean> {
      if (!await super.playConfirmed(event)) return false;
      seen.animations.push({ cue: event.cue, source: "server", payload: event.payload });
      return true;
    }
    override async playLocal(cue: AnimationCue, payload?: AnimationPayload): Promise<boolean> {
      if (!await super.playLocal(cue, payload)) return false;
      seen.animations.push({ cue, source: "local", payload });
      return true;
    }
    override setActivePlayer(side: "bottom" | "left" | "top" | "right" | null): void {
      seen.sustained.push(`active:${side}`);
      super.setActivePlayer(side);
    }
    override setCountdown(seconds: number | null, totalSeconds: number | null): void {
      seen.sustained.push(`countdown:${seconds}/${totalSeconds}`);
      super.setCountdown(seconds, totalSeconds);
    }
  })();

  const director = new PresentationDirector({ audio, animations, now: () => now });
  openDirectors.push(director);

  return {
    ...seen,
    director,
    coordinator: animations,
    async feed(screen) {
      director.observe(screen);
      // 冲刷：本地/确认动画都是 promise，落定后才记进 seen。
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      now += 500;        // 每帧之间留出冷却与并发窗口的余量
    },
    advance(ms) { now += ms; },
  };
}

function seatPlayer(seat: number, overrides: Partial<MatchState["players"][number]> = {}): MatchState["players"][number] {
  return { seat, handSize: 13, melds: [], discards: [], won: false, missingSuit: null, ...overrides };
}

/** 四家默认都在座、都没弃牌、都没副露，轮到我（0 号位）。 */
function match(overrides: Partial<MatchState> = {}): MatchState {
  const players = overrides.players ?? [0, 1, 2, 3].map((seat) => seatPlayer(seat));
  return {
    roomId: "room-1",
    roundNumber: 1,
    seat: 0,
    phase: "playing",
    currentPlayerSeat: 0,
    tilesLeft: 60,
    hand: [],
    melds: [],
    missingSuit: null,
    discards: [],
    won: false,
    control: "human",
    players,
    ...overrides,
  };
}

/** 我自己的那一座在 `players` 里也要跟着变，所以弃牌 / 副露都走这个改法。 */
function withMine(m: MatchState, overrides: Partial<MatchState["players"][number]>): MatchState {
  const players = m.players.map((player) => (player.seat === m.seat ? { ...player, ...overrides } : player));
  return { ...m, players };
}

function room(screen: Partial<RoomScreen> & { match: MatchState | null }): RoomScreen {
  return {
    name: "room",
    roomId: "room-1",
    roomNo: "123456",
    snapshot: null,
    actions: [],
    lastResult: null,
    lastMatchResult: null,
    roundPopUntil: null,
    roundFinished: false,
    busy: false,
    ...screen,
  };
}

function chat(messages: GroupMessageView[], meId = "me"): ChatScreen {
  return {
    name: "chat",
    groupId: "g1",
    group: null,
    messages,
    meId,
    hasEarlier: false,
    loadingEarlier: false,
    sending: false,
    uploading: false,
  };
}

function message(messageId: string, senderId: string): GroupMessageView {
  return { messageId, senderId, sentAt: "2026-09-18T10:00:00.000Z", type: "text", content: "在吗", recalledAt: null };
}

/** 只喂「同一帧重复渲染」用得上的形状：内容相同、对象不同。 */
function rerender(m: MatchState): RoomScreen {
  return room({ match: m });
}

const cuesOf = (seen: Seen, cue: string): number => seen.cues.filter((item) => item === cue).length;
const animationsOf = (seen: Seen, cue: AnimationCue): Array<{ cue: AnimationCue; source: string; payload?: AnimationPayload }> =>
  seen.animations.filter((item) => item.cue === cue);

/* ================================================================== *
 * 首帧、重连与重复渲染
 * ================================================================== */

describe("首帧与重连", () => {
  it("进房第一帧一个事件都不发，只把持续态对齐", async () => {
    const h = harness();
    const m = match({ hand: [1, 2, 3], discards: [], players: [seatPlayer(0, { discards: [7] }), seatPlayer(1, { discards: [8, 9] }), seatPlayer(2), seatPlayer(3)] });
    await h.feed(room({ match: m }));
    expect(h.cues).toEqual([]);
    expect(h.animations).toEqual([]);
    expect(h.sustained).toEqual(["active:bottom", "countdown:null/null"]);
  });

  it("同一帧重复渲染（轮询没变 / 结算那屏自己重画）不重复出声、不动画", async () => {
    const h = harness();
    const m = match({ hand: [1, 2, 3, 4] });
    await h.feed(room({ match: m }));
    const revision = h.coordinator.snapshotRevision;
    await h.feed(rerender(m));
    await h.feed(rerender(m));
    expect(h.cues).toEqual([]);
    expect(h.animations).toEqual([]);
    expect(h.coordinator.snapshotRevision).toBe(revision);
  });

  it("重连拿到更早的帧：整帧丢掉，不拿历史倒着播一遍", async () => {
    const h = harness();
    await h.feed(room({ match: match({ roundNumber: 3, hand: [1, 2, 3] }) }));
    await h.feed(room({ match: match({ roundNumber: 2, hand: [1, 2] }) }));
    expect(h.cues).toEqual([]);
    expect(h.animations).toEqual([]);
  });

  it("换一间房：重新对齐，不把上一间的状态当成本间的新变化", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    await h.feed(room({ roomId: "room-2", match: match({ roomId: "room-2", hand: [1, 2, 3, 9] }) }));
    // 新房间的第一帧仍然只对齐：刚进房不该先听见一声摸牌。
    expect(h.cues).toEqual([]);
    expect(h.animations).toEqual([]);
  });

  it("局间停在结算屏（match 为空）：持续态收干净", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], actionDeadlineAt: 25_000 }) }));
    await h.feed(room({ match: null }));
    expect(h.sustained.slice(-2)).toEqual(["active:null", "countdown:null/null"]);
  });
});

/* ================================================================== *
 * 牌局事件
 * ================================================================== */

describe("牌局事件", () => {
  it("摸牌：一声 draw + 一段落在最右一格的动画", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    await h.feed(room({ match: match({ hand: [1, 2, 3, 9] }) }));
    expect(h.cues).toEqual(["draw"]);
    expect(animationsOf(h, "draw")).toEqual([{ cue: "draw", source: "server", payload: { tile: 9, handIndex: 3, isDrawn: true, side: "bottom" } }]);
  });

  it("摸牌只在轮到自己时认：三家的手牌变化不是我的事", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], currentPlayerSeat: 0 }) }));
    await h.feed(room({ match: match({ hand: [1, 2, 3, 9], currentPlayerSeat: 1 }) }));
    expect(h.cues).toEqual([]);
    expect(animationsOf(h, "draw")).toEqual([]);
  });

  it("自己弃牌：声音一次，动画落在**上一帧的显示槽位**", async () => {
    const h = harness();
    // 上一帧刚摸到 9（排在最右），显示顺序是 1,2,3,4,9。
    await h.feed(room({ match: match({ hand: [1, 2, 3, 4] }) }));
    await h.feed(room({ match: match({ hand: [1, 2, 3, 4, 9] }) }));
    h.cues.length = 0;
    h.animations.length = 0;
    const after = match({ hand: [1, 2, 3, 9] });
    await h.feed(room({ match: withMine(after, { discards: [4] }) }));
    expect(h.cues).toEqual(["discard"]);
    expect(animationsOf(h, "discard")).toEqual([
      { cue: "discard", source: "server", payload: { tile: 4, handIndex: 3, riverIndex: 0, side: "bottom" } },
    ]);
  });

  it("同一张牌反复出现在帧里（重绘）不会二次飞一遍", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3, 4] }) }));
    const discarded = withMine(match({ hand: [1, 2, 3, 4] }), { discards: [4] });
    await h.feed(room({ match: discarded }));
    await h.feed(room({ match: discarded }));
    expect(cuesOf(h, "discard")).toBe(1);
    expect(animationsOf(h, "discard").length).toBe(1);
  });

  it("三家弃牌只有声音，没有飞牌动画", async () => {
    const h = harness();
    await h.feed(room({ match: match({ currentPlayerSeat: 1 }) }));
    const m = match({
      currentPlayerSeat: 1,
      players: [seatPlayer(0), seatPlayer(1, { discards: [12] }), seatPlayer(2), seatPlayer(3)],
    });
    await h.feed(room({ match: m }));
    expect(h.cues).toEqual(["discard"]);
    expect(animationsOf(h, "discard")).toEqual([]);
  });

  it("碰与杠按副露数量识别，同帧只认新长出来的那一种", async () => {
    const h = harness();
    await h.feed(room({ match: match({ currentPlayerSeat: 1 }) }));
    const pong = match({
      currentPlayerSeat: 1,
      players: [seatPlayer(0), seatPlayer(1, { melds: [{ kind: "pong", tile: 5 }] }), seatPlayer(2), seatPlayer(3)],
    });
    await h.feed(room({ match: pong }));
    expect(h.cues).toEqual(["peng"]);
    expect(animationsOf(h, "peng")[0].payload).toEqual({ side: "right", tile: 5 });
    h.cues.length = 0;
    const kong = match({
      currentPlayerSeat: 1,
      players: [seatPlayer(0), seatPlayer(1, { melds: [{ kind: "pong", tile: 5 }, { kind: "kong", tile: 5 }] }), seatPlayer(2), seatPlayer(3)],
    });
    await h.feed(room({ match: kong }));
    expect(h.cues).toEqual(["kong"]);
    expect(animationsOf(h, "kong").length).toBe(1);
  });

  it("一帧里三家同时胡：印章只有一个位置，强调只放一次且优先自己", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    await h.feed(room({
      match: match({
        hand: [1, 2, 3],
        players: [seatPlayer(0, { won: true }), seatPlayer(1, { won: true }), seatPlayer(2, { won: true }), seatPlayer(3)],
      }),
    }));
    expect(cuesOf(h, "hu")).toBe(1);
    expect(animationsOf(h, "hu")).toEqual([{ cue: "hu", source: "server", payload: { side: "bottom", text: "胡" } }]);
  });

  it("轮到谁：动画每家都推，声音只在自己被叫到时响", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], currentPlayerSeat: 0 }) }));
    await h.feed(room({ match: match({ hand: [1, 2, 3], currentPlayerSeat: 1 }) }));
    expect(h.cues).toEqual([]);
    expect(animationsOf(h, "turn-highlight")).toEqual([{ cue: "turn-highlight", source: "server", payload: { side: "right" } }]);
    h.animations.length = 0;
    await h.feed(room({ match: match({ hand: [1, 2, 3, 9], currentPlayerSeat: 0 }) }));
    expect(h.cues).toEqual(["draw", "turnNotify"]);
    expect(animationsOf(h, "turn-highlight").length).toBe(1);
  });

  it("换三张与定缺各一次：只在阶段真的改变时", async () => {
    const h = harness();
    await h.feed(room({ match: match({ phase: "playing", hand: [1, 2, 3] }) }));
    await h.feed(room({ match: match({ phase: "swapping", hand: [1, 2, 3] }) }));
    expect(animationsOf(h, "swap").length).toBe(1);
    expect(h.cues).toEqual(["swap"]);
    await h.feed(room({ match: match({ phase: "missing", hand: [1, 2, 3] }) }));
    expect(animationsOf(h, "choose-missing").length).toBe(1);
    expect(h.cues).toEqual(["swap", "choose-missing"]);
    await h.feed(room({ match: match({ phase: "playing", hand: [1, 2, 3] }) }));
    expect(animationsOf(h, "choose-missing").length).toBe(1);
    expect(cuesOf(h, "choose-missing")).toBe(1);
  });

  it("操作按钮从没有到出现：亮一次，之后按钮换个组合也不再亮", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }), actions: [] }));
    await h.feed(room({ match: match({ hand: [1, 2, 3] }), actions: ["peng", "pass"] }));
    expect(animationsOf(h, "action-buttons").length).toBe(1);
    await h.feed(room({ match: match({ hand: [1, 2, 3] }), actions: ["peng"] }));
    expect(animationsOf(h, "action-buttons").length).toBe(1);
  });
});

/* ================================================================== *
 * 托管 / 接管
 * ================================================================== */

describe("托管与接管", () => {
  it("控制权来回各一次动画与一声提示", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    await h.feed(room({ match: match({ hand: [1, 2, 3], control: "trustee" }) }));
    expect(h.cues).toEqual(["trustee"]);
    expect(animationsOf(h, "trustee-on").length).toBe(1);
    h.cues.length = 0;
    await h.feed(room({ match: match({ hand: [1, 2, 3], control: "human" }) }));
    expect(h.cues).toEqual(["takeover"]);
    expect(animationsOf(h, "trustee-off").length).toBe(1);
  });

  it("托管中点牌不给任何反馈：这一座现在由服务器操作", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], control: "trustee" }) }));
    h.cues.length = 0;
    h.animations.length = 0;
    h.director.notifyTileSelect(2 as Tile);
    await h.feed(room({ match: match({ hand: [1, 2, 3], control: "trustee" }) }));
    expect(h.cues).toEqual([]);
    expect(h.animations).toEqual([]);
  });
});

/* ================================================================== *
 * 结算
 * ================================================================== */

describe("结算动画", () => {
  const roundResult = (roundNumber: number): RoomResult => ({
    reason: "wall-exhausted",
    deltas: [],
    winnerSeats: [],
    nextDealerSeat: 0,
    roundNumber,
    totalRounds: 8,
  });

  it("一小场结算：换对象才播，同一对象重复渲染不重播", async () => {
    const h = harness();
    const m = match({ hand: [1, 2, 3] });
    const result = roundResult(1);
    await h.feed(room({ match: m }));
    await h.feed(room({ match: m, lastResult: result }));
    expect(cuesOf(h, "round-finished")).toBe(1);
    expect(animationsOf(h, "round-finished").length).toBe(1);
    await h.feed(room({ match: m, lastResult: result }));
    expect(cuesOf(h, "round-finished")).toBe(1);
  });

  it("下一小场的结算再播一次；两小场的记录不会互相吃掉", async () => {
    const h = harness();
    const m = match({ hand: [1, 2, 3] });
    await h.feed(room({ match: m, lastResult: roundResult(1) }));
    await h.feed(room({ match: m, lastResult: roundResult(2) }));
    expect(cuesOf(h, "round-finished")).toBe(2);
  });

  it("整场结算比小局结算各一次，不叠成两屏", async () => {
    const h = harness();
    const m = match({ hand: [1, 2, 3] });
    await h.feed(room({ match: m }));
    await h.feed(room({
      match: m,
      lastResult: roundResult(8),
      lastMatchResult: { roomId: "room-1", completedRounds: 8, reason: "completed", rawDeltas: [], accountDeltas: [] },
    }));
    expect(cuesOf(h, "round-finished")).toBe(1);
    expect(cuesOf(h, "match-finished")).toBe(1);
    expect(animationsOf(h, "match-finished")[0].payload).toEqual({ text: "整场结束" });
  });

  it("重连后拿到同一份结算记录：不再补一遍结算动画", async () => {
    const h = harness();
    const result = roundResult(3);
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    await h.feed(room({ match: match({ hand: [1, 2, 3] }), lastResult: result }));
    // 重连：flow 把同一份记录重新塞进新的一帧。
    expect(cuesOf(h, "round-finished")).toBe(1);
    await h.feed(room({ match: match({ hand: [1, 2, 3] }), lastResult: result }));
    expect(cuesOf(h, "round-finished")).toBe(1);
  });
});

/* ================================================================== *
 * 倒计时
 * ================================================================== */

describe("倒计时提醒", () => {
  it("第一次看到截止时间就把总时长定格给环", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], actionDeadlineAt: 25_000 }) }));
    expect(h.sustained).toContain("countdown:15/15");
  });

  it("只在自己回合且人在操作时滴答；三家的读秒不响", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], currentPlayerSeat: 1, actionDeadlineAt: 15_000 }) }));
    h.advance(2_000);       // 剩 3 秒：这一档本来该响
    h.director.tick();
    expect(h.cues).toEqual([]);
  });

  it("托管时不响倒计时：服务器不需要玩家听见催促", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], control: "trustee", actionDeadlineAt: 15_000 }) }));
    h.advance(2_000);       // 剩 3 秒
    h.director.tick();
    expect(h.cues).toEqual([]);
  });

  it("到点提醒只有两档：最后 5 秒催一声，最后 1 秒收一声", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], actionDeadlineAt: 20_000 }) }));
    h.advance(5_000);       // 约 15.5s → 剩 5 秒
    h.director.tick();
    h.director.tick();      // 250ms 一跳会连着撞上同一档
    h.director.tick();
    expect(h.cues).toEqual(["countdown-3"]);
    h.advance(1_000);       // 剩 4 秒：中间这些秒不再各响一次
    h.director.tick();
    expect(h.cues).toEqual(["countdown-3"]);
    h.advance(2_500);       // 剩 1 秒 → 换成收尾那一档的音
    h.director.tick();
    expect(h.cues).toEqual(["countdown-3", "countdown-1"]);
    // 响不响是一回事，环得一直按秒在推：250ms 一跳会重复撞同一秒，那是环在走，不是多响一声。
    expect(h.sustained.slice(-5)).toEqual([
      "countdown:5/10", "countdown:5/10", "countdown:5/10",
      "countdown:4/10", "countdown:1/10",
    ]);
  });

  it("每一轮截止时间都是新值：新一轮的提醒照样会响", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], actionDeadlineAt: 20_000 }) }));
    h.advance(5_000);       // 剩 5 秒
    h.director.tick();
    expect(h.cues).toEqual(["countdown-3"]);
    // 我出牌、下一轮：截止时间换新的。
    await h.feed(room({ match: withMine(match({ hand: [1, 2, 3], actionDeadlineAt: 40_000 }), { discards: [3] }) }));
    h.advance(20_000);      // 新截止还剩 4 秒 → 新的一个提醒
    h.director.tick();
    expect(h.cues).toEqual(["countdown-3", "discard", "countdown-3"]);
  });
});

/* ================================================================== *
 * 页面与本地反馈
 * ================================================================== */

describe("页面切换与聊天", () => {
  it("进应用那一跳不播转场，之后换页各播一次", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    expect(animationsOf(h, "screen-transition")).toEqual([]);
    await h.feed({ name: "key-entry", busy: false });
    expect(animationsOf(h, "screen-transition").length).toBe(1);
    await h.feed({ name: "key-entry", busy: true });
    expect(animationsOf(h, "screen-transition").length).toBe(1);
  });

  it("离开牌桌时把牌桌的持续态收掉", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3], actionDeadlineAt: 25_000 }) }));
    await h.feed({ name: "key-entry", busy: false });
    expect(h.sustained.slice(-2)).toEqual(["active:null", "countdown:null/null"]);
  });

  it("别人的新消息响一声；自己的那条与第一屏历史都不算", async () => {
    const h = harness();
    await h.feed(chat([message("m1", "other")]));
    expect(h.cues).toEqual([]);
    await h.feed(chat([message("m1", "other"), message("m2", "other")]));
    expect(h.cues).toEqual(["messageReceive"]);
    await h.feed(chat([message("m1", "other"), message("m2", "other"), message("m3", "me")]));
    expect(cuesOf(h, "messageReceive")).toBe(1);
  });
});

describe("本地反馈出口", () => {
  it("点牌：一声牌面音 + 一次抬起动画，槽位按显示顺序算", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3, 9] }) }));
    h.director.notifyTileSelect(3 as Tile);
    await h.feed(room({ match: match({ hand: [1, 2, 3, 9] }) }));
    expect(h.cues).toEqual(["tileSelect"]);
    expect(animationsOf(h, "select-tile")).toEqual([
      { cue: "select-tile", source: "local", payload: { handIndex: 2, tile: 3, isDrawn: false, side: "bottom" } },
    ]);
  });

  it("刚摸的那张排在最右：按牌面认，不按数组下标", async () => {
    const h = harness();
    // 上一帧三张，这一帧多出 2 → 2 是刚摸的那张，被抽出来排在最右。
    await h.feed(room({ match: match({ hand: [1, 3, 4] }) }));
    await h.feed(room({ match: match({ hand: [1, 2, 3, 4] }) }));
    h.animations.length = 0;
    h.director.notifyTileSelect(2 as Tile);
    await h.feed(room({ match: match({ hand: [1, 2, 3, 4] }) }));
    const select = animationsOf(h, "select-tile")[0];
    expect(select.payload).toMatchObject({ handIndex: 3, tile: 2, isDrawn: true });
  });

  it("点一张不在这一帧里的牌（结算后旧手牌残留）不给反馈", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    h.director.notifyTileSelect(77 as Tile);
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    expect(h.cues).toEqual([]);
    expect(h.animations).toEqual([]);
  });

  it("「过」只补一下动画：点音已经由全局按钮钩子响过", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    h.director.notifyAction("pass");
    h.director.notifyAction("peng");
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    expect(h.cues).toEqual([]);
    expect(animationsOf(h, "pass")).toEqual([{ cue: "pass", source: "local", payload: { side: "bottom" } }]);
  });

  it("通用按钮声直接走音效管理器", async () => {
    const h = harness();
    h.director.notifyUi("uiBack");
    expect(h.cues).toEqual(["uiBack"]);
  });
});

/* ================================================================== *
 * 生命周期
 * ================================================================== */

describe("销毁", () => {
  it("dispose 之后 observe 与 tick 都不再产生任何反馈", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    h.director.dispose();
    await h.feed(room({ match: match({ hand: [1, 2, 3, 9] }) }));
    h.advance(15_000);
    h.director.tick();
    h.director.notifyTileSelect(2 as Tile);
    expect(h.cues).toEqual([]);
    expect(animationsOf(h, "draw")).toEqual([]);
  });

  it("切后台收掉在途动画与语音，回前台只续音乐", async () => {
    const h = harness();
    await h.feed(room({ match: match({ hand: [1, 2, 3] }) }));
    h.director.onBackground();
    h.director.onForeground();
    expect(h.cues).toEqual([]);
  });
});
