import { describe, expect, it, vi } from "vitest";
import { BrowserSocketTransportFactory, FetchHttpTransport } from "../src/browser/transports.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 假的 fetch：记录请求，按预设返回。 */
function fakeFetch(response: { status: number; text: string }) {
  const requests: RecordedRequest[] = [];
  const impl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { status: response.status, text: async () => response.text };
  }) as unknown as typeof fetch;
  return { impl, requests };
}

/** 假 WebSocket：手动触发 open / message / close / error，完全可控。 */
class FakeWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void {
    const wrapped = options?.once
      ? (event: unknown) => { this.off(type, wrapped); listener(event); }
      : listener;
    const list = this.listeners.get(type) ?? [];
    list.push(wrapped);
    this.listeners.set(type, list);
  }

  private off(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((each) => each !== listener));
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  fail(): void {
    this.emit("error", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

describe("FetchHttpTransport", () => {
  it("拼出正确的 URL、方法与请求头，并解析 JSON 响应", async () => {
    const { impl, requests } = fakeFetch({ status: 200, text: '{"ok":true}' });
    const transport = new FetchHttpTransport("http://10.0.0.5:3000", impl);

    const response = await transport.request<{ ok: boolean }>({
      method: "POST",
      path: "/v1/auth/login",
      body: { key: "MYMJ-0000-0000-0000-0000" },
      token: "token-123",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(requests[0]!.url).toBe("http://10.0.0.5:3000/v1/auth/login");
    expect(requests[0]!.method).toBe("POST");
    // 令牌走自定义头而不是 Authorization：某些部署网关会覆盖 Authorization 头。
    expect(requests[0]!.headers["X-Auth-Token"]).toBe("token-123");
    expect(requests[0]!.headers.Authorization).toBeUndefined();
    expect(requests[0]!.headers["Content-Type"]).toBe("application/json");
    expect(requests[0]!.body).toBe('{"key":"MYMJ-0000-0000-0000-0000"}');
  });

  it("没有令牌与请求体时不带多余的请求头", async () => {
    const { impl, requests } = fakeFetch({ status: 200, text: "{}" });
    const transport = new FetchHttpTransport("http://10.0.0.5:3000", impl);

    await transport.request({ method: "GET", path: "/v1/groups" });

    expect(requests[0]!.headers["X-Auth-Token"]).toBeUndefined();
    expect(requests[0]!.headers.Authorization).toBeUndefined();
    expect(requests[0]!.headers["Content-Type"]).toBeUndefined();
    expect(requests[0]!.body).toBeUndefined();
  });

  it("204 这种空响应体不会因为解析 JSON 而抛错", async () => {
    const { impl } = fakeFetch({ status: 204, text: "" });
    const transport = new FetchHttpTransport("http://10.0.0.5:3000", impl);

    const response = await transport.request({ method: "POST", path: "/v1/account/delete" });

    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
  });
});

describe("BrowserSocketTransportFactory", () => {
  it("连上之后解析成可用连接，能把服务端帧分发给监听者", async () => {
    const socket = new FakeWebSocket();
    const factory = new BrowserSocketTransportFactory(() => socket as unknown as WebSocket);

    const connecting = factory.connect("ws://10.0.0.5:3001");
    socket.open();
    const transport = await connecting;

    const received: unknown[] = [];
    transport.onMessage((payload) => received.push(payload));
    socket.message('{"type":"ready","userId":"1"}');
    // 非 JSON 的帧直接忽略，不应该把监听者打崩。
    socket.message("这不是 JSON");

    expect(received).toEqual([{ type: "ready", userId: "1" }]);
  });

  it("连不上时以失败结束，不会一直挂着", async () => {
    const socket = new FakeWebSocket();
    const factory = new BrowserSocketTransportFactory(() => socket as unknown as WebSocket);

    const connecting = factory.connect("ws://10.0.0.5:3001");
    socket.fail();

    await expect(connecting).rejects.toThrow("WebSocket connection failed");
  });

  it("主动关闭不上报 close，否则 MatchSocket 会当成断线去重连", async () => {
    const socket = new FakeWebSocket();
    const factory = new BrowserSocketTransportFactory(() => socket as unknown as WebSocket);
    const connecting = factory.connect("ws://10.0.0.5:3001");
    socket.open();
    const transport = await connecting;

    let closed = 0;
    transport.onClose(() => { closed += 1; });
    transport.close();
    expect(closed).toBe(0);

    // 另一条连接意外断开时则要上报。
    const other = new FakeWebSocket();
    const otherConnecting = new BrowserSocketTransportFactory(() => other as unknown as WebSocket)
      .connect("ws://10.0.0.5:3001");
    other.open();
    const otherTransport = await otherConnecting;
    let otherClosed = 0;
    otherTransport.onClose(() => { otherClosed += 1; });
    other.close();
    expect(otherClosed).toBe(1);
  });

  it("未连接时发送会抛错而不是静默丢弃", async () => {
    const socket = new FakeWebSocket();
    const factory = new BrowserSocketTransportFactory(() => socket as unknown as WebSocket);
    const connecting = factory.connect("ws://10.0.0.5:3001");
    socket.open();
    const transport = await connecting;

    transport.send({ type: "start" });
    expect(socket.sent).toEqual(['{"type":"start"}']);

    transport.close();
    expect(() => transport.send({ type: "start" })).toThrow("not connected");
  });

  it("带上幂等键时会发出 Idempotency-Key 头", async () => {
    const { impl, requests } = fakeFetch({ status: 201, text: '{"roomId":"room-1"}' });
    const transport = new FetchHttpTransport("http://127.0.0.1:3000", impl);

    await transport.request({ method: "POST", path: "/v1/rooms", idempotencyKey: "op-mfk3n-abcdefghij" });

    expect(requests[0]!.headers["Idempotency-Key"]).toBe("op-mfk3n-abcdefghij");
  });

  it("没带幂等键时不会发出这个头", async () => {
    const { impl, requests } = fakeFetch({ status: 200, text: "{}" });
    const transport = new FetchHttpTransport("http://127.0.0.1:3000", impl);

    await transport.request({ method: "GET", path: "/v1/groups" });

    expect(requests[0]!.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("请求超时会中断，交给上层按网络错误处理（于是会带同一个幂等键重试）", async () => {
    vi.useFakeTimers();
    // 永远不返回的 fetch，但响应 abort —— 真实 fetch 就是这个行为。
    const hanging = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const transport = new FetchHttpTransport("http://127.0.0.1:3000", hanging, 1000);

    const pending = transport.request({ method: "GET", path: "/v1/groups" });
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
});
