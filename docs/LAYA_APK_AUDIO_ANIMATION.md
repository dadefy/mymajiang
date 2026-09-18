# LayaAir APK 前置、声音与动画表现层

## 路线结论

当前项目最稳的第一版是 **Laya Web 构建 + 标准 Android WebView 壳（完整 AGP 工程）**。现有 HTTP、WebSocket、同源配置和浏览器联调成果都可以原样复用；Laya Native 会引入另一套运行时、原生桥接与兼容性验证，当前没有足够收益抵消风险。Laya Native 可在 WebView 真机性能数据证明 Canvas 性能不足后再评估。

WebView 不应从 `file://` 加载。使用 AndroidX `WebViewAssetLoader` 的 `https://appassets.androidplatform.net`，或只监听 loopback 的内嵌静态服务器。首选 AssetLoader：它有可信 HTTPS 源、没有本地端口生命周期问题，也为以后麦克风/相册权限桥接留出正确基础。

## Android 宿主最小 PoC

- Kotlin/Java + Android Gradle Plugin 的独立壳工程，嵌入 `apps/apk/release/web`；当前不生成正式 APK。
- manifest 固定横屏，Activity 使用沉浸式 edge-to-edge；把 WindowInsets（display cutout、systemBars、navigationBars）经 `MyMahjongAndroid.safeArea()` 传给 Laya。
- WebView 启用 JavaScript、DOM storage、混合内容禁用、文件访问禁用；只允许应用资源域和配置的 API 域。
- Android 返回键依次处理 Laya 弹层、房间菜单、页面返回；仅根页面再次返回时结束 Activity。
- `onPause` 停 BGM/Voice、取消纯表现动画并发送 away；`onResume` 读取最新 snapshot 后恢复表现。锁屏走同一路径。
- 网络切换只触发已有 `ClientFlow` 重连；宿主不缓存或重放 action。恢复后以新 snapshot 全量重绘。
- 音频焦点：短 SFX 可 duck，BGM 遇 transient loss 暂停，永久 loss 停止；来电/蓝牙切换不改变牌局状态。
- 调试包使用 debug keystore；发布包的 keystore、alias、密码进入 CI secret，绝不进仓库。正式前确定 `versionCode` 单调递增、`versionName` 语义版本。

建议预留：包名 `com.dadefy.mymajiang`、App 名称“绵阳血战麻将”。这两项目前只是候选，创建壳工程前需由产品最终确认。

## 声音与动画的调用链

```
服务端状态（flow 的 Screen）
   → ScreenHost.render：先渲染完这一帧
   → PresentationDirector.observe：两帧差分 → 表现事件（带稳定 eventId）
   → AudioManager / AnimationCoordinator
   → LayaAudioDriver / LayaAnimationDriver
```

**全应用只有 `ScreenHost.render` 一个观察点。** 麻将规则、domain、服务端代码、页面渲染函数里都不许出现
`playSound(...)` / `Laya.SoundManager.play(...)` / `Tween.to(...)`：表现事件一律从 `PresentationDirector` 派发，
时长一律从 `animation-spec.ts` 的 `DURATION_MS` 取。要加一个声音或动画，先在这里登记事件，再让页面把帧交进来。

三条不变量（`presentation-director.test.ts` 逐条有断言）：

1. **只跟在服务端已成立的状态后面** —— 事件全部由两帧之差推出，不预测下一步。
2. **同一帧重复渲染不发任何事件** —— 2.5 秒轮询、结算屏自绘、F5 回到同一状态都是安静的。
3. **重连不重放历史** —— 进房第一帧与轮次倒退的旧帧只对齐持续态，不补播动画。

## 事件词表与别名映射

仓库里已有的 cue 名（`draw` / `discard` / `kong` / `button` …）被别处的代码和测试引用着，
所以**保留旧名、只补缺口、不做批量重命名**。任务书那套语义名通过 `CUE_ALIASES` 落进来：两边都接受，
只有一份资源、一条路径契约。**新增事件必须先查这张表，不要再发明第三种名字。**

