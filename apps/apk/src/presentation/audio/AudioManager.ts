export type AudioCategory = "bgm" | "sfx" | "voice" | "ui";

export type AudioCue =
  | "draw" | "discard" | "peng" | "kong" | "hu" | "self-draw" | "pass"
  | "swap" | "choose-missing" | "countdown-3" | "countdown-2" | "countdown-1"
  | "round-finished" | "match-finished" | "trustee" | "takeover" | "button";

export interface AudioSettings {
  musicEnabled: boolean;
  musicVolume: number;
  effectsEnabled: boolean;
  effectsVolume: number;
  voiceEnabled: boolean;
  voiceVolume: number;
  vibrationEnabled: boolean;
}

export interface AudioDriver {
  play(path: string, options: { loop: boolean; volume: number; category: AudioCategory }): void;
  stopCategory(category: AudioCategory): void;
  pauseCategory(category: AudioCategory): void;
  resumeCategory(category: AudioCategory): void;
}

export interface ConfirmedAudioEvent {
  /** 服务端帧或快照的稳定标识；用于去重重连后重复收到的帧。 */
  eventId: string;
  source: "server";
  cue: Exclude<AudioCue, "button">;
}

const DEFAULT_SETTINGS: AudioSettings = {
  musicEnabled: true, musicVolume: 0.55,
  effectsEnabled: true, effectsVolume: 0.8,
  voiceEnabled: true, voiceVolume: 1,
  vibrationEnabled: true,
};

const CUES: Record<AudioCue, { category: AudioCategory; path: string }> = {
  draw: { category: "sfx", path: "resources/audio/sfx/draw.mp3" },
  discard: { category: "sfx", path: "resources/audio/sfx/discard.mp3" },
  peng: { category: "voice", path: "resources/audio/voice/peng.mp3" },
  kong: { category: "voice", path: "resources/audio/voice/kong.mp3" },
  hu: { category: "voice", path: "resources/audio/voice/hu.mp3" },
  "self-draw": { category: "voice", path: "resources/audio/voice/self-draw.mp3" },
  pass: { category: "ui", path: "resources/audio/ui/pass.mp3" },
  swap: { category: "sfx", path: "resources/audio/sfx/swap.mp3" },
  "choose-missing": { category: "sfx", path: "resources/audio/sfx/choose-missing.mp3" },
  "countdown-3": { category: "ui", path: "resources/audio/ui/countdown.mp3" },
  "countdown-2": { category: "ui", path: "resources/audio/ui/countdown.mp3" },
  "countdown-1": { category: "ui", path: "resources/audio/ui/countdown.mp3" },
  "round-finished": { category: "sfx", path: "resources/audio/sfx/round-finished.mp3" },
  "match-finished": { category: "sfx", path: "resources/audio/sfx/match-finished.mp3" },
  trustee: { category: "ui", path: "resources/audio/ui/trustee.mp3" },
  takeover: { category: "ui", path: "resources/audio/ui/takeover.mp3" },
  button: { category: "ui", path: "resources/audio/ui/button.mp3" },
};

/** 只负责声音表现；不会发送 action，也不会推进或推测牌局状态。 */
export class AudioManager {
  private settings: AudioSettings = { ...DEFAULT_SETTINGS };
  private readonly playedEvents = new Set<string>();

  constructor(private readonly driver: AudioDriver) {}

  configure(settings: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  playBgm(path = "resources/audio/bgm/table.mp3"): void {
    if (!this.settings.musicEnabled) return;
    this.driver.stopCategory("bgm");
    this.driver.play(path, { loop: true, volume: this.settings.musicVolume, category: "bgm" });
  }

  playUi(cue: "button" | "pass"): void {
    this.playCue(cue);
  }

  playConfirmed(event: ConfirmedAudioEvent): boolean {
    if (event.source !== "server" || this.playedEvents.has(event.eventId)) return false;
    this.playedEvents.add(event.eventId);
    this.playCue(event.cue);
    return true;
  }

  onBackground(): void {
    this.driver.pauseCategory("bgm");
    this.driver.stopCategory("voice");
  }

  onForeground(): void {
    if (this.settings.musicEnabled) this.driver.resumeCategory("bgm");
  }

  get vibrationEnabled(): boolean { return this.settings.vibrationEnabled; }

  private playCue(cue: AudioCue): void {
    const resource = CUES[cue];
    const enabled = resource.category === "voice" ? this.settings.voiceEnabled
      : resource.category === "bgm" ? this.settings.musicEnabled : this.settings.effectsEnabled;
    if (!enabled) return;
    const volume = resource.category === "voice" ? this.settings.voiceVolume
      : resource.category === "bgm" ? this.settings.musicVolume : this.settings.effectsVolume;
    this.driver.play(resource.path, { loop: false, volume, category: resource.category });
  }
}
