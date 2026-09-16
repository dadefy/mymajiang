export interface RuntimeConfig {
  apiBaseUrl: string;
  socketUrl: string;
}

declare global {
  var __MYMJ_CONFIG__: Partial<RuntimeConfig> | undefined;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function runtimeConfig(): RuntimeConfig {
  const configured = globalThis.__MYMJ_CONFIG__;
  const browserOrigin = typeof location !== "undefined" && /^https?:$/.test(location.protocol)
    ? location.origin
    : "http://127.0.0.1:3000";
  const apiBaseUrl = withoutTrailingSlash(configured?.apiBaseUrl ?? browserOrigin);
  /**
   * 单端口部署：实时通道与 HTTP **同源**，把 `http→ws` / `https→wss` 换掉协议即可。
   *
   * 这里以前会把端口改写成固定的 `3001`（双端口时代的写法）。改成单端口之后，
   * 那个端口上什么都没有，客户端会连到一个不存在的地址 —— 表现为「能登录，但一进房间就断线」。
   * 浏览器调试客户端（`apps/client/src/browser/debug-client.ts`）当时一起改了，这一份漏了。
   */
  const sameOriginSocketUrl = apiBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return {
    apiBaseUrl,
    socketUrl: configured?.socketUrl || sameOriginSocketUrl,
  };
}
