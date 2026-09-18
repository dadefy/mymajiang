# LayaAir 客户端第二阶段：横屏牌桌收尾

日期：2026-09-18  
分支：`feature/laya-client`  
基线：`fc3c8a4`（第一阶段审计见 [LAYA_CLIENT_PHASE1.md](./LAYA_CLIENT_PHASE1.md)）

## 本阶段做了什么

第一阶段把 LayaAir 客户端从「能登录、能进房、能收到脱敏 snapshot」推到了
「横屏牌桌画得出来」。本阶段**不重做**那些内容，只把牌桌的**状态机边界**收干净：
一小场结束、下一小场开始、整局结算、断线重连、托管/接管、away、倒计时、四家方位映射、
横屏 resize，以及只由服务端 `actions` 驱动的操作按钮。

## 修复清单

### 1. `round-finished` 结算那屏从来不显示（`apps/apk/src/ui/RoomPage.ts`）

`renderResult()` 原来用 `this.match === null` 判断「这一小场结束了」：

```ts
const live = result !== null && !this.resultDismissed && this.match === null;
```

但服务端一小场结束时**只发 `round-finished`、不发 `game` 帧**（见 `apps/server/src/ws-server.ts`
的 `broadcastState`：`phase === "finished"` 时走结算分支后直接 `return`）。所以客户端的
`match` 会停在结束**之前**的状态（`playing` / `claiming`），那个判据一次都不会成立
—— 结果就是四家得失分那屏压根不渲染，看起来像「结算功能消失了」。

改成认 flow 已经下发的 `roundFinished`（收到结算帧、还没等到下一小场的第一帧）：

```ts
private popVisible(): boolean {
  return roundPopIsLive({
    hasResult: this.lastResult !== null,
    hasMatch: this.match !== null,
    roundFinished: this.roundFinished,
    popUntil: this.popUntil,
    matchSettled: this.lastMatchResult !== null,
  });
}
```

判据本身收在 `landscape-table.ts` 的 `roundPopIsLive()` 里 —— 那一层不依赖任何 Laya 节点，
所以能用单测钉住（见 `apps/apk/test/landscape-table.test.ts`）。

### 2. 打满 8 小场时，最后一小场那屏被整局结算挤掉

原来那屏的前置条件是 `this.lastMatchResult === null`，而 `match-finished` 一到
`lastMatchResult` 就非空 —— 于是最后一小场那屏直接被跳过，整局结算立刻压上来。
但 flow 里明确写着 `roundPopUntil` 在 `match-finished` 之后**有意不清**：

> 打满 8 小场时没有下一小场，但最后一小场那屏仍要显示满停留时长再交接给整局结算记录。

现在按「显示到 `popUntil` 为止」处理，到点由 `popTimer` 重画一次交接给结算记录。
另外牌桌在该屏期间保持可见（那屏是**压在牌桌上**的，不是整屏浮层）。

同时补了一个 `popUntil === null` 且整局已结算时的兜底：那时不会再有下一帧，
不能让那屏永远占着位置，否则结算记录永远出不来。

### 3. 结算期间旧按钮残留

`round-finished` 只更新 `lastResult` / `roundFinished`，**不动 `actions`** ——
所以那一小段窗口里 `this.actions` 还是结算前那一份，`renderControls` 会把
「打出 X万」这类按钮继续画在结算那屏上（点了也只会被服务端拒）。

加了一个渲染期的 `liveActions`，与浏览器端
`single-table.ts: const actions = screen.roundFinished || trustee ? [] : screen.actions;`
同一判据。新一局的 `game` + `actions` 帧随后就到（服务端 `sendPlayerState` 两帧一起发），
所以不需要自己重拉。

### 4. 缺牌强制打出没在 UI 生效

服务端 `MahjongGame.discard()` 对「手里还有缺门牌」的手牌会拒非缺门牌：

```ts
if (this.hasMissingTiles(player) && tileSuit(tile) !== player.missingSuit) {
  throw new Error("Missing suit tiles must be discarded first");
}
```

