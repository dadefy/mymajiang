/**
 * 与引擎/运行环境相关的两个缝。
 *
 * 客户端核心（协议、接口调用、页面流）完全不依赖 LayaAir 或 DOM：
 * 将来接到 LayaAir 时只需要提供这两个接口的实现（LayaAir 的网络 API 与浏览器不同），
 * 其余代码原样复用。测试里也用同样的缝注入假传输。
 */

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** Bearer 令牌；未登录时省略。 */
  token?: string;
}

export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
}

export interface HttpTransport {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
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