| 任务书事件 | 代码里的规范 cue | 可接受的别名 | 音量组 | 触发方式 |
| --- | --- | --- | --- | --- |
| `ui_click` | `button` | `uiClick` | ui | 本地：`widgets.ts` 的全局点击钩子 |
| `ui_back` | `uiBack` | — | ui | 本地入口 `notifyUi("uiBack")`（返回键属 A2 宿主，尚未接） |
| `tile_draw` | `draw` | `tileDraw` / `tilePick` | sfx | 服务端差分：手牌恰好多一张且轮到自己 |
| `tile_select` | `tileSelect` | — | sfx | 本地：`RoomPage.toggleTile` 点起一张 |
| `tile_discard` | `discard` | `tileDiscard` | sfx | 服务端差分：某一座弃牌数增加 |
| `peng` | `peng` | — | sfx | 服务端差分：副露数增加且不是杠 |
| `gang` | `kong` | `gang` | sfx | 服务端差分：新增副露是杠 |
| `hu` | `hu` | — | sfx | 服务端差分：某一座 `won` 由 false 变 true |
| `pass` | `pass` | — | ui | 本地 `notifyPass()`（状态差分推不出「过」，见下） |
| `turn_notify` | `turnNotify` | — | ui | 服务端差分：只在自己被叫到时响 |
| `countdown_warning` | `countdown-3` / `countdown-1` | `countdownWarning` | ui | 自有定时器：最后 5 秒、最后 1 秒两档 |
| `trustee_on` | `trustee` | `trusteeOn` | ui | 服务端差分：`control` 变 `trustee` |
| `trustee_off` | `takeover` | `trusteeOff` | ui | 服务端差分：`control` 离开 `trustee` |
| `round_finish` | `round-finished` | `roundFinish` | sfx | `lastResult` 换新对象 |
| `match_finish` | `match-finished` | `matchFinish` | sfx | `lastMatchResult` 换新对象 |
| `message_receive` | `messageReceive` | `message` | ui | 聊天页最后一条消息 id 变化，且不是自己发的 |

表外还有三条既有事件沿用原名：`self-draw`（自摸强调）、`swap`（换三张）、`choose-missing`（定缺），
以及 `countdown-2`（与 `countdown-3` 共用同一份资源，保留是为了不动旧引用）。

### 防叠爆参数

| 名称 | 值 | 作用 |
| --- | --- | --- |
| `SAME_CUE_COOLDOWN_MS` | 70 | 同一个 cue 的最短间隔；碰完紧接着胡是两回事，不受影响 |
| `BURST_LIMIT` / `BURST_WINDOW_MS` | 4 / 120 | 非 BGM 音的并发上限，超了**直接丢**：少响一声远好过听不清谁在动 |
| `PLAYED_EVENTS_CAP` | 400 | 已播 eventId 容量，插入序淘汰，防长局内存泄漏 |
| `PLAYED_CAP`（动画） | 600 | 同上，动画侧 |

`eventId` 由 director 合成：牌局事件 `${roomId}:${round}:${kind}#${序号}`，倒计时 `${roomId}:${deadlineAt}:warn-${档}`。
服务端帧里没有事件 id，所以这一层由客户端负责，但**同一轮同一档天然只有一条记录**，重连拿到旧帧也响不出来。

### 音量分组与设置接口

三组各自独立，互不牵连：`musicVolume`（BGM，默认 0.55）、`effectsVolume`（SFX + UI，默认 0.8）、`voiceVolume`（默认 1），
另有 `musicEnabled` / `effectsEnabled` / `voiceEnabled` 与 `vibrationEnabled`。

```ts
audio.setMusicVolume(v) / setSfxVolume(v) / setVoiceVolume(v)   // 入参 clamp 到 0~1，同值不重设
audio.configure({ musicEnabled, effectsEnabled, voiceEnabled, vibrationEnabled })
audio.mute() / audio.unmute() / audio.muted
animations.setEnabled(false)                                    // 关掉即收掉在途动画与两个环
presentationControls(presentation)                              // 交给设置页的那组能力面
```

