import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  SocketTransport,
  SocketTransportFactory,
} from "../transport.js";

/**
 * 浏览器版的两个传输适配器。
 *
 * 与 LayaAir 那份（`apps/apk/src/laya-transports.ts`）是同一个接口的两套实现，
 * 业务层（`ApiClient` / `MatchSocket` / `ClientFlow`）两边完全共用 —— 这正是当初
 * 把「与运行环境的缝」收敛成两个接口的目的。
 *
 * 两个实现都支持注入底层实现（`fetch` / `WebSocket`），这样在 Node 里能塞假对象做单元测试。
 */

export class FetchHttpTransport implements HttpTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  async request<T>(input: HttpRequest): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    // 用自定义头承载令牌，而不是标准的 Authorization —— 见 apps/server/src/auth.ts 的
    // authToken 说明：某些部署网关会覆盖/污染 Authorization 头，自定义头才能绕过。
    if (input.token) headers["X-Auth-Token"] = input.token;
    if (input.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(`${this.baseUrl}${input.path}`, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });

    // 204 之类没有响应体，`json()` 会抛，所以先取文本再判断。
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
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
