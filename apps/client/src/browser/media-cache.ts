/**
 * 图片与语音的本地缓存。
 *
 * 为什么需要它：服务端给图片/语音签发的读取地址**只有几十秒有效期**（私有桶只能靠签名读），
 * 而消息一旦画到页面上就会一直留在那儿 —— 直接拿那个地址去渲染，过一会儿就变成裂图。
 * 所以第一次加载就把它抓成本地 blob 地址，之后就与签名过期无关了。
 *
 * 加载**按需触发**：`resolve()` 第一次调用开始下载并返回 `loading`，完成或失败时通过
 * `onChange` 通知渲染层重画（渲染层自己决定重画哪一块）。
 *
 * 下载与 URL 的创建/释放都是注入的，所以这里没有任何浏览器依赖，能直接测。
 */
export type MediaState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };

export interface MediaCacheOptions {
  /** 下载实现。浏览器把 `fetch` 包一层；测试注入可控的假实现。 */
  load: (sourceUrl: string) => Promise<Blob>;
  toObjectUrl?: (blob: Blob) => string;
  releaseObjectUrl?: (url: string) => void;
}

export class MediaCache {
  private readonly entries = new Map<string, MediaState>();
  private readonly listeners = new Set<() => void>();
  private readonly toObjectUrl: (blob: Blob) => string;
  private readonly releaseObjectUrl: (url: string) => void;

  constructor(private readonly options: MediaCacheOptions) {
    this.toObjectUrl = options.toObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.releaseObjectUrl = options.releaseObjectUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  /** 看一条媒体当前的状态；没加载过返回 undefined。 */
  peek(key: string): MediaState | undefined {
    return this.entries.get(key);
  }

  /**
   * 取一条媒体的本地地址（必要时开始下载）。
   *
   * `retry` 只用在「失败」之后：不显式重试就不会再打一次 —— 否则渲染层每重画一回
   * 都会把失败的请求重新刷出去。
   */
  resolve(key: string, sourceUrl: string, options: { retry?: boolean } = {}): MediaState {
    const cached = this.entries.get(key);
    if (cached && !(options.retry === true && cached.status === "failed")) return cached;

    const loading: MediaState = { status: "loading" };
    this.entries.set(key, loading);
    void this.options.load(sourceUrl).then(
      (blob) => this.settle(key, { status: "ready", url: this.toObjectUrl(blob) }),
      () => this.settle(key, { status: "failed" }),
    );
    return loading;
  }

  /** 订阅状态变化。返回取消订阅的函数。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 释放全部本地地址（离开页面、登出时调用，否则占着的内存不会还回去）。 */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.status === "ready") this.releaseObjectUrl(entry.url);
    }
    this.entries.clear();
    this.listeners.clear();
  }

  private settle(key: string, state: MediaState): void {
    // 下载期间可能已经被 dispose 掉了：别再塞回去，也不用通知谁。
    if (!this.entries.has(key)) return;
    this.entries.set(key, state);
    for (const listener of [...this.listeners]) listener();
  }
}
