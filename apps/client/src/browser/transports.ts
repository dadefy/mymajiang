import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  SocketTransport,
  SocketTransportFactory,
  UploadRequest,
  UploadResponse,
  UploadTransport,
} from "../transport.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../transport.js";

/**
 * 浏览器版的三个传输适配器。
 *
 * 与 LayaAir 那份（`apps/apk/src/laya-transports.ts`）是同一个接口的两套实现，
 * 业务层（`ApiClient` / `MatchSocket` / `ClientFlow`）两边完全共用 —— 这正是当初
 * 把「与运行环境的缝」收敛成接口的目的。
 *
 * 三个实现都支持注入底层实现（`fetch` / `WebSocket`），这样在 Node 里能塞假对象做单元测试。
 */

export class FetchHttpTransport implements HttpTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
    /** 单次请求的超时；到点就中断，交给上层按网络错误处理（于是会带幂等键重试）。 */
    private readonly timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async request<T>(input: HttpRequest): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    // 用自定义头承载令牌，而不是标准的 Authorization —— 见 apps/server/src/auth.ts 的
    // authToken 说明：某些部署网关会覆盖/污染 Authorization 头，自定义头才能绕过。
    if (input.token) headers["X-Auth-Token"] = input.token;
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    if (input.body !== undefined) headers["Content-Type"] = "application/json";

    // 浏览器这边能真中断，比 LayaAir 那侧干净。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers,
        signal: controller.signal,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });

      // 204 之类没有响应体，`json()` 会抛，所以先取文本再判断。
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 浏览器版的二进制直传。
 *
 * 用 `fetch` 而不是 XHR：直传地址落在对象存储的域名上，跨域是常态 ——
 * 签名和 CORS 都由存储端决定，我们只负责把服务端给的头照抄过去。
 */
export class FetchUploadTransport implements UploadTransport {
  constructor(private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  async put(input: UploadRequest): Promise<UploadResponse> {
    // 地址本身已经签好名了，**不要**再加我们的令牌 —— 多一个头会让签名对不上。
    const response = await this.fetchImpl(input.url, {
      method: input.method,
      headers: input.headers,
      // TS 5.7 起 `Uint8Array` 带上了 buffer 泛型（`Uint8Array<ArrayBufferLike>`），
      // 与 lib.dom 的 `BodyInit` 对不上。运行时 fetch 接受任何 ArrayBufferView，
      // 所以这里只是类型适配，不是真的在转换数据。
      body: input.body as unknown as BodyInit,
    });
    // 204（本地驱动）与 200（COS）都没有响应体，不用读。
    return { status: response.status };
  }
}

class BrowserSocket implements SocketTransport {
  private readonly messageListeners = new Set<(payload: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  /** 主动关闭时不再上报 close，否则 MatchSocket 会当成断线去重连。 */
  private intentionallyClosed = false;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleClose());
  }

  send(payload: unknown): void {
    if (this.socket.readyState !== 1) throw new Error("Socket is not connected");
    this.socket.send(JSON.stringify(payload));
  }

  close(): void {
    this.intentionallyClosed = true;
    this.socket.close();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  onMessage(listener: (payload: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    for (const listener of this.messageListeners) listener(payload);
  }

  private handleClose(): void {
    if (this.intentionallyClosed) return;
    for (const listener of this.closeListeners) listener();
  }
}

export class BrowserSocketTransportFactory implements SocketTransportFactory {
  constructor(private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url)) {}

  connect(url: string): Promise<SocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = this.createSocket(url);
      socket.addEventListener("open", () => resolve(new BrowserSocket(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });
  }
}
