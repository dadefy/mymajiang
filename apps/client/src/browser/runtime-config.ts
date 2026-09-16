/**
 * 调试页面共用的运行时配置。
 *
 * 两个调试客户端（单人的 `/debug` 与四家同屏的 `/multi`）都要知道接口与实时通道的地址，
 * 所以把这段推导收在一处 —— 单端口部署、隧道、反向代理三种情形下的规则完全一样，
 * 分头写迟早会漂移。
 */

export interface RuntimeConfig {
  apiBaseUrl: string;
  socketUrl: string;
}

/**
 * 配置来源：服务端注入的 `window.__MYMJ_CONFIG__`，没有就按同源推断。
 *
 * 单端口部署时页面与接口同源，直接用 `location.origin` 推出实时通道地址即可：
 * `https://x` → `wss://x`、`http://x:3000` → `ws://x:3000`。
 * 这样**隧道、反向代理、HTTPS 全都自动正确** —— 换成 `wss://` 是浏览器对
 * HTTPS 页面的硬要求（混合内容会被拦截），同源推导天然满足。
 */
export function readRuntimeConfig(): RuntimeConfig {
  const injected = (globalThis as { __MYMJ_CONFIG__?: Partial<RuntimeConfig> }).__MYMJ_CONFIG__ ?? {};
  const origin = location.origin;
  return {
    apiBaseUrl: injected.apiBaseUrl ?? origin,
    socketUrl: injected.socketUrl || origin.replace(/^http/, "ws"),
  };
}
