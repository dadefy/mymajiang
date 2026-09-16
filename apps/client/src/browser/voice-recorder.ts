import { MAX_VOICE_SECONDS } from "../flow.js";

/**
 * 录一段语音（浏览器实现）。
 *
 * 放在 `browser/` 与三个传输适配器同一层：它是**运行环境相关**的能力，
 * 业务层（`ClientFlow`）只认「一段字节 + 类型 + 时长」，不关心声音怎么录出来的。
 *
 * 与选图（`apps/apk/src/ui/file-picker.ts`）不同的是，录音用的是**标准 Web API**
 * （`navigator.mediaDevices` + `MediaRecorder`），H5 与 LayaAir 的 Web 构建下完全一样，
 * 所以这一份实现两边共用 —— 而 LayaAir 的网络 API 是引擎特有的，才必须在 apk 里另写。
 *
 * 环境限制：
 * - **只在安全上下文里能拿到麦克风权限**（HTTPS 或 localhost）。用 `http://<IP>`
 *   打开页面时 `getUserMedia` 会直接失败，这不是代码问题，页面会把提示显示出来。
 * - 打包成原生 APK 时没有 `MediaRecorder`，`start()` 抛错，页面提示「录不了音」——
 *   和选图在原生环境下退化成「发不了图」是同一类限制。
 */

export interface RecordedVoice {
  bytes: Uint8Array;
  /** 已经去掉 `;codecs=…` 后缀，见 `normalizedAudioType`。 */
  contentType: string;
  /** 录音时长（秒），服务端按 1–60 校验。 */
  seconds: number;
}

export interface VoiceRecorder {
  /** 申请麦克风并开始录音；环境不支持或用户拒绝授权时抛错。 */
  start(): Promise<void>;
  /** 停止并取回结果；一秒钟都没录到时返回 undefined。 */
  stop(): Promise<RecordedVoice | undefined>;
  /** 放弃这次录音（离开页面时用），不上传也不保留。 */
  cancel(): void;
  /** 已经录了多少秒，用于界面显示与自动停止。 */
  elapsedSeconds(): number;
}

/**
 * 把录音时长换算成整数秒，并夹到 1–`MAX_VOICE_SECONDS`。
 *
 * 服务端只收 1–60 的整数秒：不足 1 秒的按 1 秒算（用户确实按下了按钮），
 * 超过上限的按上限算（界面上到点就会自动停止）。
 */
export function clampSeconds(elapsedMs: number): number {
  return Math.min(MAX_VOICE_SECONDS, Math.max(1, Math.round(elapsedMs / 1000)));
}

/**
 * 取基础音频类型。
 *
 * `MediaRecorder.mimeType` 会带上编码参数（`audio/webm;codecs=opus`），
 * 而服务端是按**精确值**比对白名单的 —— 不截掉 `;` 之后的部分会被直接拒收。
 * 完全取不到类型时按 webm 兜底（Chrome / Edge 的默认输出）。
 */
export function normalizedAudioType(mimeType: string): string {
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return base.length > 0 ? base : "audio/webm";
}

export class BrowserVoiceRecorder implements VoiceRecorder {
  private recorder: MediaRecorder | undefined;
  private stream: MediaStream | undefined;
  private chunks: Blob[] = [];
  private startedAt = 0;

  async start(): Promise<void> {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("RECORDING_UNSUPPORTED");
    }
    // 用户拒绝授权也会在这里抛错，交给页面提示。
    this.stream = await media.getUserMedia({ audio: true });
    this.chunks = [];
    const recorder = new MediaRecorder(this.stream);
    recorder.addEventListener("dataavailable", (event) => this.chunks.push(event.data));
    this.recorder = recorder;
    this.startedAt = Date.now();
    recorder.start();
  }

  elapsedSeconds(): number {
    if (this.startedAt === 0) return 0;
    return Math.min(MAX_VOICE_SECONDS, Math.floor((Date.now() - this.startedAt) / 1000));
  }

  async stop(): Promise<RecordedVoice | undefined> {
    const recorder = this.recorder;
    if (!recorder) return undefined;
    const seconds = clampSeconds(Date.now() - this.startedAt);
    const contentType = normalizedAudioType(recorder.mimeType);
    // 最后一块数据是在 stop 之后才回调的，所以等 stop 事件到齐再拼。
    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });
    recorder.stop();
    await stopped;
    const chunks = this.chunks;
    this.reset();
    const blob = new Blob(chunks, { type: contentType });
    if (blob.size === 0) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, contentType, seconds };
  }

  cancel(): void {
    this.recorder?.stop();
    this.reset();
  }

  /** 收拾干净：关掉麦克风轨道，否则系统的「正在使用麦克风」提示会一直亮着。 */
  private reset(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.recorder = undefined;
    this.chunks = [];
    this.startedAt = 0;
  }
}
