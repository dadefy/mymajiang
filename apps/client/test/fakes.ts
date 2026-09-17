import type {
  HttpTransport,
  HttpRequest,
  HttpResponse,
  SocketTransport,
  SocketTransportFactory,
  UploadRequest,
  UploadResponse,
  UploadTransport,
} from "../src/transport.js";

export interface FakeResponse {
  status: number;
  body?: unknown;
}

/** 记录请求、按注册的谓词返回响应的假 HTTP 传输。 */
export class FakeHttpTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  private readonly handlers: Array<{
    match: (request: HttpRequest) => boolean;
    respond: (request: HttpRequest) => FakeResponse;
  }> = [];
  /**
   * 被用例扣住的请求（模拟「响应还在路上」）。
   *
   * 假传输默认是「一调用就返回」，而真实网络上有几十到几百毫秒的往返 ——
   * 「刚点进群就发消息」这类时序缺陷恰好只藏在那一小段里，不扣住就复现不出来。
   */
  private readonly holds: Array<{
    match: (request: HttpRequest) => boolean;
    waiting: Array<() => void>;
    open: boolean;
  }> = [];

  /** 先注册的先匹配。 */
  on(match: (request: HttpRequest) => boolean, respond: (request: HttpRequest) => FakeResponse): this {
    this.handlers.push({ match, respond });
    return this;
  }

  onJson(method: HttpRequest["method"], path: string, status: number, body: unknown): this {
    return this.on(
      (request) => request.method === method && (request.path === path || request.path.startsWith(`${path}?`)),
      () => ({ status, body }),
    );
  }

  /**
   * 扣住匹配的请求不回答，直到 `release()`；在那之前调用方一直挂在 await 上。
   *
   * 在 `release()` 之前到来的请求都会被扣住（同一份 hold 复用），
   * 用例只需要「让它们的回答晚于某件事发生」。
   */
  hold(match: (request: HttpRequest) => boolean): { release: () => void } {
    const hold = { match, waiting: [] as Array<() => void>, open: false };
    this.holds.push(hold);
    return {
      release: () => {
        hold.open = true;
        for (const resume of hold.waiting.splice(0)) resume();
      },
    };
  }

  lastRequest(): HttpRequest {
    const request = this.requests.at(-1);
    if (!request) throw new Error("No request has been made");
    return request;
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const hold = this.holds.find((candidate) => candidate.match(request));
    if (hold && !hold.open) {
      await new Promise<void>((resolve) => hold.waiting.push(resolve));
    }
    const handler = this.handlers.find((candidate) => candidate.match(request));
    if (!handler) throw new Error(`No fake response for ${request.method} ${request.path}`);
    const response = handler.respond(request);
    return { status: response.status, ...(response.body === undefined ? {} : { body: response.body }) } as HttpResponse<T>;
  }
}

/** 测试用它扮演服务端：记录发出去的帧、按需推帧、模拟断线。 */
export class FakeSocketTransport implements SocketTransport {
  readonly sent: unknown[] = [];
  closed = false;
  url = "";
  private readonly messageListeners = new Set<(payload: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
  }

  onMessage(listener: (payload: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  serverSends(payload: unknown): void {
    for (const listener of [...this.messageListeners]) listener(payload);
  }

  serverCloses(): void {
    for (const listener of [...this.closeListeners]) listener();
  }
}

export class FakeSocketFactory implements SocketTransportFactory {
  readonly created: FakeSocketTransport[] = [];

  async connect(url: string): Promise<SocketTransport> {
    const socket = new FakeSocketTransport();
    socket.url = url;
    this.created.push(socket);
    return socket;
  }

  last(): FakeSocketTransport {
    const socket = this.created.at(-1);
    if (!socket) throw new Error("No socket has been created");
    return socket;
  }
}

/** 记录直传请求的假传输；默认成功，可以改成返回某个状态码或直接抛错。 */
export class FakeUploadTransport implements UploadTransport {
  readonly requests: UploadRequest[] = [];
  private status = 204;
  private failure: Error | undefined;

  /** 让下一次直传返回这个状态码。 */
  respondWith(status: number): void {
    this.status = status;
  }

  /** 让下一次直传抛错（存储侧网络不通时的样子）。 */
  failWith(error: Error): void {
    this.failure = error;
  }

  async put(request: UploadRequest): Promise<UploadResponse> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return { status: this.status };
  }
}
