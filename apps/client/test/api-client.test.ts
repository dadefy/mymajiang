import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api-client.js";
import { FakeHttpTransport } from "./fakes.js";

function clientWith() {
  const transport = new FakeHttpTransport();
  return { transport, client: new ApiClient(transport) };
}

describe("ApiClient", () => {
  it("激活成功后带上令牌继续调用", async () => {
    const { transport, client } = clientWith();
    transport.onJson("POST", "/v1/auth/activate", 200, {
      userId: "1234567890",
      nickname: "张三",
      avatarUrl: "a",
      status: "active",
      points: 0,
      token: "jwt-1",
    });
    transport.onJson("GET", "/v1/groups", 200, { groups: [] });

    const activated = await client.activate("MYMJ-7K3M-9QXA-2WET-5ZVB", "张三", "a");
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;

    await client.groups();
    const request = transport.lastRequest();
    expect(request.token).toBe("jwt-1");
    expect(activated.value.token).toBe("jwt-1");
  });

  it("把服务端错误码按语义分类", async () => {
    const { transport, client } = clientWith();
    transport.onJson("POST", "/v1/auth/login", 409, { code: "KEY_ACTIVATION_REQUIRED" });
    transport.onJson("POST", "/v1/auth/activate", 401, { code: "KEY_REVOKED" });
    transport.onJson("GET", "/v1/rooms/room-1", 400, { code: "KEY_MALFORMED" });
    transport.onJson("GET", "/v1/matches", 501, { code: "MATCH_HISTORY_UNAVAILABLE" });
    transport.onJson("GET", "/v1/groups", 500, { code: "INTERNAL" });

    const needsProfile = await client.login("MYMJ-7K3M-9QXA-2WET-5ZVB");
    expect(needsProfile.ok).toBe(false);
    expect(needsProfile.ok ? null : needsProfile.error).toMatchObject({ kind: "conflict", code: "KEY_ACTIVATION_REQUIRED" });

    const revoked = await client.activate("MYMJ-7K3M-9QXA-2WET-5ZVB", "张三", "a");
    expect(revoked.ok ? null : revoked.error.kind).toBe("auth");

    const malformed = await client.room("room-1");
    expect(malformed.ok ? null : malformed.error.kind).toBe("input");

    const unavailable = await client.matches();
    expect(unavailable.ok ? null : unavailable.error.kind).toBe("unavailable");

    const server = await client.groups();
    expect(server.ok ? null : server.error.kind).toBe("server");
  });

  it("连不上服务端时返回 network 错误而不是抛异常", async () => {
    const transport: FakeHttpTransport = new (class extends FakeHttpTransport {
      override async request(): Promise<HttpResponse> {
        throw new Error("offline");
      }
    })();
    const client = new ApiClient(transport);

    const result = await client.groups();

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toMatchObject({ kind: "network", code: "NETWORK_ERROR" });
  });

  it("登出后不再带令牌", async () => {
    const { transport, client } = clientWith();
    client.setToken("jwt-1");
    transport.onJson("GET", "/v1/groups", 200, { groups: [] });

    client.setToken(undefined);
    await client.groups();

    expect(transport.lastRequest().token).toBeUndefined();
  });
});
