import { AnimationCoordinator } from "./animation/AnimationCoordinator.js";
import { LayaAnimationDriver } from "./animation/LayaAnimationDriver.js";
import { AudioManager } from "./audio/AudioManager.js";
import { LayaAudioDriver } from "./audio/LayaAudioDriver.js";
import { PresentationDirector } from "./PresentationDirector.js";
import { setTapSoundHook, TABLE_HEIGHT, TABLE_WIDTH } from "../ui/widgets.js";

/** 装配好的一整套表现层；页面只拿得到 director。 */
export interface Presentation {
  readonly director: PresentationDirector;
  readonly audio: AudioManager;
  readonly animations: AnimationCoordinator;
  /**
   * 动画覆盖层节点。
   *
   * 交出去只为了一个动作：在所有页面都挂上舞台之后 `addChild` 一次，把它提到最上层 ——
   * 否则它会成为第一个子节点，动画全被牌桌压在底下。
   */
  readonly overlayNode: Laya.Sprite;
  dispose(): void;
}

/**
 * 装配表现层：驱动 → 管理器 → 协调器 → director，一条链在**一个地方**接好。
 *
 * 为什么要单独一个函数：音效与动画的开关、音量分组、覆盖层生命周期都是全局的，
 * 散到各个页面就会出现「这个页面响了那个页面没响」。页面只该拿到 `director`，
 * 拿不到 `AudioManager` 与 `AnimationCoordinator` —— 那样才没法在业务代码里直接 `playSound`。
 *
 * 覆盖层挂在页面之上、`mouseThrough`，所以它不参与命中：动画在放，牌照样能出。
 */
export function createPresentation(parent: Laya.Sprite): Presentation {
  const audio = new AudioManager(new LayaAudioDriver());
  const driver = new LayaAnimationDriver(parent, TABLE_WIDTH, TABLE_HEIGHT);
  const animations = new AnimationCoordinator(driver);
  const director = new PresentationDirector({ audio, animations });
  // 按钮点音走 widgets 的钩子而不是让 widgets 直接 import 表现层：那边反过来提供了
  // THEME 与牌桌几何，直接引会成环；一个钩子也让「点击响一声」只有一处接线。
  setTapSoundHook(() => director.notifyUi("button"));
  return {
    director,
    audio,
    animations,
    overlayNode: driver.overlayNode,
    dispose() {
      setTapSoundHook(null);
      director.dispose();
    },
  };
}

/**
 * 设置页要的那组开关。
 *
 * 单独列出来是为了给 A1 / A2 一个**明确的能力面**：音乐、音效、语音三档音量 + 总静音 +
 * 动画开关，全部经由这里，不要在页面上直接摸 `Laya.SoundManager`。
 */
export interface PresentationControls {
  getSettings(): Readonly<{ musicVolume: number; effectsVolume: number; voiceVolume: number; masterMuted: boolean }>;
  setMusicVolume(value: number): void;
  setSfxVolume(value: number): void;
  setVoiceVolume(value: number): void;
  mute(): void;
  unmute(): void;
  setAnimationsEnabled(enabled: boolean): void;
}

export function presentationControls(presentation: Presentation): PresentationControls {
  const { audio, animations } = presentation;
  return {
    getSettings: () => audio.currentSettings,
    setMusicVolume: (value) => audio.setMusicVolume(value),
    setSfxVolume: (value) => audio.setSfxVolume(value),
    setVoiceVolume: (value) => audio.setVoiceVolume(value),
    mute: () => audio.mute(),
    unmute: () => audio.unmute(),
    setAnimationsEnabled: (enabled) => animations.setEnabled(enabled),
  };
}
