# 可用工具技能清单（面向 APK 打包与最终验收）

> 建立：2026-09-16 ｜ 更新：2026-09-16（同步到 `c082294`）
> 用途：把「打包 APK」这件本项目唯一还没做的事，落到可复用的技能上。
> 本文件只记录工具链与踩坑，不改变任何已确认的产品规则；规格以 `docs/PROJECT_STATUS.md` 为准。

## 0. 先看这一条：打包之前，先确认走得通

`PROJECT_STATUS.md` P0-5 已经写明：

> **棋牌类的版号与商店准入** —— 麻将类在国内商店普遍要求游戏出版物号、准入极严，
> 且**没有任何技术手段能绕过**。这条路没确认之前，不要先投入打包与签名的工作。

所以本文件的定位是：**内测分发与本地验证用**，不是上架路径。
`docs/DEPLOYMENT.md` 的 A 档（内存模式 + 公网 `/debug` 链接）**不需要 APK** ——
内测阶段让测试者用手机浏览器打开链接就能玩。真要做 APK，理由应该只是
「验证原生壳下的表现」，而不是「上架的必要步骤」。

## 1. 已安装的技能

三个技能都装在**用户级** `~/.workbuddy/skills/`，所有项目可用。

| 技能 | 版本 | 用途 |
| --- | --- | --- |
| `android-sdk-setup` | 1.0.0 | 配通 JDK + Android SDK —— **LayaAir 的 `android` 平台构建的前置条件** |
| `android-apk-builder` | 1.1.0 | 备选：绕开 LayaAir，自己用 WebView 壳 + d8 手打一个包 |
| `publisher` | 1.1.2 | 备选：上传 zip 交给第三方平台打包 |

### 1.1 首选路径：LayaAir CLI 自己构建（不需要装 IDE）

`docs/INTERNAL_TESTING.md` 第十节确认了这条路可行：

```powershell
layaair build web -p apps/apk          # 产物落 apps/apk/release/web
layaair build --list-platforms         # 共 19 个平台
```

- `web` 平台**可直接构建**，产物由服务端的 **`/app`** 挂出来（见 `PROJECT_STATUS.md` 4.28）。
- **`android` 平台需要 JDK + Android SDK —— 当前机器两个都没装**，所以 APK 暂时构建不了。
  这一步正是 `android-sdk-setup` 的职责。
- `/app` 跑的是 Web 平台，**验不到「原生 APK 上的选图与录音」**：那两个能力依赖
  标准 Web API（`<input type="file">` / `MediaRecorder`），在 Web 平台下走的是浏览器实现。
  只有真机装 APK，才能暴露「原生环境下发不了图、录不了音」这件事。

### 1.2 android-sdk-setup（打包的前置条件）

在 Windows 上不装 Android Studio，配好 JDK + Android SDK。

它会做这些事，**每一步都会先问用户**：下载 JDK 21（Adoptium）、下载 cmdline-tools、
用 sdkmanager 装 `platforms` / `build-tools` / `platform-tools`、
写用户级环境变量 `JAVA_HOME` / `ANDROID_HOME` / `ANDROID_SDK_ROOT` 与 `PATH`。

注意点：

- 解压 cmdline-tools 后**内层目录必须重命名为 `latest`**，否则 sdkmanager 找不到。
- `sdkmanager` 是 Windows `.bat`，在 Git Bash 里不能直接跑，要用 `cmd /c` 或 PowerShell 调用。
- 它会**修改用户级环境变量和 PATH**，且**必须重启终端**才生效。
- 它主要面向 Capacitor 项目（读 `android/variables.gradle`）；本项目 `apps/apk` 是
  LayaAir 工程，**没有 `android/` 目录** —— 版本号要按 LayaAir 导出的原生工程实际情况给，
  不要照抄文档里的 Capacitor 步骤。
- 想要模拟器仍然需要 Android Studio（没有独立的 AVD Manager）。真机 + USB 调试不受影响。

### 1.3 android-apk-builder（免 aapt2，备选）

绕开 LayaAir，自己写一个 WebView 壳，用 **JDK + d8.jar + jarsigner** 出可安装包，
不需要 aapt2 / 完整 Android SDK。