浏览器端对应地把可选牌收窄到缺门（`DiscardSelection.canSelect`）。Laya 侧有现成的
`discardableIndexes()`，但 `renderHand()` 没用它，**能点任意一张牌**；而且它的单测
在第一阶段被删掉了（函数成了死代码）。现在恢复使用 + 恢复那条单测。

### 5. 设计分辨率切换不生效（`apps/apk/src/ui/ScreenHost.ts`）

`applyStageSize()` 只改了 `stage.designWidth` / `designHeight`。查 LayaAir 3.4 的运行时
（`release/web/libs/laya.core.js`）可以确认这两个是**普通字段**：

```js
updateCanvasSize(e){ e ? (this._needUpdateCanvasSize || (this._needUpdateCanvasSize = !0, l.systemTimer.callLater(this, this.updateCanvasSize))) : this.setScreenSize(...) }
set scaleMode(e){ this._scaleMode != e && (this._scaleMode = e, this.updateCanvasSize(!0)) }
```

`scaleMode` / `alignH` / `alignV` 都有 setter 会触发重新布局，`designWidth` / `designHeight`
没有 —— 光赋值不会重算，舞台要等到窗口 resize 才算一遍。

`Main.setupStage()` 之所以没问题，是因为它把 `scaleMode` 从项目配置的 `fixedheight`
改成了 `SCALE_SHOWALL`，那个 setter 顺手触发了布局。而进牌桌时 `scaleMode` 没变
（setter 是等值判断过的），所以横屏一直没生效 —— 画面会继续按竖屏那套比例铺。

修法是显式补一次重新布局：

```ts
this.stage.designWidth = landscape ? TABLE_WIDTH : DESIGN_WIDTH;
this.stage.designHeight = landscape ? TABLE_HEIGHT : DESIGN_HEIGHT;
this.stage.updateCanvasSize(true);
```

### 6. 整局结算浮层不该依赖「上一小场的结算」存在

整局结算浮层原来要读 `lastResult.winnerSeats` / `wins`，守卫写成
`if (!live || result === null || settled === null)` —— 只要 `lastResult` 为空，
结算记录就永远不显示。

**先说清楚这条的真实性**：协议上 `round-finished` 永远先于 `match-finished`
（同一个 `broadcastState` 里先发结算帧、再发整局帧），所以线上并不会出现
`lastResult` 为空而 `lastMatchResult` 非空。这条改动是**防御性的**：
让「整局结算」这一屏不依赖另一份包，读不到就当流局处理。

参照浏览器端 `matchResultPanel(result, snapshot, round = null)` 的写法：
`winnerSeats` 取 `[]`（显示「流局」）、得失分退回 `settled.rawDeltas`、
四行退回 `settled.players`（它自带 `seat`）。顺带把标题按 `reason` 区分
「打满 N 小场」/「中途解散 · 已打 N 小场」。

### 7. 牌局期间「返回大厅」的节点没收起来

`RoomPage` 里那个「返回大厅」是直接挂在 `this.view` 上的，位置 `(30, 980)`，
而 `renderAll()` 从来没有管过它的可见性。牌局期间它虽然被 `matchArea`
（`(0,72)` 起、1920×1008）盖住看不见，但**节点仍在场景树里**，
按坐标做的命中判定也仍然可能命中它 —— 而牌局中「返回大厅」的正确入口是牌桌菜单里那个
（语义是"暂离"、控制权不变），不是这个。

现在它跟着 `inProgress` 一起收掉。这条是真实浏览器验证里发现的：
away 流程一直走不通，就是因为点到了这个被盖住的旧按钮。

### 8. 房间被解散时四家会永远停在冻结的牌桌上

`poll()` 原来在牌局中**完全不轮询**：

```ts
const needsRefresh = !this.snapshot || status === "waiting" || (status === "playing" && this.match === null);
if (!needsRefresh) return;
```

理由是"牌局中实时通道推一切"。但**房间状态的变化实时通道并不推**：
`POST /v1/rooms/:roomId/dissolve` 与 `.../dissolve/vote` 是直接改房间状态
（`room.requestDissolve` / `voteDissolve`），**不经过 `broadcastState`**，
所以服务端一个字节都不发（`ws-server` 里只有群聊的 `dissolved` 事件，没有对局的）。

