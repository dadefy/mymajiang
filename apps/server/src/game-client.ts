import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 把 LayaAir 构建出来的 **Web 版**挂在服务端上。
 *
 * 与 `/debug`（手写的浏览器调试客户端）目的相同 —— 让手机打开一个网址就能玩 ——
 * 区别是这里跑的是**真正的 LayaAir 渲染层**，也就是最终 APK 里那一套 UI，
 * 所以它验到的东西离上线版本更近：页面布局、牌面渲染、点击区域都是真的。
 *
 * **为什么必须由服务端提供，而不是随便起个静态服务器**：客户端按 `location.origin`
 * 推导 API 与实时通道地址（见 `apps/apk/src/runtime-config.ts`），**同源**才连得上；
 * 换个端口不仅地址不对，还会撞上跨域。
 *
 * 静态文件取自 `apps/apk/release/web`，那是 `layaair build web -p apps/apk` 的产物，
 * **不进仓库**（`apps/apk/.gitignore` 排除了 `release`）。没构建时这里只返回 404 并给出命令，
 * 不影响 `/debug`。
 */
const GAME_ROOT = fileURLToPath(new URL("../../apk/release/web/", import.meta.url));

/** LayaAir 产物里会出现的类型。`.atlas` 与 `.ls`（场景）其实都是 JSON。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".atlas": "application/json; charset=utf-8",
  ".ls": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bin": "application/octet-stream",
  ".fnt": "application/octet-stream",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export interface GameClientOptions {
  /** 没构建时提示里给出的命令，让人知道下一步该做什么。 */
  buildCommand: string;
}

/**
 * 「改了就该立刻生效」的配置类资源，不走缓存。
 *
 * 内测期间场景（`.ls`）、图集（`.atlas`）与清单（`.json`）会被反复改，
 * 一旦被浏览器缓存就会出现「重新构建了、但手机上还是旧场景」这种很难查的现象
 * —— 正好踩过一次（场景字段名改对了却看不到效果）。
 * 引擎库（`libs/*.js`，近 2 MB）保持可缓存，那才是每次都要下的大头。
 */
const CONFIG_EXTENSIONS = new Set([".ls", ".json", ".atlas"]);

/**
 * 读一个产物文件。
 *
 * `path` 是 `/app/*` 里那段通配：空串表示目录请求，给 `index.html`（LayaAir 是单页应用）。
 * 路径先规范化再确认仍在根目录内，挡住 `../` 穿越。
 */
async function serveGameAsset(path: string, reply: FastifyReply, options: GameClientOptions): Promise<FastifyReply> {
  const root = resolve(GAME_ROOT);
  const relative = path.replace(/^\/+/, "");
  const target = resolve(root, relative.length === 0 ? "index.html" : relative);
  if (target !== root && !target.startsWith(root + sep)) {
    return reply.status(404).send({ code: "NOT_FOUND" });
  }

  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return reply.status(404).send({
      code: "NOT_FOUND",
      message: `LayaAir Web 版还没构建：先跑 ${options.buildCommand}`,
    });
  }
  const extension = extname(target).toLowerCase();
  if (CONFIG_EXTENSIONS.has(extension)) reply.header("Cache-Control", "no-store");
  return reply.type(CONTENT_TYPES[extension] ?? "application/octet-stream").send(body);
}

export function registerGameClient(app: FastifyInstance, options: GameClientOptions): void {
  /**
   * `/app` 必须跳到 `/app/`。
   *
   * LayaAir 生成的 `index.html` 用的是**相对路径**（`libs/laya.core.js`、`js/index.js` 这种，
   * 不是 `/app/libs/...`）。访问 `/app` 少了结尾斜杠时，浏览器会把 `app` 当成**文件**，
   * 相对路径于是按站根解析 —— 请求打到 `/libs/laya.core.js`，整页资源全 404，
   * 表现就是一片白（或一直卡在 splash）。带上斜杠后浏览器才知道 `app` 是目录，
   * 相对路径才落在 `/app/` 下面。
   */
  app.get("/app", async (_request: FastifyRequest, reply: FastifyReply) => reply.redirect("/app/", 302));

  // 页面缓存要关掉：内测期间重新构建之后，手机上刷新就该看到新的，
  // 否则会出现「代码改了但手机还是旧页面」这种很难查的现象。
  app.get("/app/", async (_request: FastifyRequest, reply: FastifyReply) =>
    serveGameAsset("", reply.header("Cache-Control", "no-store"), options));

  app.get("/app/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { "*"?: string };
    return serveGameAsset(params["*"] ?? "", reply, options);
  });
}
