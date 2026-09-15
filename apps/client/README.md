# 客户端核心（@mianyang-mahjong/client）

APK 客户端的**业务骨架**：协议类型、REST 调用、实时通道、页面流。
这一层完全不依赖 LayaAir 或 DOM —— 它只产出纯数据（`Screen`），
渲染由外层负责。

## 分层

```
src/transport.ts     两个缝：HttpTransport / SocketTransport（唯一与运行环境相关的地方）
src/protocol.ts      服务端响应与 WS 帧的类型镜像（必须与 apps/server 一一对应）
src/api-client.ts    REST 客户端：所有调用返回 ApiResult，错误码按语义分类
src/match-socket.ts  实时通道：auth 握手、断线重连（重放 auth 与群订阅）
src/flow.ts          页面流：密钥登录 → 主页 → 建房/进房 → 行牌，产出 Screen
```

## 为什么要两个传输接口

LayaAir 的网络 API 与浏览器不同。核心代码只认 `HttpTransport` 和
`SocketTransportFactory` 两个接口：

- 浏览器 / 调试页：用 `fetch` 与 `WebSocket` 各写一个十几行的适配器；
- LayaAir：用引擎自带的网络对象实现同样两个接口；
- 测试：用 `test/fakes.ts` 里的假传输。

除此之外的代码在三个环境里**一字不改**。

## 页面流

`ClientFlow.current` 是当前页面，四种取值：

| 页面 | 出现时机 |
| --- | --- |
| `key-entry` | 输入邀请密钥 |
| `profile` | 密钥有效但还没建过账号（服务端返回 `KEY_ACTIVATION_REQUIRED`） |
| `home` | 已登录：我的信息、群列表、战绩 |
| `room` | 在房间里：房间快照 + 实时牌局状态 + 当前允许的动作 |

渲染层订阅 `flow.onChange(...)`，每次拿到一个新的 `Screen` 对象，直接渲染即可。
业务代码不做任何 DOM / 引擎操作。

## 约定

- **不抛异常**：REST 调用返回 `ApiResult`，实时错误以 `{ kind: "error" }` 事件出现。
  界面要把它们当成正常分支来画。
- **错误码来自服务端**：`KEY_ACTIVATION_REQUIRED`、`KEY_REVOKED`、
  `ACCOUNT_NOT_ACTIVE`……`flow.ts` 里只做中文文案映射，不要在这里新增业务码。
- **协议漂移要在编译期暴露**：`src/protocol.ts` 与服务端同步改动；
  两端不一致会先在这里炸出来。

## 测试

```powershell
pnpm vitest run apps/client
```

`test/fakes.ts` 提供假 HTTP / 假 socket；`test/flow.test.ts` 覆盖
页面流的所有转移，包括断线重连提示与被移出群后的订阅清理。
