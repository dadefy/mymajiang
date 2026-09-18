export type AudioCategory = "bgm" | "sfx" | "voice" | "ui";

/**
 * 声音事件名。
 *
 * 词表沿用 `feature/laya-client` 上已存在并被测试引用的命名（`draw` / `discard` / `kong`
 * / `button` …），**不做破坏性重命名**。任务书那套语义名（`tile_draw`、`gang`、`ui_click`）
 * 通过下面的别名表落进来，对照关系见 `docs/LAYA_APK_AUDIO_ANIMATION.md`，
 * 后续所有 AI 按那张表理解，不再各自发明新名字。
 */
export type AudioCue =
  /* 既有 */
  | "draw" | "discard" | "peng" | "kong" | "hu" | "self-draw" | "pass"
  | "swap" | "choose-missing" | "countdown-3" | "countdown-2" | "countdown-1"
  | "round-finished" | "match-finished" | "trustee" | "takeover" | "button"
  /* 本轮补齐 */
  | "uiBack" | "tileSelect" | "turnNotify" | "messageReceive";

/** 别名 → 规范名。两边都接受，只有一份资源、一条路径契约。 */
const CUE_ALIASES = {
  uiClick: "button",
  tileDraw: "draw",
  tilePick: "draw",
  tileDiscard: "discard",
  gang: "kong",
  trusteeOn: "trustee",
  trusteeOff: "takeover",
  countdownWarning: "countdown-3",
  roundFinish: "round-finished",
  matchFinish: "match-finished",
  message: "messageReceive",
} as const satisfies Record<string, AudioCue>;

/** 只给本地即时反馈用的事件（不经服务端，不参与 eventId 去重）。 */
export type UiCue =
  | "button" | "uiClick" | "uiBack" | "tileSelect" | "pass" | "turnNotify" | "messageReceive";

/** 允许出现的声音事件名：规范名 + 别名。 */
export type AudioCueInput = AudioCue | keyof typeof CUE_ALIASES;

/** 归一化事件名；未登记的名字原样交给 `CUES` 查表兜住。 */
export function normalizeCue(cue: AudioCueInput): AudioCue {
  return (CUE_ALIASES as Record<string, AudioCue | undefined>)[cue] ?? (cue as AudioCue);
}

export interface AudioSettings {
  musicEnabled: boolean;
  musicVolume: number;
  effectsEnabled: boolean;
  effectsVolume: number;
  voiceEnabled: boolean;
  voiceVolume: number;
  vibrationEnabled: boolean;
  /** 总静音：不动三组各自的音量，取消静音后按原值恢复。 */
  masterMuted: boolean;
}

export interface AudioResource {
  category: AudioCategory;
  path: string;
  /** 素材是否已就位。缺省 true；`false` 表示路径已约定但文件还没有，不发起播放。 */
  ready?: boolean;
}

export interface AudioPlayOptions {
  loop: boolean;
  volume: number;
  category: AudioCategory;
}

export interface AudioDriver {
  play(path: string, options: AudioPlayOptions): void;
  stopCategory(category: AudioCategory): void;
  pauseCategory(category: AudioCategory): void;
  resumeCategory(category: AudioCategory): void;
  /**
   * 调节**正在播放**的音量。可选：不实现时音量只对下一声生效。
   *
   * Laya 的 `SoundManager.musicVolume` / `soundVolume` 是全局的，能立刻作用到当前频道 ——
   * 设置页拖动滑杆要靠它，而不是等下一声才听出变化。
   */
  setVolume?(category: AudioCategory, volume: number): void;
}

/** 由服务端确认帧驱动的事件：必须带稳定标识，见 `PresentationDirector` 合成 eventId 那段。 */
export interface ConfirmedAudioEvent {
  eventId: string;
  source: "server";
  cue: Exclude<AudioCueInput, UiCue>;
}

const DEFAULT_SETTINGS: AudioSettings = {
  musicEnabled: true, musicVolume: 0.55,
  effectsEnabled: true, effectsVolume: 0.8,
  voiceEnabled: true, voiceVolume: 1,
  vibrationEnabled: true,
  masterMuted: false,
};

/**
 * 事件 → 资源。
 *
 * `ready: false` 的行**故意不放文件**：报牌语音（喊「碰！」「胡！」）要真人录音、
 * 还要男女声与方言版本，素材未授权前点了只会 404，所以只在表里占位，不播。
 * 碰/杠/胡/自摸这一轮先靠**强调音效**给手感 —— 它们归在音效组，音量与语音各自独立。
 */
