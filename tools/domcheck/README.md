# 渲染层验证探针（jsdom，另有一档真浏览器）

这一层要回答的问题，单测和 HTTP 都答不了：

- **单测**能证明「暗杠该亮 1 张、扣 3 张」这类**数据**是对的，证明不了渲染器真的照它画 ——
  少一个 `append`、类名写错，数据全对而屏幕上还是四张亮牌。
- **HTTP 200** 只能证明文件取得到，证明不了 JS 跑得起来、更证明不了它把面板画出来了。

所以这里用 jsdom 把**真实的页面 + 真实的客户端模块**跑起来，然后去数 DOM 里的节点。
**只有尺寸**是 jsdom 永远答不了的，那部分交给 `check-board-geometry.mjs`（真浏览器）。

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
| `check-countdown.mjs` | 不连服务端 | 本地 dist | — | 小场那屏数字：只在牌桌上弹（绝对定位、无整屏遮罩）、**不出现牌型/牌面/明细/按钮**、倒计时在走、到点回调通知重画 |
| `check-meld-dom.mjs` | 不连服务端 | 本地 dist | — | 暗杠只亮一张、其余三张扣着；牌数守恒 |
| `check-two-click.mjs` | 不连服务端 | 本地 dist | — | 出牌要点两次、四家头像、只在有操作时显示按钮 |
| `check-match-points.mjs` | 不连服务端 | 本地 dist | — | 头像记整局累计（跨小场不清零）、一小场只在牌桌上弹四个数字、停留时长走完自动出整局结算记录（顶部时间行 + 四行玩家明细） |
| `check-multi-page.mjs` | `PAGE`（默认线上） | 本地 dist | — | 页面加载后 DOM 被正确填充（输入框/按钮/顶栏） |
| `check-multi-play.mjs` | `PAGE`（默认本机 3000） | 本地 dist | ✓ 4 把 | 真打完一局：弃牌在中央、副露挨着手牌、牌块真被画出来 |
| `check-settlement.mjs` | `PAGE`（默认本机 3000） | 本地 dist | ✓ 4 把 | 真打完一小场：牌桌上弹出四个零和数字，且**不出现**牌型/牌面/明细/按钮；`FULL_MATCH=1` 再打到整局结算，验开始时间 / 耗时与四行玩家明细（要几分钟） |
| `probe-claims.mjs` | `PAGE`（默认本机 3000） | 本地 dist | ✓ 4 把 | 碰/杠/过 按钮出现过没有、各持续多久（同时盯协议帧与 DOM） |
| `check-remote.mjs` | `BASE`（默认线上） | **也从线上抓** | ✓ 4 把 | 线上那一份代码的完整表现（⚠️ 验的是**已部署**的那份：改了没部署它会红，这正是它的用途） |
| `check-board-geometry.mjs` | `PAGE`（默认本机 3000） | 本地 dist | ✓ 4 把 | **牌块的几何尺寸**（宽高比、副露方向、溢出）—— 这个要真浏览器，见下 |
| `check-admin-console.mjs` | `PAGE`（默认本机 3012 `/admin`） | 服务端页面 | — | **管理台**：登录 → 签发 1 把密钥 → 明文当场显示；打印页面发出的每个请求及其状态码（红了能直接看出哪一步 401）。凭据从 `apps/server/.env` 读 |
| `check-lobby-flow.mjs` | `PAGE`（默认本机 3012 `/debug`） | 服务端页面 | ✓ 4 把 | **大厅整条路**：密钥登录 → 大厅 → 建群 → 群聊（文字 + 图片）→ 建房 → 分享名片到群 → 别人在群里点名片进房 → 另两人用房号进房 → 四人到齐房主开局（**且全程没有准备键**）；顺带验群主转让与指定管理员。四个标签页 = 四个玩家，跑一次约 2~3 分钟 |
| `check-takeover-flow.mjs` | 不连服务端 | 本地 dist | — | **牌桌菜单 / 退出二次确认 / 托管浮层 / 在场标识**：菜单必须是「继续游戏 / 返回大厅 / 退出游戏」三项且**不再有「返回房间」**、各按钮触发各自的动作；二次确认只有「取消 / 确认退出」两个出口且取消不会误退；托管浮层报「当前第 N/8 局」（用服务端下发的总小场数）、给「重新接管」、**不用整屏遮罩**（牌面要看得见）；在场徽标必须把「暂离」「托管中」「掉线」显示成**三个不同的词**（暂离 != 托管中，混用会让人以为"去大厅"等于"把座位交出去了"），且 `online` 不挂徽标、三种状态各带自己的类名 |

最实用的一个是最先写的那个：`check-countdown.mjs` 直接调渲染函数，
能把「渲染层没写对」与「数据没传到」当场分开 —— 省掉一整轮来回猜。

