/**
 * 与引擎/运行环境相关的三个缝。
 *
 * 客户端核心（协议、接口调用、页面流）完全不依赖 LayaAir 或 DOM：
 * 将来接到 LayaAir 时只需要提供这三个接口的实现（LayaAir 的网络 API 与浏览器不同），
 * 其余代码原样复用。测试里也用同样的缝注入假传输。
 */

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** Bearer 令牌；未登录时省略。 */
  token?: string;
  /**
   * 幂等键：同一个键重复提交，服务端只会执行一次（第二次回放第一次的响应）。
   *
   * 只在「重复会产生额外副作用」的接口上有意义（建房、建群、发消息、调分、签发密钥）。
   * 由 `ClientFlow` 在重试时**复用同一个键**，所以重试不会造成第二间房、第二条消息。
   */
  idempotencyKey?: string;
}

export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
}

export interface HttpTransport {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
}

/**
 * 单次请求的默认超时。
 *
 * 没有超时的话，弱网下请求会一直挂着，界面永远停在「处理中」，而且**重试永远不会触发**
 * —— 幂等键也就没机会发挥作用。所以超时是「弱网重试」的前半段，两者配套。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * 一次直传请求。
 *
 * `url` 指向**对象存储**（云上是 COS 自己的域名，本地驱动是服务端自己），
 * 不是我们的 API —— 所以不能复用 `HttpTransport`：它只发 JSON、路径也是相对的。
 * `headers` 由服务端签发时给定（内容类型就绑在里面），照抄即可。
 */
export interface UploadRequest {
  url: string;
  /** 服务端签发时指定，当前恒为 PUT。 */
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface UploadResponse {
  status: number;
}

/**
 * 二进制直传。
 *
 * 拆成单独的缝而不是塞进 `HttpTransport`：直传要发原始字节、要打到第三方域名，
 * 而且**不能带我们的令牌**（地址本身已签名，多带一个头反而会让签名对不上）。
 */
export interface UploadTransport {
  put(request: UploadRequest): Promise<UploadResponse>;
}

export interface SocketTransport {
  /** 发送一帧 JSON。连接未建立时抛错。 */
  send(payload: unknown): void;
  close(): void;
  /** 返回取消监听的函数。 */
  onMessage(listener: (payload: unknown) => void): () => void;
  /** 连接断开（主动 close 除外）时回调。 */
  onClose(listener: () => void): () => void;
}

export interface SocketTransportFactory {
  connect(url: string): Promise<SocketTransport>;
}