实测（见验证表「中途解散」一行）：走真实 REST 投满 3 票解散后，四个客户端
**40 秒内一直显示「房间号 405032 · 对局中」**，牌局阶段还在被服务端推进，
客户端既不知道房间已经结束，也永远不会收到结算。

改成牌局中也继续轮询，但**只在快照指纹真的变了时才重画**（`renderAll()` 会把牌桌整棵
`removeChildren` 重建，每 2.5 秒白重建一次会闪、也会打断玩家正在做的选牌）。
这样解散/结束会在一拍内反映到标题栏，昵称也不会再退化成「玩家N」。

**光有轮询还不够。** 第一次复验时轮询已经在跑、快照也确实更新了，标题栏却依然是
「对局中」—— 因为 `renderAll()` 那行是：

```ts
this.statusLabel.text = `${number} · ${this.match ? STATUS_NAMES.playing : …}`;
```

手上只要还留着一帧对局帧就一律写「对局中」，把房间状态整个盖掉了。所以还要让
**房间的 `finished` / `dissolved` 优先于对局帧**：

```ts
export function effectiveRoomStatus(roomStatus, hasMatch) {
  if (roomStatus === "finished" || roomStatus === "dissolved") return roomStatus;
  if (hasMatch) return "playing";
  return roomStatus;
}
```

判据同样收在 `landscape-table.ts` 里，可单测（`room status text` 一组）。

**还差一道。** 第二次复验标题栏能报「已解散」了，但会**在「已解散」和「对局中」之间来回跳**
—— 因为 `show()` 每次都无条件把 flow 那份快照盖上来：

```ts
this.snapshot = screen.snapshot ?? this.snapshot;
```

而 `Screen.snapshot` 是**进房那一刻**取的，牌局中 flow 不再刷新它；房间页自己的轮询拿到的
才是最新的。每收到一帧对局帧就走一遍 `show()`，于是刚查到的「已解散」又被那份旧的盖回去。
房间状态是单向的，终态不该被更早的快照覆盖：

```ts
export function acceptRoomSnapshot(current, incoming) {
  if (current === "finished" || current === "dissolved") return incoming === current;
  return true;
}
```

同样收在 `landscape-table.ts` 里，可单测（`keeps a terminal room status …` 一条）。

> 服务端侧的正解应该是让解散也走 `broadcastState` 发一帧（或在解散时停掉该房间的
> 活动对局）—— 那属于 room lifecycle，本阶段没有碰。

### 9. 头像优先用对局帧自带的那份

`renderSeatPanels` 的头像原来只从房间快照取（`snap?.avatarUrl`）。对局帧
`MatchState.players[]` 其实自带 `avatarUrl`，每帧都有 —— 改成快照取不到时退回它。
昵称对局帧不带，仍然只能靠快照。

## 真实四客户端浏览器验证

环境：LayaAir 3.4 Web 构建 + 本机 Fastify/WebSocket（内存库）+ 四个真实 Chromium
（`agent-browser --session` 隔离会话），四个账号同时进同一房间打完整局。

