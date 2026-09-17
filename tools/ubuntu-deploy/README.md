# Ubuntu 服务器部署套件

把本项目跑到一台**自己的 Ubuntu 机器**上当服务器用的脚本。
跟 `tools/deploy/`（托管平台 PaaS 用的启动脚本）是两回事，别混。

完整的环境变量清单与原理说明在 `docs/DEPLOYMENT.md`，这里只讲怎么落地执行。

## 三份文件在干什么

| 文件 | 在哪台机器上跑 | 干什么 |
| --- | --- | --- |
| `99-upload-from-dev.sh` | **开发机**（Windows / Git Bash） | 打包仓库（排除 node_modules / dist / .env / 密钥台账）并传到服务器 |
| `01-os-setup.sh` | 服务器 | 基础包 → Node 22 → pnpm → PostgreSQL（建库建角色）→ 运行账号 `mymj` →（可选）防火墙 |
| `02-deploy-app.sh` | 服务器 | 装依赖 → 构建 → 生成 `.env` → 装 systemd 服务 → 启动 → `/health` 自检 |
| `mymj.service` | — | systemd 单元模板，`02` 会替换占位符后装到 `/etc/systemd/system/` |
| `nginx-mymj.conf` | 服务器（可选） | Nginx 反代，含 WebSocket 的 `Upgrade` 头 |

**顺序：先传代码，再跑 `01`，最后跑 `02`。**
`01` 要从 `package.json` 里读 `packageManager` 决定装哪个版本的 pnpm —— 代码不在就只能装最新版
（`02` 会再对齐一次，但少一次折腾）。

## 最短路径（IP 直连）

```bash
# ① 开发机（Git Bash）—— 用非 root 账号也行，远端会自己 sudo
bash tools/ubuntu-deploy/99-upload-from-dev.sh lab@<服务器IP>

# ② 服务器
ssh lab@<服务器IP>
cd /srv/mianyang-mahjong

# 国内机器一定加上 NPM_REGISTRY：官方源实测 82 KB/s，npmmirror 是 2.9 MB/s
sudo NPM_REGISTRY=https://registry.npmmirror.com bash tools/ubuntu-deploy/01-os-setup.sh

sudo NPM_REGISTRY=https://registry.npmmirror.com \
     PUBLIC_BASE_URL="http://<服务器IP>:3000" \
     bash tools/ubuntu-deploy/02-deploy-app.sh
```

`02` 跑完会打印一行**管理员密码**（`ADMIN_ID=local-developer`）——
**只打印这一次**，当场抄走。之后改密码走 `/admin` 或 `POST /v1/admin/password`。

访问 `http://<服务器IP>:3000/debug`。

关于端口放行，**两处要分开看**：

1. 云厂商控制台的**安全组** —— 如果用云主机，必须自己放行 TCP 3000
2. 机器自己的防火墙 —— `01` 默认**不动**（`OPEN_PORT=skip`）。
   机器上没开 ufw 就不用管；要开 ufw 就显式跑一次
   `sudo OPEN_PORT=3000 bash 01-os-setup.sh`

> ⚠️ 这条路是**纯 HTTP**，有两个代价：**语音消息用不了**（浏览器只在 HTTPS / localhost
> 下给麦克风权限），以及密钥与聊天内容在公网上是**明文**的。只在临时内测时这么用。

## 加域名 + HTTPS（语音可用）

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp tools/ubuntu-deploy/nginx-mymj.conf /etc/nginx/sites-available/mymj
sudo sed -i 's/desktop.example.com/你的域名/' /etc/nginx/sites-available/mymj
sudo ln -sf /etc/nginx/sites-available/mymj /etc/nginx/sites-enabled/mymj
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名

