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
 * 这个请求最终要发出去的 JSON 请求体 —— `undefined` 表示「一个字节都不发」。
 *
 * 两套传输层（浏览器的 `fetch`、APK 的 `Laya.HttpRequest`）都用它来决定
 * 「要不要带 `Content-Type`」和「body 写什么」，判据只留这一处。
 *
 * **写请求即使没有 body 也要发一个 `{}`**，这条看着多余，其实是一个只在公网部署下
 * 才暴露的坑：
 *
 * - 局域网直连时，浏览器给无 body 的 `POST` 发 `Content-Length: 0`。Fastify 的
 *   `isEmptyBody()` 判成「没有 body 要解析」，不查 `Content-Type`，直接进处理函数 ——
 *   所以「建房」在局域网一直好好的。
 * - 一旦经 Cloudflare 隧道（或任何把请求改写成 `Transfer-Encoding: chunked` 的代理），
 *   `isEmptyBody()` 变成 false，Fastify 就去找 `Content-Type` 选解析器，**没有就回 415**。
 *   而只补 `Content-Type` 也不够：Fastify 对「声明是 JSON 但 body 为空」同样会拒（400
 *   `FST_ERR_CTP_EMPTY_JSON_BODY`）。
 *
 * 所以必须两头都补上：带类型、也带一个真正合法的空对象。GET/HEAD 照旧什么都不发。
 */
export function jsonBodyFor(method: string, body: unknown): string | undefined {
  if (body !== undefined) return JSON.stringify(body);
  if (method === "GET" || method === "HEAD") return undefined;
  return "{}";
}

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