| 验证项 | 结果 |
| --- | --- |
| 横屏牌桌 | 进房后 `designWidth/Height` 由 750×1334 切到 **1920×1080**，画布重算为 1006×566（`SCALE_SHOWALL`，窗口 1258×566）。**这正是修复 5 的效果** —— 修之前画布停在竖屏那套比例，牌桌只看得见左上角一块 |
| 四家 seat 映射 | 四家各自视角都是「自己固定在底部」，另外三家按相对 seat 落在 左/上/右。实测：seat0 → 底/右/上/左，seat1 → 底/右/上/左（青竹落左）…四家全部正确 |
| 隐私 | 每家只看到自己的 `hand`（13/14 张），对手只按 `handSize` 画牌背（39/40 张 = 其余三家手牌数之和）。四家一致 |
| actions 只由服务端驱动 | 非自己回合 `enabledTiles = 0`（手牌画着但点不动）；只有服务端下发 `discard` 的那一家手牌可点 |
| 倒计时 | 显示服务端 `actionDeadlineAt` 的剩余秒数并逐秒递减（12s→10s→9s…），≤5s 转红 |
| 换三张 / 定缺 | 两个阶段都能走完，按钮为「自动选择」/「自动」 |
| 碰 / 杠 / 胡 / 过 | 四家各自偏好不同，整局里 **碰 / 杠 / 胡 / 过 都被真实点到并成功执行**（各家点击计数：碰 9/9/271/0、杠 0/0/42/0、胡 2、过 18/31/14/38） |
| round-finished | 局间那屏真的出现，内容是四家得失分：`0 号位 青竹 -2 / 1 号位 听雨 +12 / 2 号位 晚风 +4 / 3 号位 小满 -14`。**修复 1 之前这屏一次都不会渲染** |
| 下一小局 | 第 1/8 → 2/8 → … → 8/8 逐局推进，牌河/手牌/按钮都随新局重建（`renderMatch` 每次 `removeChildren`），没有旧牌河或旧按钮残留 |
| match-finished | 四家都出现「本局结算记录 · 打满 8 小场」，含开始时间/耗时、流局、四行「昵称(ID) / 本场累计 / 牌面 / 账号入账·余额」 |
| 结算后不可操作 | 结算浮层上按钮只有「继续」，`enabledTiles = 0`；点「继续」后浮层收起且不再回来（再点一次 `not-found`） |
| 中途解散 | 走真实 REST（`/dissolve` + 两票 `dissolve/vote`）投满 3 票 → 房间 `status: dissolved`。**修复 8 之前**：四家 40 秒内一直显示「对局中」，完全没反应；**修复 8 之后**：标题栏在一拍内变成「已解散」 |
| TRUSTEE | p4 走牌桌菜单「退出游戏」→ 自己视角出现「你的牌局正在托管中 + 重新接管」、`enabledTiles = 0`；另外三家看到「小满 · 托管中」 |
| request_takeover | p4 点「重新接管」→ `control` 回到 `human`，托管浮层消失，另外三家不再显示「托管中」 |
| away | p3 走牌桌菜单「返回大厅」→ 回到大厅，另外三家看到「晚风 · 暂离」，**`control` 不变**（不是托管）；从大厅「返回我的房间」回来直接接着打 |
| disconnect / reconnect | p2 硬断网再恢复：页面回到 room，局数/手牌/阶段全部恢复；**场景节点数 374 → 374，没有重复创建 UI 节点** |
| resize | 1600×900 → 画布 1600×900；1024×1366（竖窗口）→ 画布 1024×576 居中留边，手牌 13 张全在同一 `y`（无重叠）。三种视口下座位/头像/按钮都不重叠 |
| JS 错误 | 整局跑完，四个客户端的 `window.onerror` / `unhandledrejection` / `console.error` 收集器**全为空** |

## 观察到的（非本阶段修复范围的）问题

### 1. 服务端动作定时器链会断，整局卡死（已做成最小复现）

浏览器验证里打到第 8/8 局时卡在「等待响应」，四家 `actions` 全空、八十多秒不复位。

为了把它从「偶尔卡一次」变成可复现的东西，写了一个**无浏览器的**最小复现
（`stall-repro.mjs`，仓库外）：复用 `apps/client/dist` 的 `ApiClient` / `ClientFlow` /
`FetchHttpTransport` / `BrowserSocketTransportFactory`（Node 22 自带 `fetch` 与 `WebSocket`），
四个客户端跑一整局。把服务端超时调到 `playTimeoutMs=200 / claimTimeoutMs=150 /
interRoundPauseMs=0` 之后，**一整局 8 小场只要 30~70 秒**，非常适合压测。

卡死指纹（复现输出）：

```
!!! 卡死：12.2s 没有对局帧，阶段=playing
    甲: actions=[]  control=human  ...
    乙: actions=[discard]  control=human  ...   ← 服务端说"你可以出牌"，但没人推进
    丙: actions=[]  control=human  ...
    丁: actions=[]  control=human  ...
```