# 关键：告诉服务端它前面有代理（否则限流会把所有人算成一个 IP）
sudo sed -i 's/^# *TRUST_PROXY.*/TRUST_PROXY=loopback/' apps/server/.env
sudo sed -i 's#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://你的域名#' apps/server/.env
sudo systemctl restart mymj
```

> ⚠️ **国内服务器 + 域名要先 ICP 备案**才允许用 80/443 对外提供服务。
> 没备案时：用上面的 IP 直连档先跑，或者把机器放到境外 / 中国香港。

## 部署完之后怎么验

在服务器上（`apps/server` 目录，`.env` 就在那儿）：

```bash
cd /srv/mianyang-mahjong/apps/server
sudo -u mymj node --env-file=.env scripts/smoke.mjs        # 冒烟：接口 + 静态资源链路
sudo -u mymj node --env-file=.env scripts/acceptance.mjs   # 端到端：四个人打满 8 局
```

`acceptance.mjs` 会自己签发账号，不用预先 seed。
（它原先断言「内存模式下战绩返回 501」，带数据库的部署返回 200 会被误判成失败 —— 已改成两种都认。）

**真浏览器**那一条在开发机上跑（要本机 Chrome）：

```bash
PAGE="http://<服务器IP>:3000/debug" \
KEYS="key1,key2,key3,key4" \
node tools/domcheck/check-lobby-flow.mjs
```

⚠️ **每组 4 把密钥只能跑一次**。跑完牌局是**开着**的，四个账号身上都挂着「进行中的牌局」；
本地内存模式重启就清空，但**带数据库的部署清不掉** —— 第二次跑会在建房那一步撞
`/v1/rooms → 409`，界面上只留一句「这个账号还在一局没打完的牌局里，先回那一局打完再来」，
从第 ④ 步开始整片失败。**看着像功能坏了，其实只是账号脏了。**
每次换一组新密钥：`node --env-file=.env scripts/seed-testers.mjs 探甲 探乙 探丙 探丁`

⚠️ 在 Git Bash 里跑探针时**别写 `KEYS=... timeout 300 node ...`** ——
这个 `timeout` 会把环境变量吞掉，脚本读到空值，然后报「需要 4 把已激活的密钥，当前 0 把」。
写成 `env KEYS=... timeout 300 node ...` 就正常。

## 常用运维命令

```bash
systemctl status mymj            # 状态
journalctl -u mymj -f            # 实时日志
journalctl -u mymj -n 50 --no-pager
systemctl restart mymj

# 改成代码后重新上线
cd /srv/mianyang-mahjong && pnpm build && sudo systemctl restart mymj

# 签发测试账号（每个 2000 分）
cd /srv/mianyang-mahjong/apps/server
sudo -u mymj node --env-file=.env scripts/seed-testers.mjs 张三 李四 王五 赵六

# 签发正式邀请密钥（明文只在服务端台账留一份）
sudo -u mymj node --env-file=.env scripts/issue-keys.mjs 4 "给谁用"

