import type { AnimationPayload } from "./animation-spec.js";

export type AnimationCue =
  | "select-tile" | "discard" | "last-discard" | "draw" | "peng" | "kong" | "hu"
  | "win-pattern" | "score-float" | "turn-highlight" | "countdown-final"
  | "swap" | "choose-missing" | "round-finished" | "match-finished"
  /* 本轮补齐 */
  | "pass" | "action-buttons" | "trustee-on" | "trustee-off" | "screen-transition";

export interface ConfirmedAnimation {
  /** 稳定标识：重连或重复渲染时同一条只放一次。由 `PresentationDirector` 合成。 */
  eventId: string;
  source: "server";
  /** 驱动这条动画时对应的快照序号；更晚的快照一到就该收手。 */
  snapshotRevision: number;
  cue: AnimationCue;
  payload?: AnimationPayload;
}

export interface AnimationDriver {
  play(event: ConfirmedAnimation): Promise<void>;
  /** 一律收掉：切后台、关动画、离开牌桌。 */
  cancelAll(): void;
  /**
   * 只收某一个事件名（可选）：新快照到来时打断**还在半路的位置类**动画，
   * 让碰/杠/胡这类强调一次放完，不被随后必然到来的 `actions` 帧截断。
   */
  cancelCue?(cue: AnimationCue): void;
  /** 释放覆盖层与已加载资源。 */
  dispose?(): void;
}

/**
 * 会被新快照打断的动画：它们表现的是「此刻的牌桌位置」，状态一更新就没意义了。
 *
 * 反过来说，`peng` / `kong` / `hu` / 结算 / 托管这些**强调类**不在这里 ——
 * 服务端确认之后必然还会再来一帧（actions、下一次快照），每次都把它们掐掉的话，
 * 玩家就永远看不到胡牌那一下。
 */
const TRANSIENT_CUES: ReadonlySet<AnimationCue> = new Set<AnimationCue>([
  "select-tile", "discard", "last-discard", "draw", "turn-highlight",
  "action-buttons", "swap", "choose-missing", "score-float",
]);

/** 已播事件 id 的容量：一局长局也就几百条，超出后淘汰最早的。 */
const PLAYED_CAP = 600;

/**
 * 动画只跟在已成立的服务端状态之后。
 *
 * 调用顺序固定：**先渲染最终 snapshot，再把表现事件交给这里**。
 * 新快照、切后台、关动画、页面销毁、中途取消都不改变最终 UI，也不发 action。
 */
export class AnimationCoordinator {
  private enabled = true;
  private latestRevision = -1;
  private readonly played = new Set<string>();
  /** 在途事件：eventId → cue，用于按事件名精确打断。 */
  private readonly running = new Map<string, AnimationCue>();

  constructor(private readonly driver: AnimationDriver) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelEverything();
  }

  get animationsEnabled(): boolean { return this.enabled; }

  get runningCount(): number { return this.running.size; }

  /** 收到新快照时调用：序号倒退的帧（重连时可能拿到）直接忽略。 */
  acceptSnapshot(revision: number): void {
    if (revision < this.latestRevision) return;
    if (revision > this.latestRevision) this.interruptTransient();
    this.latestRevision = revision;
  }

  /** 当前快照序号：`PresentationDirector` 用它保证自己不会拿旧帧发事件。 */
  get snapshotRevision(): number { return this.latestRevision; }

  async playConfirmed(event: ConfirmedAnimation): Promise<boolean> {
    if (!this.enabled || event.source !== "server") return false;
    if (event.snapshotRevision < this.latestRevision) return false;
    if (this.played.has(event.eventId)) return false;
    this.remember(event.eventId);
    this.running.set(event.eventId, event.cue);
    try {
      await this.driver.play(event);
    } finally {
      this.running.delete(event.eventId);
    }
    return true;
  }

  /** 切后台 / 离开牌桌：所有在途动画立刻收掉，但已播记录留着，回来不会重放。 */
  onBackground(): void { this.cancelEverything(); }

  /** 页面销毁：收动画，并放开播记录（下一次进房是另一副牌桌）。 */
  dispose(): void {
    this.cancelEverything();
    this.played.clear();
    this.driver.dispose?.();
  }

  private cancelEverything(): void {
    this.running.clear();
    this.driver.cancelAll();
  }

  /**
   * 新快照到来：只打断在途的**位置类**动画。
   *
   * 驱动没实现 `cancelCue` 时退化成全部收掉 —— 保守但不丢动画记录，
   * 结算屏仍然会在下一帧之后重新放出来（不同 eventId）。
   */
  private interruptTransient(): void {
    const transient = new Set<AnimationCue>();
    for (const cue of this.running.values()) {
      if (TRANSIENT_CUES.has(cue)) transient.add(cue);
    }
    if (transient.size === 0) return;
    if (!this.driver.cancelCue) {
      this.cancelEverything();
      return;
    }
    for (const cue of transient) {
      this.driver.cancelCue(cue);
      for (const [eventId, running] of this.running) {
        if (running === cue) this.running.delete(eventId);
      }
    }
  }

  private remember(eventId: string): void {
    this.played.add(eventId);
    if (this.played.size <= PLAYED_CAP) return;
    for (const stale of this.played) {
      this.played.delete(stale);
      if (this.played.size <= PLAYED_CAP * 0.8) break;
    }
  }
}
