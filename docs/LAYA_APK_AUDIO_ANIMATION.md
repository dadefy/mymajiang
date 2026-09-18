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

## 声音架构

`AudioManager` 分 BGM、SFX、Voice、UI 四类，设置项为音乐/音效/语音的开关与音量以及震动开关。按钮点击属于本地 UI 反馈；摸牌、出牌、碰、杠、胡、自摸、换三张、定缺、结算、托管与接管必须由服务端确认帧或新 snapshot 触发。`eventId` 去重，避免 reconnect 重放声音。

资源约定：

```
apps/apk/assets/resources/audio/
  bgm/  sfx/  voice/  ui/
```

目前只建立路径契约，没有放入任何有版权风险的音频文件。

## 动画架构

调用顺序固定为：接收服务端状态 → 立即渲染最终 snapshot → 提交可选表现事件。动画关闭、掉帧、切后台或中途取消都不会改变最终 UI 或发送 action。`AnimationCoordinator` 用 snapshot revision 丢弃旧动画，用 eventId 避免重连重复播放。

表现事件覆盖：选牌抬起、出牌飞行、最近弃牌高亮、摸牌入手、碰/杠/胡、胡型、分数飘字、行动方向、最后三秒、换三张、定缺、小局结算和大局结算。具体 Tween/粒子节点由牌桌 UI 开发者接入，本任务不修改 `RoomPage`。

## 素材审计

已有：27 张麻将牌 PNG（万/筒/条各 1–9）、LayaAir 默认启动占位图，以及 Laya UI 默认 comp 图集中的通用按钮、输入框、滚动条、复选框等。这些 comp 资源是引擎模板资源，不能当作最终麻将美术验收。

缺少：全部 BGM 与事件音效；男女/方言语音版本；按钮点击与倒计时音；版权清晰的默认头像；横屏桌布与牌河底纹；最终按钮/状态图标（网络、离线、away、托管、音量、振动、返回）；胡/碰/杠特效；品牌启动图；Android adaptive icon（foreground/background/monochrome）；通知图标；商店截图。

素材必须自制、委托并取得商业授权，或使用明确允许商业分发与改编的许可，并保存作者、来源、许可文本和取得日期。

## 进入 APK 阶段的门槛

1. 确认包名、App 名、最低/目标 SDK、versionName/versionCode 规则。
2. 准备 JDK、Android SDK、完整 AGP 工程与真机测试设备。
3. 完成 AssetLoader、安全区、返回键、前后台、音频焦点和运行时权限桥接。
4. 准备自有签名与 CI secret，补齐图标、启动图和有授权的音频。
5. 真机验证刘海/挖孔、三键与手势导航、Wi-Fi/蜂窝切换、锁屏恢复、弱网重连和至少 30 分钟牌局。
