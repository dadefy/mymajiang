import { describe, expect, it } from "vitest";
import {
  AnimationCoordinator,
  type AnimationDriver,
  type AnimationCue,
  type ConfirmedAnimation,
} from "../src/presentation/animation/AnimationCoordinator.js";
import type { SeatSide } from "../src/presentation/animation/animation-spec.js";

/** 一个手动了结的 promise：用来把动画「停在半路」。 */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Harness {
  readonly animations: AnimationCoordinator;
  /** 驱动实际收到的事件（含被打断的那些）。 */
  readonly received: ConfirmedAnimation[];
  /** 命令流水：`cancel:all` / `cancel-cue:peng` / `active:top` / `countdown:8/20` / `dispose`。 */
  readonly log: string[];
  /** 放行某一条在途动画。 */
  finish(eventId: string): void;
}

/**
 * 假动画驱动。
 *
 * `withCancelCue` 决定驱动有没有实现**精确打断**：没有时协调器必须退化成整体收掉，
 * 那条退化路径也得有测试盯着（真实 Laya 驱动实现了，将来换驱动不一定）。
 */
function harness(options: { withCancelCue?: boolean; hold?: boolean } = {}): Harness {
  const received: ConfirmedAnimation[] = [];
  const log: string[] = [];
  const gates = new Map<string, ReturnType<typeof gate>>();
  const driver: AnimationDriver = {
    play: (event) => {
      received.push(event);
      // 默认当场放完；只有要测「停在半路」的用例才挂起等 `finish`。
      if (!options.hold) return Promise.resolve();
      const item = gate();
      gates.set(event.eventId, item);
      return item.promise;
    },
    cancelAll: () => { log.push("cancel:all"); },
    setActivePlayer: (side) => { log.push(`active:${side}`); },
    setCountdown: (seconds, total) => { log.push(`countdown:${seconds}/${total}`); },
    dispose: () => { log.push("dispose"); },
  };
  if (options.withCancelCue !== false) {
    driver.cancelCue = (cue: AnimationCue) => { log.push(`cancel-cue:${cue}`); };
  }
  return {
    animations: new AnimationCoordinator(driver),
    received,
    log,
    finish: (eventId) => { gates.get(eventId)?.resolve(); },
  };
}

function server(eventId: string, cue: AnimationCue, snapshotRevision: number): ConfirmedAnimation {
  return { eventId, source: "server", snapshotRevision, cue };
}

describe("服务端确认闸门", () => {
  it("重连不重放同一条事件，旧快照的动画直接拒", async () => {
    const { animations } = harness();
    animations.acceptSnapshot(10);
    expect(await animations.playConfirmed(server("discard:10", "discard", 10))).toBe(true);
    expect(await animations.playConfirmed(server("discard:10", "discard", 10))).toBe(false);
    animations.acceptSnapshot(11);
    expect(await animations.playConfirmed(server("late", "peng", 10))).toBe(false);
  });

  it("序号倒退的快照不推进水位（重连先拿到旧帧）", async () => {
    const { animations, log } = harness();
    animations.acceptSnapshot(5);
    animations.acceptSnapshot(3);
    expect(animations.snapshotRevision).toBe(5);
    expect(log).toEqual([]);
    expect(await animations.playConfirmed(server("ok", "peng", 5))).toBe(true);
  });

  it("本地事件不能冒充服务端事件（动画必须跟着已成立的状态）", async () => {
    const { animations, received } = harness();
    expect(await animations.playConfirmed({ ...server("fake", "hu", 0), source: "local" })).toBe(false);
    expect(received).toEqual([]);
  });
});

describe("可取消", () => {
  it("新快照只打断在途的位置类动画，强调类放完", async () => {
    const { animations, log } = harness({ hold: true });
    animations.acceptSnapshot(1);
    void animations.playConfirmed(server("sel", "select-tile", 1));
    void animations.playConfirmed(server("peng", "peng", 1));
    expect(animations.runningCount).toBe(2);
    animations.acceptSnapshot(2);
    expect(log).toEqual(["cancel-cue:select-tile"]);
    expect(animations.runningCount).toBe(1);
  });

  it("没有在途位置类动画时不打断，强调类不受新快照影响", async () => {
    const { animations, log } = harness({ hold: true });
    animations.acceptSnapshot(1);
    void animations.playConfirmed(server("hu", "hu", 1));
    animations.acceptSnapshot(2);
    animations.acceptSnapshot(3);
    expect(log).toEqual([]);
    expect(animations.runningCount).toBe(1);
  });

  it("驱动没实现精确打断时退化成整体收掉", async () => {
    const { animations, log } = harness({ withCancelCue: false });
    animations.acceptSnapshot(1);
    void animations.playConfirmed(server("draw", "draw", 1));
    animations.acceptSnapshot(2);
    expect(log).toEqual(["cancel:all", "active:null", "countdown:null/null"]);
    expect(animations.runningCount).toBe(0);
  });

  it("关掉动画：在途与持续态一起收，且之后什么都不再放", async () => {
    const { animations, log, received } = harness({ hold: true });
    animations.acceptSnapshot(1);
    animations.setActivePlayer("top");
    animations.setCountdown(7, 20);
    void animations.playConfirmed(server("draw", "draw", 1));
    animations.setEnabled(false);
    expect(animations.animationsEnabled).toBe(false);
    expect(animations.runningCount).toBe(0);
    expect(log).toEqual(["active:top", "countdown:7/20", "cancel:all", "active:null", "countdown:null/null"]);
    expect(await animations.playConfirmed(server("peng", "peng", 1))).toBe(false);
    expect(await animations.playLocal("pass")).toBe(false);
    expect(received.map((event) => event.eventId)).toEqual(["draw"]);
  });

  it("重新打开动画后照常工作", async () => {
    const { animations } = harness();
    animations.setEnabled(false);
    animations.setEnabled(true);
    expect(await animations.playLocal("screen-transition")).toBe(true);
  });

  it("切后台收干净在途动画，但已播记录留着 —— 回前台不重放", async () => {
    const { animations } = harness({ hold: true });
    animations.acceptSnapshot(1);
    void animations.playConfirmed(server("kong", "kong", 1));
    animations.onBackground();
    expect(animations.runningCount).toBe(0);
    expect(await animations.playConfirmed(server("kong", "kong", 1))).toBe(false);
  });
});

