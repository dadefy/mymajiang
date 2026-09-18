import { describe, expect, it } from "vitest";
import {
  AudioManager,
  normalizeCue,
  type AudioCategory,
  type AudioDriver,
  type AudioPlayOptions,
  type BgmTrack,
  type ConfirmedAudioEvent,
} from "../src/presentation/audio/AudioManager.js";

interface Playback {
  path: string;
  category: AudioCategory;
  volume: number;
  loop: boolean;
}

/**
 * 假驱动：把每一次调用记成一条**命令流水**（`"play:sfx:path"` / `"stop:bgm"` / `"volume:voice=1"`）。
 *
 * 断言看流水而不是只看最后状态，是因为「改语音音量有没有顺带改到音效」「换 BGM 前先没先收旧的」
 * 这类要求本来就是**顺序**问题。
 */
function harness(start = 1_000) {
  let now = start;
  const played: Playback[] = [];
  const log: string[] = [];
  const driver: AudioDriver = {
    play: (path, options: AudioPlayOptions) => {
      played.push({ path, ...options });
      log.push(`play:${options.category}:${path}@${options.volume}`);
    },
    stopCategory: (category) => { log.push(`stop:${category}`); },
    pauseCategory: (category) => { log.push(`pause:${category}`); },
    resumeCategory: (category) => { log.push(`resume:${category}`); },
    setVolume: (category, volume) => { log.push(`volume:${category}=${volume}`); },
  };
  const audio = new AudioManager(driver, () => now);
  return {
    audio,
    played,
    log,
    /** 推进假时钟：同名冷却 70ms、并发窗口 120ms 都靠它来稳定复现。 */
    advance(ms: number): void { now += ms; },
    /** 只保留播放记录，方便断言「这一声到底响了没有」。 */
    sounds: () => played.map((item) => item.path),
    soundsOf: (category: AudioCategory) => played.filter((item) => item.category === category).map((item) => item.path),
  };
}

/** 服务端确认事件：`cue` 收窄成规范名，测试里造非法来源时按同形状写。 */
function confirmed(eventId: string, cue: ConfirmedAudioEvent["cue"], source: string = "server"): ConfirmedAudioEvent {
  return { eventId, source: source as ConfirmedAudioEvent["source"], cue };
}

describe("事件词表与别名", () => {
  it("任务书那套语义名落到既有词表上，只有一份资源路径", () => {
    expect(normalizeCue("uiClick")).toBe("button");
    expect(normalizeCue("tileDraw")).toBe("draw");
    expect(normalizeCue("tileDiscard")).toBe("discard");
    expect(normalizeCue("gang")).toBe("kong");
    expect(normalizeCue("trusteeOn")).toBe("trustee");
    expect(normalizeCue("trusteeOff")).toBe("takeover");
    expect(normalizeCue("countdownWarning")).toBe("countdown-3");
    expect(normalizeCue("roundFinish")).toBe("round-finished");
    expect(normalizeCue("matchFinish")).toBe("match-finished");
    expect(normalizeCue("message")).toBe("messageReceive");
    // 规范名原样通过。
    expect(normalizeCue("peng")).toBe("peng");
  });

  it("别名与规范名放的是同一条资源", () => {
    const { audio, sounds, advance } = harness();
    audio.playUi("uiClick");
    advance(100);
    audio.playUi("button");
    expect(sounds()).toEqual([
      "resources/audio/ui/placeholder_click.wav",
      "resources/audio/ui/placeholder_click.wav",
    ]);
  });

  it("未登记的事件名不出声，也不会抛错", () => {
    const { audio, sounds } = harness();
    expect(audio.playConfirmed(confirmed("x", "not-a-cue" as ConfirmedAudioEvent["cue"]))).toBe(false);
    expect(sounds()).toEqual([]);
  });
});