```bash
# 第 0 步：先验证 manifest 能生成（不需要 SDK，30 秒）
python scripts/build_apk.py --manifest-only \
    --out-dir ./build_output \
    --package com.mianyang.mahjong \
    --app-name "绵阳血战麻将"

python scripts/verify_manifest.py ./build_output/AndroidManifest.xml
```

第 0 步看到 `[OK] 结构与编码均符合要求` 再往下走——这一步能挡掉 90% 的失败。

```
android-project/
└── app/src/main/
    ├── java/com/mianyang/mahjong/MainActivity.java
    └── assets/www/index.html        ← LayaAir 的 web 产物放这里
```

```bash
python scripts/build_apk.py \
    --project ./android-project \
    --sdk-dir ./android-sdk \
    --out-dir ./build_output \
    --package com.mianyang.mahjong \
    --app-name "绵阳血战麻将" \
    --activity .MainActivity \
    --min-sdk 21 --target-sdk 34 \
    --permission android.permission.INTERNET \
    --permission android.permission.RECORD_AUDIO
```

`MainActivity` 必须**纯 Java 代码建 UI**，不能引用任何 `R.*`（没有资源编译环节）：

```java
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);                 // 会话与本地存储
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false); // 语音消息
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {  // 麦克风
                request.grant(request.getResources());
            }
        });
        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
    }
}
```

**只拿两个文件就够，不用下完整 SDK**：

```
platforms/android-34/android.jar
build-tools/34.0.0/lib/d8.jar        （zipalign 在同目录，可选）
索引：https://dl.google.com/android/repository/repository2-1.xml
```

**必须知道的边界**：

- **只做 V1 签名**：apksigner 会校验二进制 XML，而本方案是手写 manifest，必然失败；
  jarsigner 只签名 zip 条目、不解析 XML。所有 Android 版本都接受 V1，
  但**部分应用商店要求 V2/V3**。
- **没有 `res/` 资源 → 没有桌面图标**，装完是系统默认图标。
- **不能用 AndroidX、第三方库、XML 布局**。
- **`file:///android_asset/` 下 Android WebView 禁止 `getUserMedia`**（不是 Secure Contexts
  规范的问题 —— 规范里 `file` 是 potentially trustworthy，是 WebView 自己额外禁止；
  Google 官方 PermissionRequest 示例正因此改用 `SimpleWebServer` 走 `http://localhost`）。
  **这会让你在 APK 里必然复现「录不了音」**。要可用就得把页面从 `http://localhost:<port>`
  或 `https://appassets.androidplatform.net` 提供 —— 后者是 AndroidX 的 `WebViewAssetLoader`，
  与本方案「不引依赖」冲突；前者要自己塞一个极简静态服务器。**选路之前要把这点算清楚。**
  （这条已写进 `docs/INTERNAL_TESTING.md` §9，那里是权威版本。）
- 因此：**用于本地验证与内测分发；正式上架需要另走完整 AGP 工程。**

内置校验（自己说自己对不算数）：

```bash
python scripts/verify_manifest.py build_output/AndroidManifest.xml

pip install pyaxmlparser
python -c "from pyaxmlparser.axmlprinter import AXMLPrinter; \
print(AXMLPrinter(open('build_output/AndroidManifest.xml','rb').read()).get_xml().decode())"
```

看到 `android:versionCode`、`android:minSdkVersion` 就是对的；
**如果出现 `ns0:` 前缀，说明属性 namespace 填错**（见下）。

**脚本里已固化的坑位**（改脚本时别踩回去）：

1. 字符串池必须 **UTF-16**（flags=0）
2. namespace chunk 是 **24 字节不是 16**（写错后续 chunk 全部错位，报错完全看不出原因）
3. `minSdkVersion` / `targetSdkVersion` 必须整数编码 `TYPE_INT_DEC`(0x10)，不能是字符串
4. **属性的 ns 字段指向 URI 而不是前缀**。填 `"android"` 会让严格解析器忽略所有 `android:`
   属性——manifest 看着对，但 versionCode 全读不到，**且不报任何错，最难查**