`check-remote.mjs` 的模块**从线上抓**，是因为本地 dist 与线上可能不是同一次构建
（部署把 dist 排除在上传之外、在沙箱里重新构建）。它按相对 `import` 做 BFS，
落到 `./remote/`（已 gitignore），然后从本地文件 import —— 跑的是线上那份代码。

### 为什么有一个探针非要用真浏览器

`check-board-geometry.mjs` 是这里唯一不用 jsdom 的：**jsdom 没有布局引擎**，
`getBoundingClientRect()` 一律返回 0。而「左右两家的牌被拉成 3:1 的长条」
「侧边副露横着摆」这类缺陷，DOM 结构完全正确、只是尺寸不对 ——
数节点一个都数不出来，必须真的量像素。

`check-admin-console.mjs` 也用真浏览器，理由不同：它要验的是**页面自己发出去的请求**。
管理台曾经把令牌放进 `Authorization` 头，而托管平台的反代会占用那个头，
结果是「登录成功（那是唯一不带令牌的请求）、紧接着任何接口都 401」，管理员发不出密钥。
**拿 curl 自己拼头是验不出来的** —— 自己拼的头跟页面真正发的不是一回事；
只有让页面自己跑，才能量到它到底发了什么。它默认打本机，但**这个缺陷只在线上复现**：

```bash
PAGE=https://mianyang-mahjong-table.app.workbuddy.host/admin node tools/domcheck/check-admin-console.mjs
```

它用 CDP 驱动无头 Chrome / Edge（**两个都没有就打印「跳过」并退出 0，不算失败**：
这条检查依赖本机装了什么，不该让没装的人每次看到凭空的红）。
在几档视口下各量一遍，是因为**缩放一致性也是这类缺陷的一部分** ——
只在一个尺寸下对，换个窗口就散架的情况真发生过。

手牌取自真实对局，副露则用**真实的 `meldBox()` 注入最坏情况**（1 碰 + 3 杠 = 14 张）：
「等这一局里真的有人碰」等不到时会变成假绿，压不到内圈的溢出边界。

## 环境变量

| 变量 | 用在 | 说明 |
| --- | --- | --- |
| `BASE` | `check-remote` | 线上根地址，默认 `https://mianyang-mahjong-table.app.workbuddy.host` |
| `PAGE` | 其余 | 页面地址，默认见上表 |
| `KEYS` | 四个对局脚本 | 4 把明文密钥，逗号分隔 |
| `SECONDS` | 对局脚本 | 采样上限秒数 |
| `CHROME` | `check-board-geometry` | 浏览器可执行文件，默认按 Chrome / Edge 的常见安装位置找 |
| `SHOT` | `check-board-geometry` | 给个 png 路径就把 1280px 那一档截图存下来，方便肉眼看 |

## 跑法

不需要服务端的四项：

```powershell
node tools/domcheck/check-countdown.mjs
node tools/domcheck/check-meld-dom.mjs
node tools/domcheck/check-two-click.mjs
node tools/domcheck/check-match-points.mjs
node tools/domcheck/check-takeover-flow.mjs
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

量几何那一项同样要 4 把密钥（本机起服务即可，不用线上）：

```powershell
$env:KEYS = "第1把,第2把,第3把,第4把"
$env:SHOT = "$PWD\board.png"      # 可选，想肉眼看就加上
node tools/domcheck/check-board-geometry.mjs
```

> ⚠️ **每轮验证都重新建一批账号，别把同一批反复用。**
> 服务端是内存模式（没配 `DATABASE_URL`），房间里还留着上一场的对局状态；
> 同一批账号跑过一两轮之后，新连接就进不到牌桌上了 —— 表现为
> 「弃牌格应为 4 个」「中央弃牌区一张牌都没有」「采样期间没走到结算」，
> 看起来像是界面坏了，其实是账号残留。
> **先重新 seed 一批再跑，不要先去怀疑代码。**
> 反过来也一样：服务端一重启，账号、密钥、房间全部清零，旧的 `KEYS` 会直接登不进去。

## 改这些探针时，两条踩过的坑

1. **判据要用协议帧的时间戳，不能用界面文字。** 服务端一局结束时**只发结算帧、不发对局帧**，
   所以局间客户端手里的 match 停在结束**之前**的状态 —— meta 里写的还是「行牌」，
   界面上的「第 N/8 小场」也还是「行牌」。曾有探针拿 meta 判断「是否还在局中」，
   于是**局间的检查被整个跳过**，无论有没有残留都报「0 个」—— 一条**假绿**。
   可靠判据是：最后一条 `round-finished` 比最后一条 `game` 帧更晚。

2. **抓线上模块必须加 cache-buster。** 已经踩过：源站已是新版，脚本读到的却是 CDN 里
   32 分钟前的旧副本，于是把「面板没画出来」误报成产品缺陷。
   另外「新局帧还在路上」是个**正常窗口**（线上更明显），断言不要容不得延迟。

**共同的教训**：断言本身也会错。新加的检查要能**真的失败**一次再算数 ——
不然它报的绿和没检查是一回事。
