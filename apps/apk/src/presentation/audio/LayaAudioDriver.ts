import type { AudioCategory, AudioDriver } from "./AudioManager.js";

/** LayaAir 适配器。资源不存在时由引擎静默失败，业务状态不受影响。 */
export class LayaAudioDriver implements AudioDriver {
  private bgmPath: string | null = null;
  private readonly channels = new Map<AudioCategory, Set<Laya.SoundChannel>>();

  play(path: string, options: { loop: boolean; volume: number; category: AudioCategory }): void {
    if (options.category === "bgm") {
      this.bgmPath = path;
      Laya.SoundManager.musicVolume = options.volume;
      const channel = Laya.SoundManager.playMusic(path, options.loop ? 0 : 1);
      channel.volume = options.volume;
      this.track("bgm", channel);
      return;
    }
    const channel = Laya.SoundManager.playSound(path, options.loop ? 0 : 1);
    channel.volume = options.volume;
    this.track(options.category, channel);
  }

  stopCategory(category: AudioCategory): void {
    for (const channel of this.channels.get(category) ?? []) channel.stop();
    this.channels.delete(category);
  }

  pauseCategory(category: AudioCategory): void {
    if (category === "bgm") Laya.SoundManager.stopMusic();
  }

  resumeCategory(category: AudioCategory): void {
    if (category === "bgm" && this.bgmPath) Laya.SoundManager.playMusic(this.bgmPath, 0);
  }

  private track(category: AudioCategory, channel: Laya.SoundChannel): void {
    let channels = this.channels.get(category);
    if (!channels) {
      channels = new Set();
      this.channels.set(category, channels);
    }
    channels.add(channel);
  }
}