要点：

- **四家都是 `human`、都在线**，不是托管/断线引起的；
- 卡住的那一家**服务端已经下发了 `actions: ["discard"]`**，但既没人推进、服务端也没代打；
- 把注入（硬断线 / 返回大厅再回房 / 退出托管再接管）**全部关掉**照样能复现 ——
  所以跟 away / reconnect / trustee 那几条路径**无关**，是动作定时器链本身的问题。

看过 `ws-server` 之后，链断在哪有两种可能，都在 `scheduleAutoActions` 的定时器回调里：

```ts
const timer = setTimeout(() => {
  if (seatEpochOf(active, player.seat) !== armedEpoch) return;          // ← 放弃，且不再挂表
  if (active.game !== game || game.allowedActions(player.id).length === 0) return;  // ← 同样放弃
  try {
    game.autoAct(player.id);
    void broadcastState(active).catch(() => undefined);                 // ← 只有走到这里才会重排定时器
  } catch {
    // 状态已由另一操作推进时忽略过期定时器。
  }
}, delay);
```

**「放弃」和「`autoAct` 抛错」都不会重新挂表**，而重新挂表只发生在 `broadcastState` 里。
只要最后一次广播之后没有任何一家的操作再触发一次 `broadcastState`，这一局就永远停在那里。
`catch` 里那句注释假设「状态已由另一操作推进」—— 但那个"另一操作"如果不存在，就没人接棒了。

**属 `apps/server` 范畴，本阶段未修改。** 复现脚本与统计在仓库外
（`C:/Users/24386/abkit/stall-repro.mjs`、`run-stall-stress.sh`）。

**发生频率**：把注入全关掉（`MODE=none`）反复跑同一局，**约 1/10 轮**会卡住
（已观测 2 次真卡死 / 约 24 轮；同一配置既有卡死的也有跑完的，所以是竞态而不是必然）。
注意这是个**概率性**问题 —— 单跑一两局很可能看不到，得成批跑。

**没做到的事**：没能钉死是哪一次广播之后链断的。要定位到那一步需要在
`ws-server` 里加日志（记录每次 `scheduleAutoActions` 挂了几张表、哪些回调放弃了），
而那属于 `apps/server`，本阶段没碰。

### 2. 快照缺失时昵称退化成「玩家N」
`playerName()` 从房间快照取昵称，快照为空时退化成 `玩家${seat}`。对局帧本身**不带昵称**，
所以这条只能靠「让快照一直保持新鲜」来压窄（修复 8 的轮询已经做到：牌局中也每 2.5 秒刷一次）。
头像那边已经改用对局帧自带的 `avatarUrl` 兜底（修复 9），所以现在只有昵称还留着极短的窗口。

顺带核实过一个更值得担心的假设：`snapshot.players[seat]` 是不是真的按座位排？
`RoomPlayerView` 上**没有 `seat` 字段**，服务端送的是 `[...room.players.values()]`，
而 `room.players` 是 `Map`、顺序就是入座顺序，座位号也按入座顺序分配 —— 同源，所以成立。
牌局期间更不会破：开局后服务端禁止任何人离房，不存在"退出再进来导致 Map 顺序错位"。
这条已写成注释钉在 `playerName` 上。

### 3. 房间已解散但服务端的活动对局还在跑
phase D 里房间 `status` 已经是 `dissolved`，服务端却仍在推进牌局
（客户端收到的对局帧阶段在 `行牌中` / `等待响应` 之间继续变）。同样属 room lifecycle，未修改。

## 测试

- `apps/apk/test/network-poc.test.ts`
  - 新增 `LayaAir HTTP transport` 一组：201 且 `data` 为 `null` 时从 `responseText` 取体、
    200 两条路径、204 空响应体三种写法、4xx JSON 错误体、确认 `send` 收到 `"text"`、
    以及状态码拿不到时 `NETWORK_ERROR`。
    **这一组是补 201 修复的回归覆盖** —— 原来的端到端 PoC 用的替身永远把 `data`
    设成解析好的对象，一次都走不到那条兜底路径。已实测：把兜底改回 `request.data`
    时这一组会挂 4 条。
  - 新增可编程替身 `ScriptedHttpRequest`：让用例自己决定 `data` 与 `http.responseText`
    各是什么，才能把 Laya 3.4 的缺陷本身复现出来。
