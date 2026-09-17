# 公网部署（内测阶段）

目标：把服务端放到一台**有公网地址**的机器上，让不在同一个局域网的人也能打开链接打牌。

按「先能玩，再谈正式」分两档，先选一档照着做：

| | A. 最快能玩（内存模式） | B. 正式一点（域名 + HTTPS + PostgreSQL） |
| --- | --- | --- |
| 适合 | 今天就想让朋友连上试 | 要给一批人连着用几天 |
| 数据 | **重启即清空**（账号、房间、群） | 落库，重启不丢 |
| 访问地址 | `http://<公网IP>:3000/debug` | `https://<域名>/debug` |
| 语音消息 | **不可用**（浏览器只在 HTTPS / localhost 下给麦克风权限） | 可用 |
| 备案 | 不需要（用非 80/443 端口） | 域名指向国内服务器**需要备案** |
| 需要准备 | 一台有公网 IP 的机器 | 上面这些 + 域名 + 数据库 |

> **两档都必须开着 `/debug`**（`DEBUG_CLIENT` 别设成 `false`）。
> APK 与 LayaAir 的 Web 版都还没构建出来，`/debug` 是**目前唯一能用的界面**。

---

## 一、环境变量

服务端会自己读 `apps/server/.env`（用 Node 内建的 `process.loadEnvFile`，
路径相对源码/产物固定，**不受启动目录影响**）；没有 `.env` 就用进程已有的环境变量，
所以容器里直接注入环境变量也可以。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | ✅ | 至少 32 字符的随机串。**换掉它等于所有人同时下线**（旧令牌全部失效） |
| `ADMIN_ID` / `ADMIN_PASSWORD` | ✅（生产） | 首次启动用它引导出管理员；之后改密码不会被覆盖。生产模式下一个管理员都没有会**直接拒绝启动** |
| `HOST` | | 默认 `0.0.0.0`。**写成 `127.0.0.1` 时外面一律连不上**（最容易漏的一项） |
| `PORT` | | 默认 `3000`。容器/PaaS 会注入它，别在代码里写死 |
| `TRUST_PROXY` | 反代后必填 | 见下面「为什么必须有这一项」 |
| `NODE_ENV` | | 设 `production` 会**强制要求 `DATABASE_URL`**，并要求至少一个管理员 |
| `DATABASE_URL` | B 档 | PostgreSQL 连接串。不设 = 内存模式（A 档） |
| `DATABASE_SSL` | | 托管数据库要求 TLS 时设 `true` |
| `STORAGE_DRIVER` | 图片/语音 | `cos` 或 `local`；不设则**发不了图与语音**（接口返回 501，其余功能正常） |
| `COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` / `COS_REGION` | `cos` 时必填 | 腾讯云 COS |
| `PUBLIC_BASE_URL` | `local` 时必填 | 客户端可达的服务端地址（`https://域名`）；直传地址按它签发 |
| `STORAGE_SIGNING_SECRET` | | `local` 驱动签名的密钥，默认复用 `JWT_SECRET` |
| `DEBUG_CLIENT` | | **内测期间保持默认（开启）**；设 `false` 会关掉 `/debug` 与 `/app` |
| `PUBLIC_HOST` | | 只影响启动时打印的那行提示地址（方便复制），不影响监听 |
| `WS_PORT` / `WS_HOST` | | 只有需要把实时通道单独放一个端口时才设；**公网部署建议留空**（见下） |
| `PUBLIC_WEBSOCKET_URL` | | 同上，只在实时通道位于另一个入口时才设 |

### 为什么必须有 `TRUST_PROXY`

接口限流按 `request.ip` 计数（登录/激活按 IP）。不设这一项时 Fastify 用 socket 对端地址 ——
直连是对的，但**只要前面有 Nginx 或云负载均衡，这个地址就变成代理的地址**：
全站共用一个额度，一个人的操作会把所有人的登录额度吃光（登录是 30 次/分钟）。

- Nginx 与它在同一台机器 → `TRUST_PROXY=loopback`（最常用）
- 服务端口只对代理开放 → `TRUST_PROXY=1`
- 精确列出可信网段 → `TRUST_PROXY=1.2.3.4/32,10.0.0.0/8`

**直连部署（没有反代）时绝不能开** —— 那等于信任客户端自己填的 `X-Forwarded-For`，
谁都能伪造 IP 绕过限流。

---

## 二、A 档：最快跑起来

以一台 Linux 云服务器为例（Ubuntu/Debian 系）：

