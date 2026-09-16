# 渲染层验证探针（jsdom）

这一层要回答的问题，单测和 HTTP 都答不了：

- **单测**能证明「暗杠该亮 1 张、扣 3 张」这类**数据**是对的，证明不了渲染器真的照它画 ——
  少一个 `append`、类名写错，数据全对而屏幕上还是四张亮牌。
- **HTTP 200** 只能证明文件取得到，证明不了 JS 跑得起来、更证明不了它把面板画出来了。

所以这里用 jsdom 把**真实的页面 + 真实的客户端模块**跑起来，然后去数 DOM 里的节点。

协议层的验收在别处（`apps/server/scripts/acceptance.mjs`），两层互补、不重复：
那一层验「服务端算得对不对」，这一层验「算对之后画不画得出来」。

## 前置

```powershell
pnpm install        # jsdom 出自根 devDependencies
pnpm build          # 客户端产物 apps/client/dist，下面多数脚本要先有它
```

## 脚本一览

| 脚本 | 页面从哪来 | 模块从哪来 | 要密钥 | 验什么 |
| --- | --- | --- | --- | --- |
| `check-countdown.mjs` | 不连服务端 | 本地 dist | — | 倒计时节点会不会被画出来、秒数真的在往下走 |
| `check-meld-dom.mjs` | 不连服务端 | 本地 dist | — | 暗杠只亮一张、其余三张扣着；牌数守恒 |
| `check-multi-page.mjs` | `PAGE`（默认线上） | 本地 dist | — | 页面加载后 DOM 被正确填充（输入框/按钮/顶栏） |
| `check-multi-play.mjs` | `PAGE`（默认本机 3000） | 本地 dist | ✓ 4 把 | 真打完一局：弃牌在中央、副露挨着手牌、牌块真被画出来 |
| `check-settlement.mjs` | `PAGE`（默认本机 3000） | 本地 dist | ✓ 4 把 | 结算界面显示番型与「谁给的牌」 |
| `probe-claims.mjs` | `PAGE`（默认本机 3000） | 本地 dist | ✓ 4 把 | 碰/杠/过 按钮出现过没有、各持续多久（同时盯协议帧与 DOM） |
| `check-remote.mjs` | `BASE`（默认线上） | **也从线上抓** | ✓ 4 把 | 线上那一份代码的完整表现 |

最实用的一个是最先写的那个：`check-countdown.mjs` 直接调渲染函数，
能把「渲染层没写对」与「数据没传到」当场分开 —— 省掉一整轮来回猜。

`check-remote.mjs` 的模块**从线上抓**，是因为本地 dist 与线上可能不是同一次构建
（部署把 dist 排除在上传之外、在沙箱里重新构建）。它按相对 `import` 做 BFS，
落到 `./remote/`（已 gitignore），然后从本地文件 import —— 跑的是线上那份代码。

## 环境变量

| 变量 | 用在 | 说明 |
| --- | --- | --- |
| `BASE` | `check-remote` | 线上根地址，默认 `https://mianyang-mahjong.app.workbuddy.host` |
| `PAGE` | 其余 | 页面地址，默认见上表 |
| `KEYS` | 四个对局脚本 | 4 把明文密钥，逗号分隔 |
| `SECONDS` | 对局脚本 | 采样上限秒数 |

## 跑法

不需要服务端的两项：

```powershell
node tools/domcheck/check-countdown.mjs
node tools/domcheck/check-meld-dom.mjs
```

要 4 把密钥的先建号（`seed-testers` 走的是管理接口，需要在 `apps/server` 下有 `.env`）：

```powershell
cd apps/server
node --env-file=.env scripts/seed-testers.mjs 甲 乙 丙 丁
# 台账 apps/server/.keys-ledger.txt 里就是 4 把明文密钥
cd ../..
$env:KEYS = "第1把,第2把,第3把,第4把"
node tools/domcheck/check-remote.mjs
```

## 改这些探针时，两条踩过的坑

1. **判据要用协议帧的时间戳，不能用界面文字。** 服务端一局结束时**只发结算帧、不发对局帧**，
   所以局间客户端手里的 match 停在结束**之前**的状态 —— meta 里写的还是「行牌」，
   界面上的「第 N 局」也还是「行牌」。曾有探针拿 meta 判断「是否还在局中」，
   于是**局间的检查被整个跳过**，无论有没有残留都报「0 个」—— 一条**假绿**。
   可靠判据是：最后一条 `round-finished` 比最后一条 `game` 帧更晚。

2. **抓线上模块必须加 cache-buster。** 已经踩过：源站已是新版，脚本读到的却是 CDN 里
   32 分钟前的旧副本，于是把「面板没画出来」误报成产品缺陷。
   另外「新局帧还在路上」是个**正常窗口**（线上更明显），断言不要容不得延迟。

**共同的教训**：断言本身也会错。新加的检查要能**真的失败**一次再算数 ——
不然它报的绿和没检查是一回事。
