import type { AudioCategory, AudioDriver, AudioPlayOptions } from "./AudioManager.js";

/**
 * LayaAir 声音适配器。
 *
 * 资源不存在时由引擎静默失败，业务状态不受影响 —— 表现层永远不该因为一条音卡住牌局。
 *
 * 关于音量：`SoundManager` 只有 `musicVolume` / `soundVolume` **两档全局音量**，
 * 而设置页要音乐 / 音效 / 语音三档独立。所以这里不去动全局档位（`soundVolume` 留在 1），
 * 一律按**频道**写 `channel.volume`：新起的声音按当前分组音量起，已响的由 `setVolume`
 * 逐个改 —— 这样改语音音量不会顺带改到音效。
 */
export class LayaAudioDriver implements AudioDriver {
  private bgmPath: string | null = null;
  private bgmChannel: Laya.SoundChannel | null = null;
  private readonly volumes = new Map<AudioCategory, number>();
  private readonly channels = new Map<AudioCategory, Set<Laya.SoundChannel>>();

  play(path: string, options: AudioPlayOptions): void {
    this.volumes.set(options.category, options.volume);
    if (options.category === "bgm") {
      this.bgmPath = path;
      this.bgmChannel = Laya.SoundManager.playMusic(path, options.loop ? 0 : 1);
      this.applyVolume("bgm", this.bgmChannel);
      return;
    }
    const channel = Laya.SoundManager.playSound(path, options.loop ? 0 : 1);
    // 音源缺失时 playSound 可能返回 null：丢掉这一声就好，不补、不重试。
    if (channel) {
      this.applyVolume(options.category, channel);
      this.track(options.category, channel);
    }
  }

  /** 调**正在响**的那一组的音量；下一次播放用 `volumes` 里记下的同一档。 */
  setVolume(category: AudioCategory, volume: number): void {
    this.volumes.set(category, volume);
    if (category === "bgm") {
      this.applyVolume("bgm", this.bgmChannel);
      return;
    }
    for (const channel of this.channels.get(category) ?? []) channel.volume = volume;
  }

  stopCategory(category: AudioCategory): void {
    if (category === "bgm") {
      this.bgmPath = null;
      if (this.bgmChannel) this.bgmChannel.stop();
      this.bgmChannel = null;
      Laya.SoundManager.stopMusic();
    }
    for (const channel of this.channels.get(category) ?? []) channel.stop();
    this.channels.delete(category);
  }

  /** 只有 BGM 需要「暂停后可续」；短音效与语音切后台一律收掉。 */
  pauseCategory(category: AudioCategory): void {
    if (category !== "bgm") {
      this.stopCategory(category);
      return;
    }
    if (this.bgmChannel) this.bgmChannel.pause();
  }

  resumeCategory(category: AudioCategory): void {
    if (category !== "bgm" || this.bgmChannel === null) return;
    try {
      this.bgmChannel.resume();
    } catch {
      // 切后台期间频道被系统回收：按记下的路径重起一首。
      if (this.bgmPath) this.play(this.bgmPath, { loop: true, volume: this.volume("bgm"), category: "bgm" });
    }
  }

  private volume(category: AudioCategory): number {
    return this.volumes.get(category) ?? 1;
  }

  private applyVolume(category: AudioCategory, channel: Laya.SoundChannel | null): void {
    if (channel) channel.volume = this.volume(category);
  }

  private track(category: AudioCategory, channel: Laya.SoundChannel): void {
    // 每次起音前顺手清掉这一组里已响完的：一局长音短音几百条，不能只增不减。
    let channels = this.channels.get(category);
    if (!channels) {
      channels = new Set();
      this.channels.set(category, channels);
    }
    for (const item of channels) {
      if (item.isStopped) channels.delete(item);
    }
    channels.add(channel);
  }
}
