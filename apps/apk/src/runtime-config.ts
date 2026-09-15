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
  const defaultSocketUrl = apiBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/:\d+$/, ":3001");
  return {
    apiBaseUrl,
    socketUrl: configured?.socketUrl ?? defaultSocketUrl,
  };
}
