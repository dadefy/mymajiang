import type { AnimationPayload, SeatSide } from "./animation-spec.js";

export type AnimationCue =
  | "select-tile" | "discard" | "last-discard" | "draw" | "peng" | "kong" | "hu"
  | "win-pattern" | "score-float" | "turn-highlight" | "countdown-final"
  | "swap" | "choose-missing" | "round-finished" | "match-finished"
  /* 本轮补齐 */
  | "pass" | "action-buttons" | "trustee-on" | "trustee-off" | "screen-transition";

/** 动画事件的来源：`server` = 服务端已确认的状态；`local` = 玩家自己的即时反馈。 */
export type AnimationSource = "server" | "local";

export interface ConfirmedAnimation {
  /** 稳定标识：重连或重复渲染时同一条只放一次。由 `PresentationDirector` 合成。 */
  eventId: string;
  source: AnimationSource;
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
  /**
   * 持续态：当前出牌者的呼吸环（`null` = 收掉）。
   *
   * 它表示的是「此刻轮到谁」而不是「刚发生了什么」，所以不走 eventId 生命周期。
   */
  setActivePlayer?(side: SeatSide | null): void;
  /** 持续态：倒计时环。剩余或总时长为 `null` 时收掉。 */
  setCountdown?(seconds: number | null, totalSeconds: number | null): void;
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
  /** 本地反馈的序号（只用于造 id，不参与任何业务判断）。 */
  private localSeq = 0;

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

  /**
   * 服务端已确认的动画。`source` 不是 `server` 直接拒 —— 这条闸门是为了
   * 保证「动画播完的画面」与「服务端认定的牌桌」是同一副牌。
   */
  async playConfirmed(event: ConfirmedAnimation): Promise<boolean> {
    if (event.source !== "server") return false;
    if (event.snapshotRevision < this.latestRevision) return false;
    if (this.played.has(event.eventId)) return false;
    this.remember(event.eventId);
    return this.run(event.eventId, event.cue, event.payload, event.snapshotRevision, "server");
  }

  /**
   * 本地即时反馈：点了一张牌、切了一页。它**不假装**是服务端事件，
   * 所以自己造 id、不进已播表（一次点击就是一次反馈，本来就不该去重）。
   */
  playLocal(cue: AnimationCue, payload?: AnimationPayload): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    return this.run(`local:${cue}:${++this.localSeq}`, cue, payload, this.latestRevision, "local");
  }

  private async run(eventId: string, cue: AnimationCue, payload: AnimationPayload | undefined, revision: number, source: AnimationSource): Promise<boolean> {
    if (!this.enabled) return false;
    this.running.set(eventId, cue);
    try {
      await this.driver.play({ eventId, source, snapshotRevision: revision, cue, payload });
    } finally {
      this.running.delete(eventId);
    }
    return true;
  }

  /**
   * 持续态：当前出牌者的呼吸环。关掉动画时一律收掉，驱动没实现就当无事发生。
   */
  setActivePlayer(side: SeatSide | null): void {
    this.driver.setActivePlayer?.(this.enabled ? side : null);
  }

  /** 持续态：倒计时环（同上）。 */
  setCountdown(seconds: number | null, totalSeconds: number | null): void {
    if (!this.enabled) this.driver.setCountdown?.(null, null);
    else this.driver.setCountdown?.(seconds, totalSeconds);
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
    this.driver.setActivePlayer?.(null);
    this.driver.setCountdown?.(null, null);
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