`mute()` 只翻 `masterMuted`，**不改三组各自的音量值**，取消静音按原值恢复；驱动实现了可选的
`setVolume(category, volume)` 时滑杆拖动即时生效，不用等下一声。

### BGM 与语音的当前状态

- **BGM：接线完成、素材未到位（implementation ready / asset pending）。** 三档场景音乐 `lobby` /
  `waitingRoom` / `game` 的路径契约已定（`resources/audio/bgm/bgm_*.mp3`），三行全部 `ready: false`，
  所以只记录意图、不发起请求。素材要求：东方休闲 / 古筝 / 笛子 / 轻打击；不要战斗音乐、EDM、高频鼓点、长时间压迫感。
  拿到授权素材后把 `ready` 打开即可，调用方一行都不用改。
- **语音：只有运行时内容（runtime-only）。** `playVoice(path)` 放玩家录音，走语音组。
  报牌语音（喊「碰！」「胡！」）在 `VOICE_ANNOUNCEMENTS` 里占位且 `ready: false` —— 要真人录音、
  男女声与方言版本，未授权前点了只会 404。这一轮碰/杠/胡先靠**强调音效**给手感。

## 动画规范

时长全部集中在 `animation-spec.ts` 的 `DURATION_MS`（按 cue 索引，漏一个编译就红），取推荐区间的中段：

| 事件 | 时长 | 事件 | 时长 |
| --- | --- | --- | --- |
| `select-tile` | 140 | `pass` | 160 |
| `draw` | 210 | `turn-highlight` | 320 |
| `discard` | 220 | `countdown-final` | 320 |
| `last-discard` | 250 | `swap` / `choose-missing` | 420 |
| `action-buttons` | 180 | `round-finished` | 250 |
| `peng` | 250 | `match-finished` | 420 |
| `kong` | 290 | `screen-transition` | 320 |
| `hu` | 480 | 呼吸环一个来回 | 2000 |

出牌节奏约 1.5 秒一手，所以除胡与结算外全部压在 350ms 内，且**任何一条都不许挡住下一次操作**。

- **覆盖层 `mouseThrough`**：动画在放，牌照样能出。它是 `ScreenHost` 在所有页面之后 `addChild` 的一次，压在最上层但不吃点击。
- **可取消**：`TRANSIENT_CUES`（选牌、出牌、摸牌、最近弃牌、轮转高亮、操作按钮、换三张、定缺、分数飘字）
  表现的是「此刻的牌桌位置」，新快照一到就按事件名打断；碰/杠/胡/结算/托管这些**强调类不在其中**，
  否则服务端随后那帧必然把它们掐掉，玩家永远看不到胡牌那一下。
- **销毁后不再跑**：`AnimationCoordinator` 与 `AudioManager` 各有 `disposed` 闸门，`dispose()` 之后
  驱动收不到任何新调用；页面销毁路径见 `ScreenHost`。
- **环类资源**用冻结的 `ring_active_player` / `ring_countdown_track` / `ring_countdown_fill`：
  `ring_countdown_fill` **按角度裁剪**（`graphics.drawPie` 画扇形当 mask），不缩放整圈；呼吸环只动
  alpha 与不超过 1.045 的微缩放，整环不许闪。
- **倒计时配色**：>10 秒正常、≤10 秒金色、≤5 秒朱红，**只换环的颜色**，不做整屏闪烁。
- **胡**：朱红「胡」印章 + 金色光圈 + 短暂强调，没有页游式大爆炸；**大局结算**靠层次，不铺粒子。
- 性能取向：只用 Tween / alpha / scale / position / mask，不做实时模糊、大量粒子、高频滤镜、多层重阴影、超长骨骼动画，Android 真机优先。

### 仅靠状态差分推不出来的事件

写在 `PresentationDirector.NOT_DERIVABLE_FROM_STATE` 里，**没有为了触发动画去改业务协议**：

