import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  SocketTransport,
  SocketTransportFactory,
} from "@mianyang-mahjong/client";

export class LayaHttpTransport implements HttpTransport {
  constructor(private readonly baseUrl: string) {}

  request<T>(input: HttpRequest): Promise<HttpResponse<T>> {
    return new Promise((resolve, reject) => {
      const request = new Laya.HttpRequest();
      const headers = ["Accept", "application/json"];
      if (input.body !== undefined) headers.push("Content-Type", "application/json");
      if (input.token) headers.push("Authorization", `Bearer ${input.token}`);
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