describe("已播事件去重", () => {
  it("同一条服务端事件只响一次（重连回放的典型形状）", () => {
    const { audio, sounds } = harness();
    expect(audio.playConfirmed(confirmed("r1:peng:2", "peng"))).toBe(true);
    expect(audio.playConfirmed(confirmed("r1:peng:2", "peng"))).toBe(false);
    expect(sounds()).toEqual(["resources/audio/sfx/placeholder_peng.wav"]);
  });

  it("不同事件名即使同一毫秒也各响一次，同名才受冷却约束", () => {
    const { audio, sounds } = harness();
    audio.playConfirmed(confirmed("a", "peng"));
    audio.playConfirmed(confirmed("b", "kong"));
    expect(sounds()).toEqual([
      "resources/audio/sfx/placeholder_peng.wav",
      "resources/audio/sfx/placeholder_gang.wav",
    ]);
  });

  it("来源不是服务端的确认事件一律不放", () => {
    const { audio, sounds } = harness();
    expect(audio.playConfirmed(confirmed("local-only", "hu", "local"))).toBe(false);
    expect(sounds()).toEqual([]);
  });

  it("已播记录有上限：淘汰最早的那批，长局不会只增不减", () => {
    const { audio, sounds, advance } = harness();
    // 400 条容量、越过之后淘汰到 80%，所以前 320 条会被挤出记录。
    for (let i = 0; i < 401; i += 1) {
      advance(200);
      audio.playConfirmed(confirmed(`ev-${i}`, "discard"));
    }
    const before = sounds().length;
    expect(before).toBe(401);
    advance(200);
    expect(audio.playConfirmed(confirmed("ev-0", "discard"))).toBe(true);
    expect(sounds().length).toBe(before + 1);
  });
});

describe("防叠爆", () => {
  it("同一事件名 70ms 内连点只响一次", () => {
    const { audio, sounds, advance } = harness();
    audio.playUi("button");
    advance(50);
    audio.playUi("button");
    advance(30);
    audio.playUi("button");
    expect(sounds()).toEqual([
      "resources/audio/ui/placeholder_click.wav",
      "resources/audio/ui/placeholder_click.wav",
    ]);
  });

  // 第五条用的是普通音：胡/结算这类「大事」不吃这个上限（见下面那条），别混进来当陪衬。
  const ORDINARY = ["draw", "discard", "peng", "kong", "tileSelect"] as const;

  it("短窗口里最多四条：第五声丢掉，宁可不响也不炸耳", () => {
    const { audio, sounds } = harness();
    for (const cue of ORDINARY) audio.playConfirmed(confirmed(`burst:${cue}`, cue));
    expect(sounds().length).toBe(4);
  });

  it("过了窗口再来一批，照样响", () => {
    const { audio, sounds, advance } = harness();
    for (const cue of ORDINARY) audio.playConfirmed(confirmed(`b1:${cue}`, cue));
    advance(200);
    for (const cue of ORDINARY) audio.playConfirmed(confirmed(`b2:${cue}`, cue));
    expect(sounds().length).toBe(4 + 4);
  });

  it("整场结束不被前面四声挤掉，但同名冷却照旧", () => {
    const { audio, sounds, advance } = harness();
    for (const cue of ["draw", "discard", "peng", "kong"] as const) audio.playConfirmed(confirmed(`m:${cue}`, cue));
    expect(sounds().length).toBe(4);
    // 四家全托管时，最后两小场的结算音可以落在同一个 120 毫秒窗口里。
    audio.playConfirmed(confirmed("m:round", "round-finished"));
    audio.playConfirmed(confirmed("m:match", "match-finished"));
    expect(sounds().length).toBe(6);
    // 重放同一事件（换了 eventId 也算同一 cue）不该连着响两声整场结束。
    audio.playConfirmed(confirmed("m:match-again", "match-finished"));
    expect(sounds().length).toBe(6);
    advance(80);
    audio.playConfirmed(confirmed("m:match-later", "match-finished"));
    expect(sounds().length).toBe(7);
  });

  it("背景音乐不算进并发窗口：换场景不该被上一声牌音挤掉", () => {
    const { audio, log } = harness();
    for (const cue of ["draw", "discard", "peng", "kong"] as const) audio.playConfirmed(confirmed(`c:${cue}`, cue));
    audio.switchBgm("resources/audio/bgm/bgm_lobby.mp3");
    audio.switchBgm("resources/audio/bgm/bgm_game.mp3");
    expect(log.filter((line) => line.startsWith("play:bgm")).length).toBe(2);
  });
});