```bash
# 1. Node 22（本项目用到 process.loadEnvFile、全局 WebSocket 等，别用更老的）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable

# 2. 拉代码
git clone <仓库地址> /srv/mianyang-mahjong
cd /srv/mianyang-mahjong

# 3. 装依赖 + 构建（客户端也必须构建，/debug 的页面就是从它的产物发出去的）
pnpm install --frozen-lockfile
pnpm build

# 4. 配置
cd apps/server
cp .env.example .env 2>/dev/null || touch .env
# 编辑 .env，至少填：JWT_SECRET / ADMIN_ID / ADMIN_PASSWORD / HOST=0.0.0.0
chmod 600 .env

# 5. 起来
node dist/main.js
```

看到这几行就成了：

```
[admin] 已创建管理员 <你的账号>（密码来自 ADMIN_PASSWORD）
[websocket] 与 HTTP 共用端口 3000
[debug client] http://127.0.0.1:3000/debug
```

然后**放行端口**（两件事都要做，漏一个就连不上）：
云厂商控制台的**安全组**放行 TCP 3000；机器本身的防火墙（`ufw allow 3000/tcp` 或 firewalld）。

### 让它常驻（systemd）

```ini
# /etc/systemd/system/mymj.service
[Unit]
Description=Mianyang Mahjong server
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/mianyang-mahjong/apps/server
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
User=mymj
# 环境变量优先写在 apps/server/.env 里（服务端自己会读）
[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now mymj
sudo journalctl -u mymj -f          # 看日志
```

服务端自己处理 `SIGTERM`：退出前会把排队中的积分/流水写入排干，所以用 systemd/docker 停它是安全的。

### 发密钥，开始测

```bash
cd /srv/mianyang-mahjong/apps/server
node scripts/seed-testers.mjs 张三 李四 王五 赵六      # 一条命令建 4 个账号（各 2000 分）
node scripts/smoke.mjs                                # 自检
```

把 `http://<公网IP>:3000/debug` 和对应密钥发给测试的人。
**内存模式重启会清空一切**（含已签发的密钥），重启后重跑一次 `seed-testers.mjs` 即可。

---

## 三、B 档：加 PostgreSQL / 域名 / HTTPS

### 1. 数据库

```bash
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE USER mymj WITH PASSWORD '<强密码>';"
sudo -u postgres psql -c "CREATE DATABASE mymj OWNER mymj;"
```

`.env` 里加：

```
NODE_ENV=production
DATABASE_URL=postgres://mymj:<强密码>@127.0.0.1:5432/mymj
```

迁移由服务端启动时自动执行（`migrate()` 扫 `apps/server/db/migrations/`，按文件名顺序跑未应用的版本），
也可以手动跑：`node dist/migrate.js`。

### 2. Nginx 反向代理

**WebSocket 必须显式转发 `Upgrade` 头**——漏掉这一条的表现是「页面能打开、能登录，但一进房间就断线」。

```nginx
server {
    listen 80;
    server_name 牌桌.example.com;

    # 用 STORAGE_DRIVER=local 时必须放开：图片/语音会经过这里上传（单张最大 5MB）
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # ↓↓↓ 实时通道就靠这两行；漏掉就是「能登录、一进房间就断线」
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 300s;   # 牌局中途会有长时间不说话的连接
    }
}
```

同时 `.env` 里加 `TRUST_PROXY=loopback`（Nginx 在同机），否则限流会把所有人算成一个 IP。

### 3. HTTPS

浏览器只在**安全上下文**里给麦克风权限，所以**语音必须 HTTPS**（图片不受这条限制）。

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 牌桌.example.com
```

客户端按 `location.origin` 推导实时通道地址，HTTPS 页面自动用 `wss://` —— 这也是
**实时通道必须与 HTTP 共用同一个端口**的原因（`WS_PORT` 留空）。

> ⚠️ **国内服务器 + 域名**：解析到国内机房的域名要**先完成 ICP 备案**才允许用 80/443 对外提供服务。
> 没备案时：用 A 档（IP + 非标准端口）先跑，或者把测试放到境外/中国香港的机器上。

---

## 四、部署后自检

在**开发机**上（不是服务器上）对着公网地址跑，是最省事的验收方式 ——
三个脚本都认 `SERVER_BASE_URL`：

```bash
cd apps/server

# 1. 冒烟：页面能打开、静态资源齐、管理流程通、直传地址能签发
SERVER_BASE_URL=https://牌桌.example.com node --env-file=.env scripts/smoke.mjs

# 2. 端到端验收：真的四个人打完 8 局，40 项断言（自己签发账号）
SERVER_BASE_URL=https://牌桌.example.com node --env-file=.env scripts/acceptance.mjs
```

`acceptance.mjs` 会自己签发 5 个账号并各发 2000 积分，可反复跑；它跑通说明
登录、建房、按房间号加入、四人开局、8 局零和、断线重连、群聊实时推送、退出回房**在公网上都是通的**
（这正是最容易出问题的一批：反代、WSS、IP、限流）。

