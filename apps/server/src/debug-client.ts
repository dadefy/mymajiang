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
    /* 图片预览：限制最大边长，点开可以在新标签看原图。 */
    img.thumb { display: block; max-width: 220px; max-height: 160px; border-radius: 8px; margin: 4px 0; cursor: zoom-in; }
    /* 语音：浏览器原生控件最省事，手机上也能直接播。 */
    .voice-wrap { display: inline-flex; align-items: center; gap: 6px; }
    audio.voice { height: 32px; max-width: 240px; vertical-align: middle; }
    /* 回合指示：谁该出牌要一眼看到。顶部大字用底色区分「轮到我自己」（金色）
       与「轮到别人」（深绿）—— 只靠文字的话，打牌时eye要去读才知道是不是自己。 */
    .turn { border-radius: 8px; padding: 9px 12px; margin: 10px 0 4px; font-weight: bold; }
    .turn.mine { background: #d8a13a; color: #241a05; }
    .turn.other { background: #16302a; color: #cfe9de; border: 1px solid #2d5347; }
    /* 四家各占一行；轮到谁就把那一行框出来。 */
    .seat { padding: 6px 10px; border-radius: 7px; border: 1px solid transparent; margin: 4px 0; font-size: 13px; color: #b9d6c9; }
    .seat.acting { border-color: #d8a13a; background: #1e2f28; }
    .seat.won { opacity: .5; }
    .seat .tag { display: inline-block; min-width: 4.4em; font-weight: bold; color: #8fb3a5; }
    .seat.acting .tag { color: #d8a13a; }
    .order { font-size: 13px; color: #8fb3a5; margin: 8px 0 2px; }
    .order b { color: #d8a13a; font-weight: normal; }
    /* 牌块：副露与弃牌堆用。比手牌小一号，好让一屏放得下。
       .chip.back 是**扣着**的牌（别人的暗杠只亮一张）。
       注意这些 CSS 在模板字符串里，注释里写反引号会直接截断字符串。 */
    .chip { display: inline-flex; align-items: center; justify-content: center;
            width: 28px; height: 22px; background: #f4f1e6; color: #1d1a14;
            font-weight: bold; font-size: 12px; border-radius: 4px; flex: none; }
    .chip.back { background: #24443a; box-shadow: inset 0 0 0 1px #2d5347; }
    .melds { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; }
    .meld-group { display: inline-flex; gap: 2px; align-items: center; padding: 2px 3px;
                  border-radius: 6px; background: #0f1c17; border: 1px solid #2d5347; }
    .meld-group.kong { border-color: #d8a13a; }
    .meld-group .kind { font-size: 10px; color: #8fb3a5; margin: 0 2px; }
    .hint { color: #8fb3a5; font-size: 13px; margin: 6px 0; }
    .error { color: #ff9b9b; margin: 8px 0; }
    a.link { color: #d8a13a; text-decoration: none; font-weight: bold; }
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
 * `GET /multi` 的页面：四家同屏。
 *
 * 与 `/debug` 是同一套业务层（都跑 `ClientFlow`），区别只在于这里同时开**四条独立连接**，
 * 把四家的手牌与操作摊在一个屏幕上。用途是内测时不用真的凑四个人 ——
 * 一个人就能把整局打完，而且打出来的行为与四个真人打完全一致。
 *
 * 模块从 `/debug/browser/` 取（复用同一个静态目录），所以不需要另配静态路由。
 */
export function multiClientHtml(options: DebugClientOptions): string {
  const runtimeConfig = JSON.stringify({ socketUrl: options.socketUrl });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>绵阳血战麻将 · 四家同屏</title>
  <style>
    :root { color-scheme: dark; font-family: "Microsoft YaHei", system-ui, sans-serif; background: #101a17; color: #e6f1ec; }
    * { box-sizing: border-box; }
    /* 作者样式里的 display 会压过 [hidden] 的 UA 规则，所以显式钉住。 */
    [hidden] { display: none !important; }
    body { margin: 0; }
    #bar { display: flex; gap: 10px; align-items: center; padding: 10px 16px; background: #123d2c; flex-wrap: wrap; }
    .spacer { flex: 1; }
    main { max-width: 1180px; margin: 0 auto; padding: 14px; display: grid; gap: 12px; }
    .panel { background: #17241f; border: 1px solid #24443a; border-radius: 10px; padding: 16px; }
    h2 { margin: 0 0 10px; font-size: 17px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    button { background: #1d6b4a; color: white; border: 0; border-radius: 7px; padding: 7px 12px; font: inherit; cursor: pointer; }
    button.primary { background: #d8a13a; color: #241a05; font-weight: bold; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    button.tile { background: #f4f1e6; color: #1d1a14; font-weight: bold; padding: 9px 7px; min-width: 46px; }
    button.tile.chosen { background: #d8a13a; }
    button.tile.missing-suit { opacity: .45; box-shadow: inset 0 0 0 2px #a83434; }
    /* 刚摸到的那张：真牌桌上它就插在手里、等着被打出去。给它一条金边，
       不然「手里凭空多一张」看着像画错了。 */
    button.tile.drawn { box-shadow: 0 0 0 2px #d8a13a; }
    input.text { background: #0d1613; color: inherit; border: 1px solid #2d5347; border-radius: 7px; padding: 8px 10px; font: inherit; min-width: 300px; }
    .hint { color: #8fb3a5; font-size: 13px; margin: 6px 0; }
    .error { color: #ff9b9b; font-size: 13px; margin: 6px 0; }

    .keys { display: grid; gap: 8px; margin: 10px 0; }
    .key-row { display: flex; gap: 8px; align-items: center; }
    .key-tag { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center;
               border-radius: 50%; background: #24443a; font-size: 12px; color: #b9d6c9; flex: none; }

    /* 四方牌桌：上 / 下 / 左 / 右，中央放公共信息。 */
    #board { display: grid;
             grid-template-columns: minmax(150px, 1fr) minmax(210px, 1.15fr) minmax(150px, 1fr);
             grid-template-rows: auto minmax(160px, auto) auto;
             gap: 10px; align-items: start; }
    .seat.top    { grid-area: 1 / 2; }
    .seat.left   { grid-area: 2 / 1; }
    .center      { grid-area: 2 / 2; }
    .seat.right  { grid-area: 2 / 3; }
    .seat.bottom { grid-area: 3 / 2; }

    .seat-card { background: #17241f; border: 1px solid #24443a; border-radius: 10px; padding: 10px; }
    .seat-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; margin-bottom: 6px; }
    .seat-head .who { color: #b9d6c9; }
    /* 手牌张数：牌桌上最基本的信息，用等宽数字免得每次跳动都重排。 */
    .count { color: #8fb3a5; font-variant-numeric: tabular-nums; }
    .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #24443a; color: #cfe9de; }
    .tag.acting { background: #d8a13a; color: #241a05; font-weight: bold; }
    /* 「刚摸牌」与「待出牌」分开：前者是这一帧真的摸了一张，后者只是手上多一张。 */
    .tag.drawn { background: #1d6b4a; color: #eafaf2; font-weight: bold; }
    .tag.won { background: #4a2b2b; color: #ffc9c9; }

    .hand { display: flex; gap: 5px; flex-wrap: wrap; margin: 8px 0; }
    /* 左右两家按真实牌桌的样子竖着摆，也省横向空间。
       注意 align-items 不能是 stretch：竖排时 stretch 让子元素横向撑满容器，
       而左右两列是 1fr（宽屏下能有三百多像素）—— 每张牌会被拉成一条长条。
       改成 center 并给牌一个固定宽度，牌面宽度才和上下两家一致。 */
    .seat.left .hand, .seat.right .hand { flex-direction: column; flex-wrap: nowrap; align-items: center;
                                          max-height: 400px; overflow: auto; }
    .seat.left button.tile, .seat.right button.tile { width: 46px; min-width: 46px; padding: 4px 0; font-size: 13px; }
    .ops { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 0; }
    .ops button { padding: 6px 10px; font-size: 13px; }

    /* 手牌与副露并排：碰过/杠过的牌紧挨着这一家的手牌摆。
       以前只报一句「副露 1」，看不出碰了什么 —— 而副露直接决定番型。 */
    .tiles-area { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
    .melds { display: flex; gap: 4px; flex-wrap: wrap; padding-top: 8px; }
    /* 左右两家是竖排手牌，副露跟着竖着摆在手牌旁边。 */
    .seat.left .tiles-area, .seat.right .tiles-area { flex-wrap: nowrap; }
    .seat.left .melds, .seat.right .melds { flex-direction: column; flex-wrap: nowrap; }
    .meld-group { display: inline-flex; gap: 2px; align-items: center; padding: 2px 3px;
                  border-radius: 6px; background: #0f1c17; border: 1px solid #2d5347; }
    .meld-group.kong { border-color: #d8a13a; }
    .meld-group .kind { font-size: 10px; color: #8fb3a5; margin: 0 2px; }

    /* 小牌块：弃牌区与副露共用。比手牌小一号，好让一屏放得下。
       .chip.back 是**扣着**的牌 —— 别人的暗杠只亮一张，其余三张画成背面。
       注意这些 CSS 在模板字符串里，注释里写反引号会直接截断字符串。 */
    .chip { display: inline-flex; align-items: center; justify-content: center;
            width: 28px; height: 22px; background: #f4f1e6; color: #1d1a14;
            font-weight: bold; font-size: 12px; border-radius: 4px; flex: none; }
    .chip.back { background: #24443a; box-shadow: inset 0 0 0 1px #2d5347; }

    /* 中央弃牌区：四家各一格，打出去的牌都在这儿看。 */
    .discard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
    .discard-cell { background: #0f1c17; border: 1px solid #24443a; border-radius: 8px; padding: 6px 8px; }
    .discard-head { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; font-size: 12px; color: #8fb3a5; }
    .discard-head b { color: #cfe9de; font-size: 13px; }
    .discard-tiles { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
    /* 刚打出的那一张：claiming 阶段大家都在等它能不能被碰/杠/胡。 */
    .chip.fresh { box-shadow: 0 0 0 2px #d8a13a; }

    .center { background: #14211c; border: 1px dashed #2d5347; border-radius: 10px; padding: 12px; }
    .banner { background: #3b2f10; border: 1px solid #d8a13a; color: #f0d9a8; border-radius: 8px;
              padding: 9px 12px; font-weight: bold; font-size: 15px; }
    .room-no { font-size: 20px; font-weight: bold; margin: 4px 0; }
    .meta { color: #b9d6c9; font-size: 13px; margin: 8px 0 4px; }
    .center .ops { margin: 10px 0 0; }

    /* 窄屏（手机）退回单列：四方布局在竖屏里挤不下，宁可按顺序排。 */
    @media (max-width: 780px) {
      #board { grid-template-columns: 1fr; grid-template-rows: auto; }
      .seat.top, .seat.left, .center, .seat.right, .seat.bottom { grid-area: auto; }
      .seat.left .hand, .seat.right .hand { flex-direction: row; flex-wrap: wrap; max-height: none; }
      /* 单列时左右两家也变成横排手牌，副露跟着回到横排。 */
      .seat.left .tiles-area, .seat.right .tiles-area { flex-wrap: wrap; }
      .seat.left .melds, .seat.right .melds { flex-direction: row; flex-wrap: wrap; }
      input.text { min-width: 0; width: 100%; }
      .key-row { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <header id="bar"></header>
  <main>
    <section id="setup" class="panel">
      <h2>四家同屏 · 一台设备控制四个玩家</h2>
      <p class="hint">填四把邀请密钥，点「自动开局」会依次完成：四家登录 → 一家建房 → 三家加入 →
        全部准备 → 房主开局。之后四家的手牌分列上、下、左、右（0 号位在下，按出牌顺序顺时针排开），
        <strong>碰过 / 杠过的牌紧挨着那家的手牌摆</strong>，<strong>打出去的牌集中在中央弃牌区</strong>（四家各一格），
        每家的出牌与碰杠胡各自独立 —— 服务端是按座位脱敏的，这里看到的每张牌都来自对应那家自己的连接。</p>
      <p class="hint">⚠️ 「重来」只断开连接、<strong>不会退出房间</strong>：四家仍挂在原来那一局上，
        重连窗口内再点「自动开局」会自动回到同一局接着打；超过窗口就回不去了，
        而且那一局没结束前这四个账号建不了新房（服务端会拒），需要换一批账号。</p>
      <div id="keys" class="keys"></div>
      <div class="row">
        <button id="auto" class="primary">自动开局</button>
        <button id="again">重来</button>
      </div>
      <p id="status" class="hint"></p>
    </section>
    <section id="board" hidden>
      <div class="seat top" id="pos-top"></div>
      <div class="seat left" id="pos-left"></div>
      <div class="center" id="center"></div>
      <div class="seat right" id="pos-right"></div>
      <div class="seat bottom" id="pos-bottom"></div>
    </section>
  </main>
  <script>globalThis.__MYMJ_CONFIG__ = ${runtimeConfig};</script>
  <script type="module" src="/debug/browser/multi-client.js"></script>
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

  // 四家同屏：一台设备开四条连接，一个人打完整局。内测时不必真的凑四个人。
  app.get("/multi", async (_request: FastifyRequest, reply: FastifyReply) => reply
    .header("Cache-Control", "no-store")
    .type("text/html; charset=utf-8")
    .send(multiClientHtml(options)));

  app.get("/debug/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { "*"?: string };
    return serveDebugAsset(params["*"] ?? "", reply);
  });
}