- `pass`：碰与「过」之后 `melds` 都不变，`actions` 的变化也区分不开谁放弃 → 现在由玩家点「过」时 `notifyPass()` 本地触发。
- `self-draw` 与点炮的区分：要等结算帧的 `result.wins[].method`，摸牌那一帧推不出来。
- 对手弃牌的**飞牌**动画：需要三家牌河的镜像坐标，那属于牌桌布局（不在本次改动范围）→ 目前三家弃牌只有音效。
- `countdown-final` 动画刻意不由 director 自动触发：`RoomPage` 在 ≤3 秒时已经在闪读秒文字，再叠一层就是整屏闪烁。

## 接线范围（最小接入）

方案是「只挂事件出口」，不重写任何渲染逻辑：

- `ScreenHost`：`createPresentation(stage)` 一处装配 + 一次 `addChild(overlayNode)` + `render()` 末尾 `director.observe(screen)`。
- `RoomPage`：一个可选构造参数、`toggleTile` 里一行选牌、认领按钮回调里一行 `notifyAction`（放在 `send` 里面，被锁挡下的重复点击不该再闪一下）。没有改 `renderHand` / `updateClock` / 牌桌坐标 / `table-layout.ts`。
- `widgets.ts`：`setTapSoundHook(...)` 一个全局钩子，让「点击响一声」只有一处接线，也避免 UI 反向 import 表现层造成环。
- `Main.ts`：**未改**。生命周期 `onBackground()` / `onForeground()` 已经暴露，等 A2 的 Android 桥接调用。
- 设置页（`SocialDialogs.settingsDialog`）**未改**，只提供了 `presentationControls()` 这组能力面。

### 已知问题（只报告，未改）

`RoomPage.toggleTile` 用 `rest` 的下标去标记选中项，却用数组下标读 `hand[selected]`；
当刚摸上来那张在排序后不落在末位时，取到的牌值会偏一格。这属于牌桌渲染（其他座位的代码），
本任务只登记，不动它。

## 素材审计

已有：27 张麻将牌 PNG（万/筒/条各 1–9）、LayaAir 默认启动占位图，以及 Laya UI 默认 comp 图集中的通用按钮、输入框、滚动条、复选框等。这些 comp 资源是引擎模板资源，不能当作最终麻将美术验收。

**本轮新增的声音全部是占位素材，不得描述为最终产品音频。** `tools/audio/generate-placeholder-sfx.mjs`
离线合成（22050Hz / 单声道 / 16bit WAV，脚本可重复执行、结果按 sha256 稳定），落在
`apps/apk/assets/resources/audio/{sfx,ui}/placeholder_*.wav`，逐条登记在
`apps/apk/assets/resources/audio/audio-manifest.json`（`status: "placeholder"`，含时长与哈希）。
它们只用于验证接线是否通、有没有叠爆，不模拟真实商业麻将录音，也不含任何真实录制素材。
冻结动画资源（环、托管/接管图标）从 `mj-icon-design` **只读复制**到 `resources/animation/`，沿用牌面在
`resources/tiles/` 的既有约定，没有另起新目录。

`.wav` 与 manifest 目前**没有** `.meta`（PNG 都有），等 Laya Web 构建验证是否需要。

缺少：全部 BGM 与语音（含男女声与方言版本）；正式的按钮点击与倒计时音；版权清晰的默认头像；横屏桌布与牌河底纹；最终按钮/状态图标（网络、离线、away、托管、音量、振动、返回）；胡/碰/杠的正式特效；品牌启动图；Android adaptive icon（foreground/background/monochrome）；通知图标；商店截图。

素材必须自制、委托并取得商业授权，或使用明确允许商业分发与改编的许可，并保存作者、来源、许可文本和取得日期。

## 进入 APK 阶段的门槛

1. 确认包名、App 名、最低/目标 SDK、versionName/versionCode 规则。
2. 准备 JDK、Android SDK、完整 AGP 工程与真机测试设备。
3. 完成 AssetLoader、安全区、返回键、前后台、音频焦点和运行时权限桥接。
4. 准备自有签名与 CI secret，补齐图标、启动图和有授权的音频。
5. 真机验证刘海/挖孔、三键与手势导航、Wi-Fi/蜂窝切换、锁屏恢复、弱网重连和至少 30 分钟牌局。