describe("音量分组", () => {
  it("三档滑杆各打各的组：动语音不会顺带动到音效", () => {
    const { audio, log } = harness();
    audio.setMusicVolume(0.4);
    audio.setSfxVolume(0.6);
    audio.setVoiceVolume(0.2);
    expect(log).toEqual([
      "volume:bgm=0.4",
      "volume:sfx=0.6",
      "volume:ui=0.6",
      "volume:voice=0.2",
    ]);
  });

  it("音量没变就不重复下发", () => {
    const { audio, log } = harness();
    audio.setSfxVolume(0.8);        // 默认就是 0.8
    expect(log).toEqual([]);
    audio.setSfxVolume(0.3);
    audio.setSfxVolume(0.3);
    expect(log).toEqual(["volume:sfx=0.3", "volume:ui=0.3"]);
  });

  it("滑杆越界只截断到 0..1，不把负数喂给引擎", () => {
    const { audio, log } = harness();
    audio.setMusicVolume(1.8);
    audio.setSfxVolume(-2);
    expect(log).toEqual(["volume:bgm=1", "volume:sfx=0", "volume:ui=0"]);
  });

  it("每一声按自己那一组的音量起，起音后改档位也照样带上", () => {
    const { audio, played } = harness();
    audio.setMusicVolume(0.3);
    audio.switchBgm("resources/audio/bgm/bgm_game.mp3");
    audio.playUi("button");
    audio.playVoice("runtime/voice/1.mp3");
    expect(played.map((item) => [item.category, item.volume])).toEqual([
      ["bgm", 0.3],
      ["ui", 0.8],
      ["voice", 1],
    ]);
  });
});

describe("分组开关", () => {
  it("关音效：牌面音与 UI 提示音都不响，语音照旧", () => {
    const { audio, soundsOf } = harness();
    audio.configure({ effectsEnabled: false });
    audio.playConfirmed(confirmed("s1", "peng"));
    audio.playUi("button");
    expect(soundsOf("sfx")).toEqual([]);
    expect(soundsOf("ui")).toEqual([]);
  });

  it("关语音：正在响的那条被收掉，运行时语音也不起", () => {
    const { audio, log, soundsOf } = harness();
    expect(audio.playVoice("runtime/voice/a.mp3")).toBe(true);
    audio.configure({ voiceEnabled: false });
    expect(log).toContain("stop:voice");
    expect(audio.playVoice("runtime/voice/b.mp3")).toBe(false);
    expect(soundsOf("voice")).toEqual(["runtime/voice/a.mp3"]);
  });

  it("报牌语音素材未就位：主音效照常响，不发起请求", () => {
    const { audio, sounds, soundsOf } = harness();
    expect(audio.playConfirmed(confirmed("hu:1", "hu"))).toBe(true);
    expect(sounds()).toEqual(["resources/audio/sfx/placeholder_hu.wav"]);
    expect(soundsOf("voice")).toEqual([]);
  });

  it("未授权语音不会因为静音被放开：总静音时连语音路径都不碰", () => {
    const { audio, soundsOf } = harness();
    audio.mute();
    expect(audio.playVoice("runtime/voice/x.mp3")).toBe(false);
    expect(soundsOf("voice")).toEqual([]);
  });
});