describe("持续态转发", () => {
  it("当前出牌者与倒计时按调用原样下发", () => {
    const { animations, log } = harness();
    animations.setActivePlayer("left");
    animations.setCountdown(3, 15);
    animations.setActivePlayer(null);
    expect(log).toEqual(["active:left", "countdown:3/15", "active:null"]);
  });

  it("关掉动画时持续态一律收掉，而不是留着那个还在呼吸的环", () => {
    const { animations, log } = harness();
    animations.setEnabled(false);
    animations.setActivePlayer("bottom");
    animations.setCountdown(9, 20);
    // `setEnabled(false)` 当场整体收一次，之后即便页面还在按帧推持续态，下发的也只会是 null。
    expect(log).toEqual([
      "cancel:all", "active:null", "countdown:null/null",
      "active:null", "countdown:null/null",
    ]);
  });
});

describe("本地即时反馈", () => {
  it("连点两次是两次反馈，不去重", async () => {
    const { animations, received } = harness();
    expect(await animations.playLocal("select-tile", { handIndex: 3 })).toBe(true);
    expect(await animations.playLocal("select-tile", { handIndex: 3 })).toBe(true);
    expect(received.map((event) => event.source)).toEqual(["local", "local"]);
    expect(received[0].eventId).not.toBe(received[1].eventId);
    expect(received[0].payload).toEqual({ handIndex: 3 });
  });

  it("本地动画按当前快照序号发，驱动收到的事件带得上来源", async () => {
    const { animations, received } = harness();
    animations.acceptSnapshot(7);
    const side: SeatSide = "right";
    await animations.playLocal("pass", { side });
    expect(received[received.length - 1]).toMatchObject({ source: "local", snapshotRevision: 7, cue: "pass" });
  });
});

describe("销毁", () => {
  it("页面销毁后动画不再跑，覆盖层被释放", async () => {
    const { animations, log, received } = harness({ hold: true });
    animations.acceptSnapshot(1);
    void animations.playConfirmed(server("peng", "peng", 1));
    animations.dispose();
    expect(log).toEqual(["cancel:all", "active:null", "countdown:null/null", "dispose"]);
    expect(animations.runningCount).toBe(0);
    expect(await animations.playConfirmed(server("peng2", "peng", 1))).toBe(false);
    expect(await animations.playLocal("screen-transition")).toBe(false);
    animations.setActivePlayer("top");
    animations.setCountdown(1, 20);
    // 销毁之后驱动再收到任何一条播放/持续态指令都算泄漏。
    expect(received.length).toBe(1);
    expect(log.length).toBe(4);
  });

  it("销毁后再建新协调器是另一副牌桌：同名事件照样能放", async () => {
    const first = harness();
    await first.animations.playConfirmed(server("same", "hu", 0));
    first.animations.dispose();
    const second = harness();
    expect(await second.animations.playConfirmed(server("same", "hu", 0))).toBe(true);
  });
});

describe("在途计数", () => {
  it("动画放完自己从在途表里退出去", async () => {
    const { animations, finish } = harness({ hold: true });
    animations.acceptSnapshot(1);
    const running = animations.playConfirmed(server("discard", "discard", 1));
    expect(animations.runningCount).toBe(1);
    finish("discard");
    await running;
    expect(animations.runningCount).toBe(0);
  });

  it("已播记录有上限：淘汰最早的一批，长局不会只增不减", async () => {
    const { animations } = harness();
    animations.acceptSnapshot(1);
    for (let i = 0; i < 601; i += 1) {
      // 每条都当场放完，避免在途表堆积掩盖真正要测的记录表。
      await animations.playConfirmed(server(`ev-${i}`, "discard", 1));
    }
    expect(await animations.playConfirmed(server("ev-0", "discard", 1))).toBe(true);
    expect(await animations.playConfirmed(server("ev-600", "discard", 1))).toBe(false);
  });
});