- `apps/apk/test/landscape-table.test.ts`
  - 新增 `round pop visibility` 一组（8 条）：局间显示 / 新一局第一帧到达后收掉 /
    没有结算帧不显示 / 过点收掉 / 服务端不给停留时长时显示到下一帧 /
    打满 8 小场时交接给结算记录 / 最后一小场那屏放满停留时长再交接。
  - 新增 `room status text` 一组（5 条）：房间终态优先于对局帧 / 终态不被更早的快照覆盖 /
    没有对局帧时退回房间状态 / 两者都没有时不显示。
- `apps/apk/test/table-model.test.ts`
  - 恢复被删的 `forces missing-suit discards until that suit is empty`
    （文件现已与基线逐字节一致）。

全量：`pnpm test` **531 passed**（基线 510，新增 21 条）。

## 怎么再跑一遍这套验证（踩过的坑）

Laya 是画布应用，DOM 里没有控件，所以驱动方式和普通网页完全不同：

1. **`agent-browser` 的 daemon 不跨命令存活**（在这个环境里每次调用都是冷启动）。
   整个验证必须塞进**同一次** shell 调用里，否则浏览器会退回 `about:blank`。
2. **`open` 要前台跑 + 把输出重定向到文件**。不重定向会被 SIGTERM；
   丢后台又会在 shell 退出时被连坐杀掉，浏览器随即 `ERR_CONNECTION_REFUSED`。
   联调用的服务端同理，得由脚本自己起、自己收。
3. **别用 CLI 的 `mouse move/down/up` 点画布** —— 一次点击三条命令太慢。
   往页面里注入一段辅助脚本，用合成 `PointerEvent` + `MouseEvent` 打 `canvas`，
   就能触发 Laya 的事件系统，一次 `eval` 一次点击；还能顺手在页面里跑自动驾驶
   （150ms 一拍），整局自己打完。
4. ⚠️ **Laya 的 `node.visible` 是每个节点自己的**：把父节点藏起来**不会**改子节点的
   `visible`。判断"这个控件现在在不在屏幕上"必须沿父链查一遍，
   否则会把隐藏页面里的按钮当成可见的（当初就是这么误判出「大厅上有『返回我的房间』」的）。
5. 坐标换算：`screen = canvasRect.origin + 设计坐标 × min(canvasW/designW, canvasH/designH)`，
   居中偏移按 `SCALE_SHOWALL` 补上。`Laya.stage.designWidth/Height` 会随页面变
   （牌桌 1920×1080，其余 750×1334），所以每次点击都要现算。
6. 验收用 `window.Laya` 直接读场景图（节点数、文本、可见性、坐标），
   比截图更硬；`window.onerror` / `unhandledrejection` / `console.error` 都挂上钩子，
   整局跑完断言为空。



## 开发边界

本阶段只动了：

- `apps/apk/**`（渲染层、传输层、测试）
- `docs/LAYA_CLIENT_PHASE2.md`（本文件）

`apps/server/**`、`packages/domain/**`、`packages/rules/**`、积分逻辑、room lifecycle、
TRUSTEE / reconnect 服务端逻辑、WebSocket 协议、Cloudflare、数据库 migration **均未改动**
（`git status` 对这三个目录为 0 处改动）。

## 验证命令

```bash
pnpm build
pnpm typecheck
pnpm --filter @mianyang-mahjong/apk laya:build:web
pnpm vitest run apps/apk/test/network-poc.test.ts
pnpm test
```

四个真实浏览器客户端的联调脚本不在版本库内（放在 `C:/Users/24386/abkit/`），
因为它是本机联调的临时工具；要复现的话照着上一节的验证表重建即可。
