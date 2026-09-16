import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  SocketTransport,
  SocketTransportFactory,
  UploadRequest,
  UploadResponse,
  UploadTransport,
} from "@mianyang-mahjong/client";

export class LayaHttpTransport implements HttpTransport {
  constructor(private readonly baseUrl: string) {}

  request<T>(input: HttpRequest): Promise<HttpResponse<T>> {
    return new Promise((resolve, reject) => {
      const request = new Laya.HttpRequest();
      const headers = ["Accept", "application/json"];
      if (input.body !== undefined) headers.push("Content-Type", "application/json");
      if (input.token) headers.push("X-Auth-Token", input.token);
      const finish = () => {
        const status = Number(request.http?.status ?? 0);
        if (status === 0) {
          reject(new Error("NETWORK_ERROR"));
          return;
        }
        resolve({ status, body: parseResponse<T>(request.data) });
      };
      request.once(Laya.Event.COMPLETE, this, finish);
      request.once(Laya.Event.ERROR, this, finish);
      const send = request.send as unknown as (
        url: string,
        data: string | null,
        method: string,
        responseType: string,
        headers: string[],
      ) => void;
      send.call(
        request,
        `${this.baseUrl}${input.path}`,
        input.body === undefined ? null : JSON.stringify(input.body),
        input.method.toLowerCase(),
        "json",
        headers,
      );
    });
  }
}

/**
 * 图片直传：把字节 PUT 到服务端签发的地址上。
 *
 * 与 `LayaHttpTransport` 的两点不同，都不是随手写成这样的：
 * 1. 地址是**绝对地址**（对象存储域名），不能再拼 `baseUrl`；
 * 2. **不带我们的令牌** —— 地址本身已经签名，多一个头反而会让签名对不上。
 */
export class LayaUploadTransport implements UploadTransport {
  put(input: UploadRequest): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
      const request = new Laya.HttpRequest();
      const headers: string[] = [];
      // 用 `Object.keys` 而不是 `Object.entries`：apk 的 tsconfig 目标较低，没有 es2017 的 lib。
      for (const name of Object.keys(input.headers)) headers.push(name, input.headers[name]!);
      const finish = () => {
        const status = Number(request.http?.status ?? 0);
        if (status === 0) {
          reject(new Error("UPLOAD_NETWORK_ERROR"));
          return;
        }
        resolve({ status });
      };
      request.once(Laya.Event.COMPLETE, this, finish);
      request.once(Laya.Event.ERROR, this, finish);
      const send = request.send as unknown as (
        url: string,
        data: ArrayBuffer,
        method: string,
        responseType: string,
        headers: string[],
      ) => void;
      send.call(request, input.url, toArrayBuffer(input.body), input.method.toLowerCase(), "arraybuffer", headers);
    });
  }
}

/**
 * 直传要的是「正好这一段字节」。
 *
 * `Uint8Array` 可能只是某个更大 buffer 上的视图（带 byteOffset），直接取 `buffer`
 * 会把视图之外的内容也发出去。`slice()` 复制出独立的一段，代价是一次拷贝。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

class LayaSocketTransport implements SocketTransport {
  private readonly messageListeners = new Set<(payload: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private intentionallyClosed = false;

  constructor(private readonly socket: Laya.Socket) {
    socket.on(Laya.Event.MESSAGE, this, this.handleMessage);
    socket.on(Laya.Event.CLOSE, this, this.handleClose);
    socket.on(Laya.Event.ERROR, this, this.handleClose);
  }

  send(payload: unknown): void {
    if (!this.socket.connected) throw new Error("Socket is not connected");
    void this.socket.send(JSON.stringify(payload));
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
    try {
      const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      for (const listener of this.messageListeners) listener(payload);
    } catch {
      return;
    }
  }

  private handleClose(): void {
    if (this.intentionallyClosed) return;
    for (const listener of this.closeListeners) listener();
  }
}

export class LayaSocketTransportFactory implements SocketTransportFactory {
  connect(url: string): Promise<SocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = new Laya.Socket();
      socket.disableInput = true;
      let settled = false;
      socket.once(Laya.Event.OPEN, this, () => {
        settled = true;
        resolve(new LayaSocketTransport(socket));
      });
      socket.once(Laya.Event.ERROR, this, (error: unknown) => {
        if (!settled) reject(new Error(`WebSocket connection failed: ${String(error)}`));
      });
      socket.connectByUrl(url);
    });
  }
}

function parseResponse<T>(data: unknown): T {
  if (typeof data !== "string") return data as T;
  if (!data) return undefined as T;
  try {
    return JSON.parse(data) as T;
  } catch {
    return data as T;
  }
}