# 备份
pg_dump -U mianyang mianyang_mahjong > ~/mymj-$(date +%F).sql
```

要备份的三样（都不进仓库）：`apps/server/.env`、`apps/server/.keys-ledger.txt`、
PostgreSQL 的 `pg_dump`。**邀请密钥是账号的唯一凭据，丢了这个文件等于账号丢了。**

## 之后想用 `git pull` 更新（可选）

打包直传够用，但每次都要整包传。想改成 `git pull`：

```bash
# 服务器上生成一把只读的部署密钥
sudo -u mymj ssh-keygen -t ed25519 -C "mymj-server" -f /srv/mianyang-mahjong/.deploy-key -N ''
sudo cat /srv/mianyang-mahjong/.deploy-key.pub
```

把这把公钥加到 GitHub 仓库的 **Settings → Deploy keys**（**不要**勾 write access），然后：

```bash
cd /srv/mianyang-mahjong
sudo -u mymj git remote set-url origin git@github.com:dadefy/mymajiang.git
sudo -u mymj env GIT_SSH_COMMAND="ssh -i /srv/mianyang-mahjong/.deploy-key -o IdentitiesOnly=yes" git pull
```

## 这套脚本踩过的坑（改脚本前先读）

- **Node 用官方 tarball 装，不用 NodeSource 的 apt 源**：NodeSource 只给还在支持期的
  发行版出包 —— Ubuntu 20.04 (focal) 上 `node_22.x/dists/focal/Release` 直接 **404**，
  老写法要么失败，要么更糟：装上源里的 node 18（本项目要 22）。
  tarball 与发行版无关，还能用 `NODE_MIRROR` 换成国内镜像加速。
  ⚠️ 副作用：**tarball 装的 node 在 `/usr/local/bin`，不是 `/usr/bin`** ——
  所以 `mymj.service` 里写的是 `@NODE_BIN@` 占位符，由 `02` 按 `command -v node` 填。
  写死 `/usr/bin/node` 的话，换一种装法服务就起不来。
- **`apt-get update` 可能被 apt-file 拖死**：机器上只要装了 `apt-file`，它的
  `/etc/apt/apt.conf.d/50apt-file.conf` 就会让每次 update **顺带下载 Contents 索引**
  （「某个文件属于哪个包」的全量清单，每个 component × 架构各一份，全套能到 GB 级）。
  实测在一台装了 apt-file 的机器上，这一步跑了 **20 分钟没下完**，看着像卡死。
  脚本用 `-o Acquire::IndexTargets::deb::Contents-deb::DefaultEnabled=false` 把它关掉 ——
  只对本次调用生效，不动机器上的 apt 配置，机器主人以后 `apt-file update` 照样能用。
  同时加了 `Acquire::http(s)::Timeout=30`：apt 默认**不超时**，某个慢源能把命令吊死还不报错。
- **共用机器上默认【不动防火墙】**：`OPEN_PORT` 默认就是 `skip`。
  因为 `ufw enable` 之后默认策略是全部 DROP —— 一台还跑着 VNC(5900)、Samba(139/445)、
  Docker 的实验室机器，一开就会把这些服务一起关在门外，操作者还可能在 SSH 里把自己锁出去。
  要开就显式给端口：`sudo OPEN_PORT=3000 bash 01-os-setup.sh`。
- **改完脚本，先确认行尾是 LF 再传上去**：编辑工具可能把它写成 CRLF，
  Linux 上会报 `bad interpreter: No such file or directory` 或者更难懂的
  `$'\r': command not found`。可靠的数法是数 CR 字节：
  ```bash
  tr -cd '\r' < 文件 | wc -c      # 必须是 0
  ```
  ⚠️ `grep -c '\r' 文件` **不能用来判断**（BRE 里 `\r` 不是转义，结果不可信）。
- **服务器地址会变，别把 IP 写死在心里**：DHCP 给的地址会随租约变，
  而且一台机器可能同时有多块网卡、各拿一个同网段的地址
  （实测那台 NUC：有线 `enx…` = .26、无线 `wlo1` = .25，有线是默认路由也更稳）。
  建议**插网线 + 在路由器上做 DHCP 保留（或配静态 IP）**，再定最终对外地址。
- **非 root 账号也能跑 `99-upload-from-dev.sh`**：远端会自己判断要不要 `sudo`，
  `lab@host`（有免密 sudo）和 `root@host` 两种都行。
- **`useradd --shell /usr/sbin/nologin` 会让 `sudo -u mymj pnpm install` 失败** ——
  sudo 在需要 `-c` 时要用登录 shell。所以运行账号用的是 `/bin/bash`
  （系统账号、没设密码，本身登不进来）。
- **pnpm 用 npm 全局装，不用 corepack**：corepack 每个用户各下一份到
  `~/.cache/node/corepack`，而服务是 `mymj` 身份跑的，那份缓存得再下一次（还可能被网络策略挡住）。
  ⚠️ 配 tarball 装的 node 时，`npm install -g` 必须带 `--prefix /usr/local`：
  不指定的话 npm 顺着软链算出自己的 prefix，会把 pnpm 装到 PATH 里找不到的地方。
- **`.env` 一次写完，不要追加**：往已有 `.env` 追加长文本在本项目踩过事故
  （内容跑到了文件开头、顶掉了原有几行）。`02` 用的是整份 heredoc 覆盖。
- **`StartLimitIntervalSec` / `StartLimitBurst` 必须写在 `[Unit]` 段**：systemd 230 起把它们
  从 `[Service]` 挪到了 `[Unit]`。放错位置**不会报错、只是整条被忽略** —— 只在 journal 里留一行
  `Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.`，
  服务照常起来，看起来一切正常，**实际上重启风暴保护完全没生效**。
  Ubuntu 20.04 是 systemd 245，正好中招。改完用这条验证真的生效了：
  ```bash
  systemctl show mymj -p StartLimitIntervalUSec -p StartLimitBurst   # 期望 5min / 10
  ```
- **`WorkingDirectory` 必须是 `apps/server`**：`.env` 由服务端自己按源码相对路径读进来，
  而 `STORAGE_DRIVER=local` 的 `STORAGE_LOCAL_DIR` 默认是**相对路径** `storage/blobs`。
- **systemd 单元里别写 `Environment=`**：配置只留 `.env` 一处，免得两边不一致。
- **停服务用默认 `SIGTERM`**：服务端会先把排队中的积分与流水写盘，别设 `KillSignal=SIGKILL`。

## 装到一台「已经有别的东西在跑」的机器上

上面的脚本默认行为就是按共用机器设计的：

| 动作 | 会不会影响机器上已有的东西 |
| --- | --- |
| 装 Node | 只往 `/usr/local/lib/nodejs/` 和 `/usr/local/bin/` 放软链，不碰 apt 的 nodejs |
| 装 PostgreSQL | `apt` 装官方包，监听 5432（先确认这个端口空着） |
| 建运行账号 `mymj` | 新建一个系统账号，不动别人的账号 |
| 代码目录 `/srv/mianyang-mahjong` | 新目录 |
| 防火墙 | **默认完全不碰**（见上面那条坑） |
| `apt-get update` | 对本次调用关掉 Contents 下载，不改机器上的 apt 配置 |

装之前值得先看一眼这台机器在跑什么、端口占没占：

```bash
systemctl list-units --type=service --state=running --no-pager | head -30
ss -lntp | head -30
```