最后手工确认一次：**用手机浏览器**打开 `https://域名/debug`，输密钥进主页 ——
这一步验的是「手机上的真实网络环境」，脚本代替不了。

---

## 五、托管平台（PaaS / 一键发布）的额外注意

不用自己买机器、把服务端跑到托管平台（如本项目的 beta 环境
`https://mianyang-mahjong-beta.app.workbuddy.host/`）时，有四件事和自建服务器不同 ——
**每一条都实测踩过**：

1. **平台反代会占用 `Authorization` 头。** 现象是「管理员登录成功拿到令牌，
   但用这个令牌访问任何受保护接口都 401」。实测服务端收到的是**平台自己的令牌**，不是我们的。
   所以应用令牌一律走自定义头 **`X-Auth-Token`**（服务端 `authToken()` 首选它，回退
   `Authorization`），两个客户端的传输层与**三个脚本**都照此发送。
   自建 Nginx 不会有这个问题，但用自定义头是通吃的做法。

   ⚠️ **管理台页面（`admin-console.ts`）当时漏了这一条**，它仍把令牌放进 `Authorization` ——
   于是线上管理台「登录成功、紧接着所有接口 401、立刻掉回请登录」，管理员**根本发不出密钥**
   （本机复现不出来：本地两种头都收，只有线上才现形）。已改过来，
   并留了 `tools/domcheck/check-admin-console.mjs` 守着；**跑这个检查要指向线上**，
   打本机永远绿：
   ```bash
   PAGE=https://mianyang-mahjong-table.app.workbuddy.host/admin node tools/domcheck/check-admin-console.mjs
   ```
   以后再给管理台加接口，记得新请求也走 `api()`（它已经统一带上 `X-Auth-Token`）。
2. **`.env` 会被一起上传**，所以 `loadEnvFile` 能读到（`JWT_SECRET` / COS 密钥 / 管理员密码都在）。
   好处是免配置，代价是**平台侧能看到这些明文** —— 正式环境建议改用平台的环境变量注入。
3. **安装要加 `--ignore-scripts`**：沙箱里跑包的安装脚本会卡住或失败；
   运行时依赖都是纯 JS，不依赖构建脚本。
4. **启动命令不能内联环境变量**（`JWT_SECRET=x node ...` 不生效），
   而且要先按顺序把各 workspace 包 build 出来再起服务：
   `pnpm --filter @mianyang-mahjong/rules build && … && node apps/server/dist/main.js`。

另外：这类沙箱**没有数据库**，所以只能跑内存模式（重启清空）。
把账号建回来不用登进沙箱 —— 在本地对着公网地址跑一次就够：

```bash
cd apps/server
SERVER_BASE_URL=https://<你的公网地址> KEYS_LEDGER=./.keys-ledger.public.txt \
  node --env-file=.env scripts/seed-testers.mjs 张三 李四 王五 赵六
```

> 公网环境的账号密钥建议单独存一份台账（`KEYS_LEDGER` 指向另一个文件），
> 别和本地开发环境的密钥混在一份文件里 —— 两套环境的账号互相无效，混在一起很容易发错。

## 六、备份与运维

要备份的三样东西（都不进仓库）：

| 东西 | 位置 | 说明 |
| --- | --- | --- |
| 环境变量 | `apps/server/.env` | 含 `JWT_SECRET`、数据库密码、COS 密钥 |
| 密钥明文台账 | `apps/server/.keys-ledger.txt` | **邀请密钥是账号的唯一凭据**，丢了等于账号丢了 |
| 数据库 | PostgreSQL | `pg_dump mymj > mymj-$(date +%F).sql` |

日志目前是**关闭的**（`createApp` 里 `logger: false`），只有启动那几行和
`console.error` 出的异常。也就是说：**线上出问题基本只能靠用户描述**，排障会很难。
这是已知不足，正式上线前应补结构化日志（见下）。

---

## 七、上线前还欠的（别拿内测档直接对外）

- **合规**：ICP 备案、APP 备案、隐私政策与用户协议文本、Android 签名
- **结构化日志与监控**：现在没有请求日志 / 错误聚合 / 健康告警（`/health` 已就绪，可接探针）
- **对象存储生命周期**：群消息有 180 天保留策略，但 COS 桶上没有对应规则，**存储只增不减**
- **多实例**：限流计数、管理员登录失败锁定、幂等键存储都在**单进程内存**里 ——
  要水平扩容得先换成共享存储（如 Redis）
- **真机 UI**：LayaAir 的 APK / Web 版需要在装了 LayaAir IDE 的机器上构建，`/app` 才用得上
- **语音与图片在原生 APK 上的可用性**：两者都依赖标准 Web API，原生环境需要另做桥接