const CUES: Record<AudioCue, AudioResource> = {
  draw: { category: "sfx", path: "resources/audio/sfx/placeholder_tile_draw.wav" },
  discard: { category: "sfx", path: "resources/audio/sfx/placeholder_tile_discard.wav" },
  peng: { category: "sfx", path: "resources/audio/sfx/placeholder_peng.wav" },
  kong: { category: "sfx", path: "resources/audio/sfx/placeholder_gang.wav" },
  hu: { category: "sfx", path: "resources/audio/sfx/placeholder_hu.wav" },
  "self-draw": { category: "sfx", path: "resources/audio/sfx/placeholder_self_draw.wav" },
  pass: { category: "ui", path: "resources/audio/ui/placeholder_pass.wav" },
  swap: { category: "sfx", path: "resources/audio/sfx/placeholder_swap.wav" },
  "choose-missing": { category: "sfx", path: "resources/audio/sfx/placeholder_choose_missing.wav" },
  "countdown-3": { category: "ui", path: "resources/audio/ui/placeholder_countdown.wav" },
  "countdown-2": { category: "ui", path: "resources/audio/ui/placeholder_countdown.wav" },
  "countdown-1": { category: "ui", path: "resources/audio/ui/placeholder_countdown_fast.wav" },
  "round-finished": { category: "sfx", path: "resources/audio/sfx/placeholder_round_finished.wav" },
  "match-finished": { category: "sfx", path: "resources/audio/sfx/placeholder_match_finished.wav" },
  trustee: { category: "ui", path: "resources/audio/ui/placeholder_trustee_on.wav" },
  takeover: { category: "ui", path: "resources/audio/ui/placeholder_trustee_off.wav" },
  button: { category: "ui", path: "resources/audio/ui/placeholder_click.wav" },
  uiBack: { category: "ui", path: "resources/audio/ui/placeholder_back.wav" },
  tileSelect: { category: "sfx", path: "resources/audio/sfx/placeholder_tile_select.wav" },
  turnNotify: { category: "ui", path: "resources/audio/ui/placeholder_turn_notify.wav" },
  messageReceive: { category: "ui", path: "resources/audio/ui/placeholder_message.wav" },
};

/**
 * 报牌语音占位：素材到位后把 `ready` 打开，并由 `PresentationDirector` 在碰/杠/胡
 * 事件上与强调音效一起触发。音量走语音组。
 */
const VOICE_ANNOUNCEMENTS: Partial<Record<AudioCue, AudioResource>> = {
  peng: { category: "voice", path: "resources/audio/voice/peng.mp3", ready: false },
  kong: { category: "voice", path: "resources/audio/voice/kong.mp3", ready: false },
  hu: { category: "voice", path: "resources/audio/voice/hu.mp3", ready: false },
  "self-draw": { category: "voice", path: "resources/audio/voice/self-draw.mp3", ready: false },
};

/**
 * 同一事件名的最短间隔。
 *
 * 连点选牌、连点按钮时不该听到一串哒哒声。只对**同一个 cue** 生效 ——
 * 碰完紧接着胡牌是两回事，不该被压掉。
 */
const SAME_CUE_COOLDOWN_MS = 70;
/**
 * 短窗口内最多放几条非 BGM 音。
 *
 * 防的是「几家几乎同时出牌 + 一条语音 + 结算音」挤成一团炸耳。超了就丢：
 * 表现层少响一声，远好过玩家听不清谁在动。
 */
const BURST_LIMIT = 4;
const BURST_WINDOW_MS = 120;
/** 已播 eventId 容量：一小场几十条足够，设上限防长局内存泄漏。 */
const PLAYED_EVENTS_CAP = 400;

/** 只负责声音表现；不发 action，也不推进或推测牌局状态。 */
export class AudioManager {
  private settings: AudioSettings = { ...DEFAULT_SETTINGS };
  /** 插入序即时间序，超上限从头淘汰 —— 重连只会回放最近几帧，留着就够。 */
  private readonly playedEvents = new Set<string>();
  private readonly lastCueAt = new Map<string, number>();
  private burstAt: number[] = [];
  private bgmPath: string | null = null;

  constructor(
    private readonly driver: AudioDriver,
    private readonly now: () => number = () => Date.now(),
  ) {}

  configure(settings: Partial<AudioSettings>): void {
    const previous = this.settings;
    this.settings = { ...this.settings, ...settings };
    if (this.settings.musicVolume !== previous.musicVolume) this.driver.setVolume?.("bgm", this.settings.musicVolume);
    if (this.settings.effectsVolume !== previous.effectsVolume) {
      this.driver.setVolume?.("sfx", this.settings.effectsVolume);
      this.driver.setVolume?.("ui", this.settings.effectsVolume);
    }
    if (this.settings.voiceVolume !== previous.voiceVolume) this.driver.setVolume?.("voice", this.settings.voiceVolume);
    if (!this.settings.musicEnabled && previous.musicEnabled) this.driver.stopCategory("bgm");
    if (!this.settings.voiceEnabled && previous.voiceEnabled) this.driver.stopCategory("voice");
    if (this.settings.masterMuted) {
      this.driver.stopCategory("bgm");
      this.driver.stopCategory("voice");
    }
  }

  get currentSettings(): Readonly<AudioSettings> {
    return { ...this.settings };
  }

  setMusicVolume(volume: number): void { this.configure({ musicVolume: clamp01(volume) }); }

  /** 音效组（UI 反馈音也算在这一栏，设置页上只有「音效」一条滑杆）。 */
  setSfxVolume(volume: number): void { this.configure({ effectsVolume: clamp01(volume) }); }

