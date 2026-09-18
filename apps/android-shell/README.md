# apps/android-shell — 麻雀精灵 Android WebView 壳

纯 WebView 壳，加载服务端 `/app`（LayaAir web 构建产物）。壳只负责系统能力桥接，
不做任何游戏逻辑；不依赖 AndroidX / Kotlin，依赖面最小。

## 能力边界

| 能力 | 实现点 |
|---|---|
| 横屏锁定 | manifest `screenOrientation="sensorLandscape"` + `configChanges` 防重载 |
| 网络权限 | `INTERNET` + `ACCESS_NETWORK_STATE`（HTTPS / WSS） |
| 麦克风 | `RECORD_AUDIO` 运行时权限；页面 `getUserMedia` → `onPermissionRequest` 按需申请 |
| 相册桥 | 页面 `<input type=file>` → `onShowFileChooser` → 系统图片选择器 |
| 返回键/手势 | WebView 可后退则后退；否则双击退出 |
| 后台恢复 | `onPause/onResume` 配对 + `saveState/restoreState`；断网重连由页面传输层负责 |

## 环境约定（本机）

- **JDK 23**：`C:\Program Files\Java\jdk-23`（无需 JAVA_HOME 全局变量，构建时显式传）
- **Android SDK**：`C:\Users\24386\Android\Sdk`（`local.properties` 已写，不进 git）
- **Gradle 8.10.2**：`C:\Users\24386\Android\gradle-8.10.2`；wrapper 的 distributionUrl 指向腾讯镜像
  （本机 HTTPS 到 services.gradle.org 的 GitHub 落点不通）

## 构建

```powershell
cd apps\android-shell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-23"
& "C:\Users\24386\Android\gradle-8.10.2\bin\gradle.bat" assembleDebug
# 产物：app\build\outputs\apk\debug\app-debug.apk
```

## 切换加载地址

默认 `https://0106.wiki/app`（BuildConfig）。不改代码临时换环境：在
`app/src/main/AndroidManifest.xml` 的 `<application>` 里加：

```xml
<meta-data android:name="app_url" android:value="https://<host>/app" />
```

## 工具链重建备忘（换机器时）

1. 下载 cmdline-tools：`https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip`，
   解压到 `<Sdk>\cmdline-tools\latest`。
2. 预写 license：`<Sdk>\licenses\android-sdk-license` = `24333f8a63b6825ea9c5514f83c2829b004d1fee`。
3. `sdkmanager --sdk_root=<Sdk> "platform-tools" "platforms;android-34" "build-tools;34.0.0"`。
4. Gradle 发行版走 `https://mirrors.cloud.tencent.com/gradle/`。