describe("总静音与背景音乐", () => {
  it("静音收掉正在响的 BGM 与语音，取消静音后按原曲恢复", () => {
    const { audio, log, soundsOf } = harness();
    audio.switchBgm("resources/audio/bgm/bgm_game.mp3");
    audio.mute();
    expect(log).toContain("stop:bgm");
    expect(log).toContain("stop:voice");
    audio.playConfirmed(confirmed("m1", "peng"));
    expect(soundsOf("sfx")).toEqual([]);
    const bgmBefore = soundsOf("bgm").length;
    audio.unmute();
    expect(soundsOf("bgm").length).toBe(bgmBefore + 1);
    expect(soundsOf("bgm")[soundsOf("bgm").length - 1]).toBe("resources/audio/bgm/bgm_game.mp3");
  });

  it("静音不改三档音量设置：取消静音后还是原值", () => {
    const { audio } = harness();
    audio.setMusicVolume(0.2);
    audio.setVoiceVolume(0.4);
    audio.mute();
    audio.unmute();
    const settings = audio.currentSettings;
    expect([settings.musicVolume, settings.voiceVolume, settings.masterMuted]).toEqual([0.2, 0.4, false]);
  });

  it("同一首不重放，换曲先收旧的", () => {
    const { audio, log, soundsOf } = harness();
    audio.switchBgm("resources/audio/bgm/bgm_lobby.mp3");
    audio.switchBgm("resources/audio/bgm/bgm_lobby.mp3");
    expect(soundsOf("bgm")).toEqual(["resources/audio/bgm/bgm_lobby.mp3"]);
    audio.switchBgm("resources/audio/bgm/bgm_game.mp3");
    expect(log).toEqual([
      "stop:bgm",
      "play:bgm:resources/audio/bgm/bgm_lobby.mp3@0.55",
      "stop:bgm",
      "play:bgm:resources/audio/bgm/bgm_game.mp3@0.55",
    ]);
  });

  it("背景音乐素材未就位：只记下该放哪一首，一声音都不发", () => {
    const { audio, soundsOf } = harness();
    for (const track of ["lobby", "waitingRoom", "game"] as BgmTrack[]) {
      expect(audio.playSceneBgm(track)).toBe(false);
      expect(audio.currentBgmTrack).toBe(track);
    }
    expect(soundsOf("bgm")).toEqual([]);
  });

  it("素材未就位时切场景也不会留下在响的旧曲", () => {
    const { audio, soundsOf } = harness();
    audio.switchBgm("resources/audio/bgm/bgm_game.mp3");
    expect(audio.playSceneBgm("lobby")).toBe(false);
    expect(soundsOf("bgm")).toEqual(["resources/audio/bgm/bgm_game.mp3"]);   // 只响过手动那一遍
    audio.playUi("button");
    expect(audio.playSceneBgm("waitingRoom")).toBe(false);
    // 上一首是手动起的，占位场景曲不能让它继续叠着响。
    expect(soundsOf("bgm")).toEqual(["resources/audio/bgm/bgm_game.mp3"]);
  });

  it("切后台只暂停音乐，短音与语音一律收掉；回前台续上", () => {
    const { audio, log } = harness();
    audio.switchBgm("resources/audio/bgm/bgm_game.mp3");
    audio.onBackground();
    expect(log).toContain("pause:bgm");
    expect(log).toContain("stop:voice");
    audio.onForeground();
    expect(log).toContain("resume:bgm");
  });

  it("销毁：四组全收，之后什么都不再响", () => {
    const { audio, log, sounds } = harness();
    audio.switchBgm("resources/audio/bgm/bgm_game.mp3");
    audio.dispose();
    expect(log).toEqual([
      "stop:bgm", "play:bgm:resources/audio/bgm/bgm_game.mp3@0.55",
      "stop:bgm", "stop:sfx", "stop:voice", "stop:ui",
    ]);
    audio.playConfirmed(confirmed("after-dispose", "peng"));
    audio.playUi("button");
    expect(audio.playVoice("runtime/voice/late.mp3")).toBe(false);
    expect(sounds().length).toBe(1);
  });

  it("销毁后重开一局：同一条事件不算历史，该响还得响", () => {
    const { audio } = harness();
    expect(audio.playConfirmed(confirmed("same", "peng"))).toBe(true);
    audio.dispose();
    const fresh = harness();
    expect(fresh.audio.playConfirmed(confirmed("same", "peng"))).toBe(true);
    // 上一实例的记录不影响这一实例。
    expect(fresh.sounds()).toEqual(["resources/audio/sfx/placeholder_peng.wav"]);
  });

  it("开关振动只改设置，不出声", () => {
    const { audio, sounds } = harness();
    audio.configure({ vibrationEnabled: false });
    expect(audio.vibrationEnabled).toBe(false);
    expect(sounds()).toEqual([]);
  });
});
