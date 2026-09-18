# LayaAir 客户端第一阶段审计与网络 PoC

日期：2026-09-18  
分支：`feature/laya-client`  
基线：`fc3c8a4`

## 结论

现有 `apps/apk` 已经是 LayaAir 3.4 客户端，不需要再建一套 `apps/laya-client`。它只依赖
`@mianyang-mahjong/client`，复用现有 REST、WebSocket、协议类型和页面流；麻将规则、发牌、
胡牌判定、计分和托管仍全部留在服务端。

Node.js + PostgreSQL + WebSocket 后端可以同时服务现有 Web 客户端和 LayaAir 客户端，
第一阶段不需要修改后端协议。

## 当前技术栈

- pnpm workspace + TypeScript。
- `apps/client`：无前端框架的 DOM 调试客户端，以及不依赖 DOM/LayaAir 的共享客户端核心。
- `apps/apk`：LayaAir 3.4.0 + TypeScript，页面由代码创建。
- `apps/server`：Fastify REST + 自有 WebSocket 服务，默认 HTTP/WS 同端口。
- `packages/domain` / `packages/rules`：服务端领域与麻将规则；LayaAir 客户端不引用规则包。

## REST 复用

- 登录：`POST /v1/auth/login`、首次激活 `POST /v1/auth/activate`、账号密码登录
  `POST /v1/auth/account`。
- 当前用户：`GET /v1/me`，返回积分、资料和可返回的 `activeRoom`。
- 大厅：复用当前用户、群聊、好友和战绩接口，没有新增 Laya 专用接口。
- 房间：`POST /v1/rooms`、`POST /v1/rooms/join`、`GET /v1/rooms/:roomId`、
  `POST /v1/rooms/:roomId/seat/presence`、离房及解散投票等现有接口。
- 鉴权继续使用 `X-Auth-Token`；会产生副作用的请求沿用现有幂等键。

## WebSocket 协议

- URL 默认由 HTTP 同源地址变换协议得到：`http → ws`、`https → wss`。
- 对 `https://0106.wiki` 会自动得到 `wss://0106.wiki`，没有硬编码公网域名、局域网 IP 或旧 tunnel。
- 连接后第一帧为 `{ type: "auth", token, roomId? }`。
- 服务端帧：`ready`、`room`、`game`、`actions`、`round-finished`、
  `match-finished` 以及群聊帧和 `error`。
- 玩家操作：`start`、`swap` / `auto-swap`、`missing` / `auto-missing`、`discard`、
  `claim`、`self-draw`、`concealed-kong`、`added-kong`、`quit`、`request_takeover`。
- 客户端只显示服务端 `actions` 列表允许的按钮；服务端仍会再次校验所有动作。

## 状态语义

- `game.state` 是当前玩家专属的脱敏 snapshot。
- `control`：`human` / `trustee`，由服务端权威下发。
- `away`：玩家主动返回大厅；不等于断线，也不改变控制权。
- `presence`：`online` / `away` / `disconnected` / `trustee`，由服务端推导。
- `roundDelta`：当前小场累计；`matchDelta`：跨 8 小场的整局累计。
- `round-finished`：单个小场结算、下一小场等待时间和公开牌面。
- `match-finished`：整局结果、`rawDeltas` / `accountDeltas`、玩家结算行。
- 重连按 0.5、1、2、4、8 秒退避；成功后重放 auth、roomId 和群订阅，服务端重新下发 snapshot。

## 隐私边界

- snapshot 顶层 `hand` 只包含当前账号自己的手牌。
- 其他三家只有 `handSize`，没有 `hand` 字段。
- 对手暗杠的牌值可为 `null`，客户端不能从本地规则推断或补齐。
- 网络 PoC 对以上约束有自动断言。

## 本次修复

1. 项目构建脚本现在会主动寻找 `~/.layaair/layaair(.cmd)`，不再依赖新终端刷新 PATH。
2. `PlayerSettings.json` 从新 UI 模块 `ui2` 改为经典 UI 模块 `default`。
   当前代码使用 `Laya.Box` / `Label` / `TextInput`；选择 `ui2` 时浏览器会报
   `Laya.Box is not a constructor`，页面只剩空背景。
3. 补齐 `SocialDialogs.ts.meta`。
4. 新增真实网络 PoC：Laya HTTP/WebSocket 适配器连接本机 Fastify/WebSocket 服务，覆盖
   4 人登录、`/v1/me`、建房、进房、开局、snapshot、合法 `auto-swap`、断线重连和手牌脱敏。

## 运行与验证

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @mianyang-mahjong/apk laya:build:web
pnpm vitest run apps/apk/test/network-poc.test.ts
pnpm test
```

Web 构建产物在 `apps/apk/release/web`。本机服务启动后访问 `/app/`；结尾斜杠不能省略。

## 下一阶段

现有页面按 `750×1334` 竖屏设计。进入牌桌视觉阶段时，应把房间/牌桌改为横屏布局，
同时保持登录和大厅的移动端适配。先做四家方位、头像、昵称、`matchDelta`、手牌/牌背、
弃牌区、剩余牌数、当前行动方、服务端授权按钮和第 N/8 局；仍不把任何规则搬进客户端。

Android 先走 Laya Web + Android WebView 验证，再评估 Laya Native。正式 APK、签名、商店发布、
麦克风和文件选择兼容均不属于本阶段。