  setVoiceVolume(volume: number): void { this.configure({ voiceVolume: clamp01(volume) }); }

  get muted(): boolean { return this.settings.masterMuted; }

  /** 总静音：收掉正在响的 BGM 与语音，但不改三组各自的音量设置。 */
  mute(): void {
    if (this.settings.masterMuted) return;
    this.configure({ masterMuted: true });
  }

  unmute(): void {
    if (!this.settings.masterMuted) return;
    this.settings = { ...this.settings, masterMuted: false };
    if (this.bgmPath) this.playBgm(this.bgmPath);
  }

  playBgm(path = "resources/audio/bgm/table.mp3"): void {
    this.switchBgm(path);
  }

  /** 换 BGM 前先收掉旧的，避免两个场景的音乐叠着放。同一首不重放。 */
  switchBgm(path: string): void {
    if (this.bgmPath === path && this.audible("bgm")) return;
    this.bgmPath = path;
    this.driver.stopCategory("bgm");
    if (!this.audible("bgm")) return;
    this.driver.play(path, { loop: true, volume: this.settings.musicVolume, category: "bgm" });
  }

  stopBgm(): void {
    this.bgmPath = null;
    this.driver.stopCategory("bgm");
  }

  playUi(cue: UiCue): boolean {
    return this.request(cue);
  }

  playConfirmed(event: ConfirmedAudioEvent): boolean {
    if (event.source !== "server" || this.playedEvents.has(event.eventId)) return false;
    this.rememberEvent(event.eventId);
    return this.request(event.cue);
  }

  /**
   * 播放一条**运行时**语音（用户录音），走语音组的音量与开关。
   *
   * 语音不是预置素材：仓库里没有、也不该有一条「示例语音」当正式资源。
   */
  playVoice(path: string): boolean {
    if (!path || !this.audible("voice")) return false;
    if (!this.allow("voice")) return false;
    this.driver.play(path, { loop: false, volume: this.settings.voiceVolume, category: "voice" });
    return true;
  }

  onBackground(): void {
    this.driver.pauseCategory("bgm");
    this.driver.stopCategory("voice");
  }

  onForeground(): void {
    if (this.bgmPath && this.audible("bgm")) this.driver.resumeCategory("bgm");
  }

  /** 离开牌桌 / 页面销毁：收干净，别留一条没停的 BGM。 */
  dispose(): void {
    this.bgmPath = null;
    this.driver.stopCategory("bgm");
    this.driver.stopCategory("sfx");
    this.driver.stopCategory("voice");
    this.driver.stopCategory("ui");
    this.playedEvents.clear();
    this.lastCueAt.clear();
    this.burstAt = [];
  }

  get vibrationEnabled(): boolean { return this.settings.vibrationEnabled; }

  private rememberEvent(eventId: string): void {
    this.playedEvents.add(eventId);
    if (this.playedEvents.size <= PLAYED_EVENTS_CAP) return;
    for (const stale of this.playedEvents) {
      this.playedEvents.delete(stale);
      if (this.playedEvents.size <= PLAYED_EVENTS_CAP * 0.8) break;
    }
  }

  /**
   * 该不该响这一声：分组开关与总静音 → 同名冷却 → 并发窗口。
   *
   * 一个事件最多两层：**主资源**（牌面音效 / UI 提示音）与**同事件的报牌语音**。
   * 两层各过一遍闸门，谁被丢掉都不影响另一层 —— 语音素材还没授权时，主资源照常响。
   */
  private request(cue: AudioCueInput): boolean {
    const name = normalizeCue(cue);
    const primary = CUES[name];
    if (!primary) return false;
    let played = false;
    if (this.playLayer(name, primary)) played = true;
    const announcement = VOICE_ANNOUNCEMENTS[name];
    if (announcement && this.playLayer(`${name}:voice`, announcement)) played = true;
    return played;
  }

  private playLayer(gateKey: string, resource: AudioResource): boolean {
    if (resource.ready === false) return false;
    if (!this.audible(resource.category)) return false;
    if (!this.allow(gateKey)) return false;
    this.driver.play(resource.path, {
      loop: false,
      volume: resource.category === "voice" ? this.settings.voiceVolume
        : resource.category === "bgm" ? this.settings.musicVolume : this.settings.effectsVolume,
      category: resource.category,
    });
    return true;
  }

  private audible(category: AudioCategory): boolean {
    if (this.settings.masterMuted) return false;
    if (category === "voice") return this.settings.voiceEnabled;
    if (category === "bgm") return this.settings.musicEnabled;
    return this.settings.effectsEnabled;
  }

  private allow(cue: string): boolean {
    const at = this.now();
    const previous = this.lastCueAt.get(cue);
    if (previous !== undefined && at - previous < SAME_CUE_COOLDOWN_MS) return false;
    const recent = this.burstAt.filter((time) => at - time < BURST_WINDOW_MS);
    if (recent.length >= BURST_LIMIT) return false;
    this.lastCueAt.set(cue, at);
    recent.push(at);
    this.burstAt = recent;
    return true;
  }
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}