5. `attributeStart` / `attributeSize` / `attributeCount` 是 uint16（`<H`）不是 uint32（`<I`）
6. 属性必须嵌在 start tag chunk 内部（紧跟 36 字节头）
7. `AndroidManifest.xml` 用 **ZIP_STORED 不压缩**
8. APK 里**不能有空目录条目**，`res/`、`META-INF/` 空项会让小米/华为/OPPO 安装器直接拒收
9. Android 12+ 带 intent-filter 的 activity 必须显式声明 `android:exported`
10. 负值用 `& 0xFFFFFFFF`

### 1.4 publisher（PushWebly，最后备选）

把 HTML 项目的 zip 上传到 `https://ai-pub.pushwebly.com`，平台打成 APK 并给出下载链接。

**使用前要知道的三件事：**

1. **把项目 zip 上传到第三方服务器**。本项目客户端资源不含密钥
   （牌墙与手牌只在服务端，见 `serialize()` 的约定），但**要确认 `apps/apk` 的构建产物里
   没有写死的服务端凭据或调试令牌**。
2. **它会在 `~/.publisher/config.json` 明文存用户名与密码**，且登录接口是
   「登录或注册」——账号不存在就直接建号。
3. 平台生成的包名固定为 `com.pushwebly.g<playToken>`，**不能自定义签名**。

## 2. 没有对应技能的环节

以下方向在推荐市场里检索过（麻将、棋牌、LayaAir、WebView 混合打包、游戏音效、
2D 渲染、websocket 联机），**没有可用技能**，只能自己写：

- LayaAir 牌桌渲染 —— **D1 已完成**，渲染层直接用 LayaAir 引擎 API，没有技能覆盖
- LayaAir 渲染层的图片预览与语音播放（`chat-model.ts` 目前仍是 `[图片]` / `[语音 N 秒]` 占位）
- WebSocket 联机层 —— 项目已有零依赖实现
- 音效 / BGM

## 3. 麻将牌面素材：已完成，不需要素材技能

`docs/ASSETS.md` 已登记：`apps/apk/assets/resources/tiles/` 下 27 张
（`wan_1..9` / `tong_1..9` / `tiao_1..9`，250×358 透明底 PNG，共约 368KB）。

- 来源 Wikimedia Commons「0101一萬」系列，**CC BY-SA 4.0**（作者 碧海风）
- **两条义务已记录在案**：App 内（关于/致谢页）署名；对外分发这 27 张图（含修改）
  继续按 CC BY-SA 4.0。只约束这批图片本身，不波及游戏代码
- **零义务备选已留档**：同分类的 `MJ1wan` 系列是**公有领域**（作者 shizhao），
  获取方式见 git 历史 `ea21a2c`。若将来对 CC BY-SA 的「相同方式共享」有顾虑，可换回
- 注意：牌框与数字是**黑色线稿 + 透明底**，深色界面渲染时要垫白色圆角底

因此原先把 `pixel-asset-forge` / `game-asset-generator` 列为「必需」已经**不成立**。
真要用到，场景只剩：按钮/面板底图、结算浮层样式、头像框这类 UI 装饰。

## 4. 可选补充（按需再装）

| 技能 | 用途 |
| --- | --- |
| `imagecraft-android` | 安卓图片压缩与格式转换规范流程，控制 APK 包体与图集膨胀 |
| `handoff` | 把对话压缩成交接文档给下一个协作者（呼应 `CONTRIBUTING.md` 第 5 节的开场提示词） |

## 5. 安装记录

```text
~/.workbuddy/skills/android-apk-builder/   v1.1.0
~/.workbuddy/skills/android-sdk-setup/     v1.0.0
~/.workbuddy/skills/publisher/             v1.1.2
```

三个技能的 SKILL.md 与脚本已做安全审查：`android-apk-builder` 的两个 Python 脚本无网络请求、
`subprocess.run` 用列表传参（无 `shell=True`）、`rmtree` 只作用于 `out-dir` 下的
`classes` / `dex` 子目录，未越界；`android-sdk-setup` 为纯文档、无脚本；
`publisher` 为纯 API 客户端、无本地脚本（风险点见 1.4）。
`publisher/SKILL.md` 的 S4 节有一段 JSON 代码块被截断且围栏未闭合（文档缺陷，不影响执行，
`.cursor/rules/publisher.mdc` 里是完整版本），已记录待上游修复。
