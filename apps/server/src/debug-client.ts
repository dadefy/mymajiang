import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 把浏览器调试客户端挂在服务端上。
 *
 * 这样内网测试只需要发一个网址：`http://<服务器IP>:3000/debug`，
 * 不用装 Android 工具链、不用打包 APK、也不用配 CORS（同源）。
 *
 * 静态文件取自 `apps/client/dist` —— 也就是 `apps/client` 用 tsc 编译出来的 ESM。
 * 客户端的源码里全是相对导入（`./flow.js` 这种），所以浏览器能直接当原生模块加载，
 * **不需要任何打包器**。
 */
const CLIENT_ROOT = fileURLToPath(new URL("../../client/dist/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface DebugClientOptions {
  /** 实时通道地址，注入给页面。与 HTTP 是两个端口，必须显式给出。 */
  socketUrl: string;
}

/** `GET /debug` 的页面。只在服务端生成，不落静态文件。 */
export function debugClientHtml(options: DebugClientOptions): string {
  const runtimeConfig = JSON.stringify({ socketUrl: options.socketUrl });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>绵阳血战麻将 · 内测调试客户端</title>
  <style>
    :root { color-scheme: dark; font-family: "Microsoft YaHei", system-ui, sans-serif; background: #101a17; color: #e6f1ec; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    #bar { display: flex; gap: 10px; align-items: center; padding: 12px 18px; background: #123d2c; flex-wrap: wrap; }
    .spacer { flex: 1; }
    main { max-width: 900px; margin: 0 auto; padding: 18px; display: grid; gap: 14px; }
    .panel { background: #17241f; border: 1px solid #24443a; border-radius: 10px; padding: 16px; }
    h2 { margin: 0 0 12px; font-size: 17px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    button { background: #1d6b4a; color: white; border: 0; border-radius: 7px; padding: 8px 14px; font: inherit; cursor: pointer; }
    button.primary { background: #d8a13a; color: #241a05; font-weight: bold; }
    button.tile { background: #f4f1e6; color: #1d1a14; font-weight: bold; padding: 10px 8px; min-width: 52px; }
    button.tile.chosen { background: #d8a13a; }
    button.tile.missing-suit { opacity: .45; box-shadow: inset 0 0 0 2px #a83434; }
    input.text { background: #0d1613; color: inherit; border: 1px solid #2d5347; border-radius: 7px; padding: 9px 11px; font: inherit; min-width: 240px; }
    .hand { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0; }
    .list { display: grid; gap: 10px; }
    .group { border-top: 1px solid #24443a; padding-top: 10px; }
    .messages { max-height: 180px; overflow: auto; display: grid; gap: 3px; margin: 6px 0; font-size: 14px; }
    .messages p { margin: 0; }
    .hint { color: #8fb3a5; font-size: 13px; margin: 6px 0; }
    .error { color: #ff9b9b; margin: 8px 0; }
    code { background: #0d1613; padding: 1px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <header id="bar"></header>
  <main id="app"></main>
  <script>globalThis.__MYMJ_CONFIG__ = ${runtimeConfig};</script>
  <script type="module" src="/debug/browser/debug-client.js"></script>
</body>
</html>`;
}

/**
 * `GET /debug/*`：把 `apps/client/dist` 下的文件发出去。
 *
 * 路径先规范化再确认仍在根目录内，挡住 `../` 穿越。
 */
export async function serveDebugAsset(path: string, reply: FastifyReply): Promise<FastifyReply | void> {
  const root = resolve(CLIENT_ROOT);
  const target = resolve(root, path.replace(/^\/+/, ""));
  if (target !== root && !target.startsWith(root + sep)) {
    return reply.status(404).send({ code: "NOT_FOUND" });
  }
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    // 客户端还没构建时给出可执行的提示，而不是一个没头没脑的 404。
    return reply.status(404).send({
      code: "NOT_FOUND",
      message: "调试客户端还没构建：先跑 pnpm --filter @mianyang-mahjong/client build",
    });
  }
  return reply
    .type(CONTENT_TYPES[extname(target)] ?? "application/octet-stream")
    .send(body);
}

export function registerDebugClient(app: FastifyInstance, options: DebugClientOptions): void {
  app.get("/debug", async (_request: FastifyRequest, reply: FastifyReply) => reply
    .header("Cache-Control", "no-store")
    .type("text/html; charset=utf-8")
    .send(debugClientHtml(options)));

  app.get("/debug/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { "*"?: string };
    return serveDebugAsset(params["*"] ?? "", reply);
  });
}
