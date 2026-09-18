export type AnimationCue =
  | "select-tile" | "discard" | "last-discard" | "draw" | "peng" | "kong" | "hu"
  | "win-pattern" | "score-float" | "turn-highlight" | "countdown-final"
  | "swap" | "choose-missing" | "round-finished" | "match-finished";

export interface ConfirmedAnimation {
  eventId: string;
  source: "server";
  snapshotRevision: number;
  cue: AnimationCue;
  payload?: Readonly<Record<string, unknown>>;
}

export interface AnimationDriver {
  play(event: ConfirmedAnimation): Promise<void>;
  cancelAll(): void;
}

/**
 * 动画只跟在已成立的服务端状态之后。新快照、切后台或关闭动画都可直接取消；
 * 调用方必须先渲染最终 snapshot，再把表现事件交给本类。
 */
export class AnimationCoordinator {
  private enabled = true;
  private latestRevision = -1;
  private readonly played = new Set<string>();

  constructor(private readonly driver: AnimationDriver) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.driver.cancelAll();
  }

  acceptSnapshot(revision: number): void {
    if (revision < this.latestRevision) return;
    if (revision > this.latestRevision) this.driver.cancelAll();
    this.latestRevision = revision;
  }

  async playConfirmed(event: ConfirmedAnimation): Promise<boolean> {
    if (!this.enabled || event.source !== "server" || event.snapshotRevision < this.latestRevision || this.played.has(event.eventId)) return false;
    this.played.add(event.eventId);
    await this.driver.play(event);
    return true;
  }

  onBackground(): void { this.driver.cancelAll(); }
}
