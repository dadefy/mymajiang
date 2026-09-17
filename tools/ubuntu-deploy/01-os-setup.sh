#!/usr/bin/env bash
# 绵阳血战麻将 —— Ubuntu 服务器环境准备（可重复执行）
#
# 做的事：基础包 → Node 22 → pnpm(corepack) → PostgreSQL（建库建角色）
#         → 运行账号 mymj → 代码目录 /srv/mianyang-mahjong → 防火墙
#
# 用法：  sudo bash 01-os-setup.sh
# 适用：  Ubuntu 20.04 / 22.04 / 24.04（Debian 系同理；Node 走官方 tarball，与发行版无关）
#
# 可用环境变量覆盖：
#   NODE_VERSION   要装的 Node 版本（默认自动取 v22.x 最新）
#   NPM_REGISTRY   npm 源；国内机器设 https://registry.npmmirror.com 能快几十倍
#   OPEN_PORT      防火墙放行的端口；默认 skip（不碰防火墙，见第 6 节说明）
#
# 幂等：重复跑不会重复建库/建用户；已存在的资源会跳过并提示。

set -euo pipefail

APP_USER="mymj"
APP_DIR="/srv/mianyang-mahjong"
DB_NAME="mianyang_mahjong"
DB_USER="mianyang"
OPEN_PORT="${OPEN_PORT:-skip}"     # skip = 完全不动防火墙；要放行就写端口号，如 OPEN_PORT=3000
NODE_MAJOR="22"
NODE_VERSION="${NODE_VERSION:-}"   # 留空 = 自动解析 v22.x 最新
NPM_REGISTRY="${NPM_REGISTRY:-}"   # 留空 = npm 官方源

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m[✗] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash 01-os-setup.sh"
command -v apt-get >/dev/null || die "这脚本只对 Debian/Ubuntu 系有效"

# ── 1. 基础包 ───────────────────────────────────────────────────────────────
log "安装基础包"
export DEBIAN_FRONTEND=noninteractive

# apt 选项，后面几条 apt-get 都要带：
#
# ① 跳 Contents 索引。那是 apt-file 用的「某个文件属于哪个包」的全量清单 ——
#    单个几十 MB，每个 component × 架构各一份，全套能到 GB 级。
#    机器上只要装了 apt-file，它就会在 /etc/apt/apt.conf.d/50apt-file.conf 里
#    挂上这个下载项，于是每次 `apt-get update` 都顺带下一遍。
#    实测在装了 apt-file 的机器上，这一步跑了 20 分钟还没下完。
#    这里只关**本次调用**，不动机器上的 apt 配置 ——
#    机器主人以后跑 `apt-file update` 照样拿得到索引。
# ② 给个超时。默认是不超时的，某个源卡住能把整条命令吊死，还不报错。
APT_OPTS=(
  -o Acquire::IndexTargets::deb::Contents-deb::DefaultEnabled=false
  -o Acquire::IndexTargets::deb-src::Contents-dsc::DefaultEnabled=false
  -o Acquire::http::Timeout=30
  -o Acquire::https::Timeout=30
  -o Acquire::Retries=3
)
log "刷新 apt 索引"
# apt-get update 会因为**坏掉的第三方源**返回非 0，但不代表这次刷新白干了 ——
# 其它源该刷的已经刷好了。现成的例子：
#   E: The repository 'https://apt.repos.intel.com/openvino/2024 ubuntu20 Release'
#      no longer has a Release file.
# Intel 那个源已经下架，却把整条 update 拖成 exit 100，脚本原本就死在这里。
# 这是机器上的历史遗留，不该由部署脚本去改（人家可能还要 OpenVINO）。
# 所以这里**容忍失败**，改成检查「我们真正要装的包能不能查到候选版本」。
if ! apt-get "${APT_OPTS[@]}" update -qq; then
  warn "apt-get update 返回非 0 —— 通常是有第三方源失效了（这台机器上是 Intel OpenVINO）。"
  warn "  只要下面要装的包能查到版本就继续；要根治就去 /etc/apt/sources.list.d/ 里处理那个源。"
fi

NEED_PKGS=(curl ca-certificates git gnupg openssl sudo postgresql)
# ⚠️ 判断方式很讲究，别顺手改成 `apt-cache policy "$p" | grep -q ...`：
# 本脚本开头是 `set -o pipefail`，而 `grep -q` 找到第一个匹配就**立刻退出并关闭管道**，
# 写端 apt-cache 于是收到 SIGPIPE（退出码 141），整条管道被判为「失败」——
# 结果「包存在」被读成「包不存在」，7 个包全报缺失。实测踩过这个坑，
# 报错信息还挺像回事（"这些包在当前 apt 源里查不到候选版本"），特别误导。
# 所以：先把输出收进变量，再判断，全程不过管道。
missing=()
for p in "${NEED_PKGS[@]}"; do
  cand="$(apt-cache policy "$p" 2>/dev/null | sed -n 's/^ *Candidate: *//p' || true)"
  case "$cand" in
    ''|'(none)') missing+=("$p") ;;
  esac
done
if [ "${#missing[@]}" -gt 0 ]; then
  die "这些包在当前 apt 源里查不到候选版本：${missing[*]}
      检查 /etc/apt/sources.list 与 /etc/apt/sources.list.d/ 里的源是否可用，修好再跑。"
fi

apt-get "${APT_OPTS[@]}" install -y -qq curl ca-certificates git gnupg openssl sudo

# ── 2. Node ${NODE_MAJOR} ────────────────────────────────────────────────────
# 用官方 tarball，不用 NodeSource 的 apt 源。
# 原因：NodeSource 只给"还在支持期"的发行版出包 —— Ubuntu 20.04(focal) 上
#   https://deb.nodesource.com/node_22.x/dists/focal/Release  →  404
# 照老写法会走到 `apt-get install nodejs`：要么报"找不到包"，要么更糟 ——
# 装上源里的 node 18，而本项目需要 22。
# tarball 方式跟发行版无关，而且能按需换镜像加速。
log "安装 Node ${NODE_MAJOR}.x"

install_node_tarball() {
  local arch tarball="" url mirror version="${NODE_VERSION}" v ok=0

  case "$(uname -m)" in
    x86_64)  arch="x64" ;;
    aarch64) arch="arm64" ;;
    armv7l)  arch="armv7l" ;;
    *) die "不认识的架构：$(uname -m)" ;;
  esac

  # 依次尝试，第一个成功的算数。国内机器走国内镜像能快一个数量级。
  local mirrors=()
  [ -n "${NODE_MIRROR:-}" ] && mirrors+=("$NODE_MIRROR")
  mirrors+=(
    "https://mirrors.aliyun.com/nodejs-release"
    "https://registry.npmmirror.com/-/binary/node"
    "https://nodejs.org/dist"
  )

  for m in "${mirrors[@]}"; do
    v="$version"
    # 没指定版本：从镜像的 SHASUMS256.txt 里挑出 v22.x 最新的那个文件名
    if [ -z "$v" ]; then
      # 注意：这里**不能**写成 `curl ... | grep -oE ... | head -1`。
      # 本脚本是 `set -o pipefail`，而 head -1 读够就退出，上游 grep / curl 会收到
      # SIGPIPE（141），整条管道判为失败 —— 结果是把「解析成功」读成「失败」。
      # （同一个坑在下面 NEED_PKGS 那段有详细说明。）
      # 改成：先把清单收进变量，再用 shell 自己挑，全程不过管道。
      sums="$(curl -fsSL --retry 2 --connect-timeout 15 --max-time 60 \
                "$m/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" 2>/dev/null || true)"
      for name in $sums; do
        case "$name" in
          node-v${NODE_MAJOR}.*-linux-${arch}.tar.xz)
            v="${name#node-v}"; v="${v%-linux-${arch}.tar.xz}"; break ;;
        esac
      done
      if [ -z "$v" ]; then
        warn "$m 上没有 v${NODE_MAJOR}.x 的版本清单，换下一个源"
        continue
      fi
    fi
    tarball="node-v${v}-linux-${arch}.tar.xz"
    url="$m/v${v}/${tarball}"
    printf '  试 %s\n' "$url"
    if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 \
         -o "/tmp/${tarball}" "$url" 2>/dev/null \
       && tar -tJf "/tmp/${tarball}" >/dev/null 2>&1; then
      version="$v"; ok=1
      log "已下载 ${tarball}"
      break
    fi
    warn "这个源下不来或文件损坏，换下一个"
    rm -f "/tmp/${tarball}"; tarball=""
  done

  [ "$ok" -eq 1 ] || die "所有镜像都拿不到 Node ${NODE_MAJOR}.x —— 检查出网，或用 NODE_VERSION=22.x.y 指定具体版本"

  # 解包到 /usr/local/lib/nodejs/，再把可执行文件软链进 /usr/local/bin
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "/tmp/${tarball}" -C /usr/local/lib/nodejs
  rm -f "/tmp/${tarball}"

  local dir="/usr/local/lib/nodejs/node-v${version}-linux-${arch}"
  [ -d "$dir/bin" ] || die "解包结果不符合预期：$dir/bin 不存在"
  for b in node npm npx corepack; do
    if [ -e "$dir/bin/$b" ]; then ln -sf "$dir/bin/$b" "/usr/local/bin/$b"; fi
  done
}

needs_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  case "$current" in
    ''|*[!0-9]*) warn "读到奇怪的 node 版本，按未安装处理" ;;
    *) if [ "$current" -ge "$NODE_MAJOR" ]; then
         warn "已有 Node $(node -v)，跳过安装"
         needs_node=0
       fi ;;
  esac
fi
if [ "$needs_node" -eq 1 ]; then
  install_node_tarball
fi
hash -r 2>/dev/null || true
node -v || die "Node 装完还是不可用"
echo "  node $(command -v node)  $(node -v)"

# ── 3. pnpm ─────────────────────────────────────────────────────────────────
# 用 npm 全局装，不用 corepack：corepack 的每个用户各自下一份到 ~/.cache/node/corepack，
# 而服务是以 mymj 身份跑的 —— 那份缓存得再下一次（还可能被网络策略挡住）。
# 全局装一份，root 和 mymj 共用，没有这个坑。
log "安装 pnpm"
PNPM_VERSION=""
if [ -f "$APP_DIR/package.json" ]; then
  # 版本取自仓库 package.json 的 packageManager 字段，别手写死版本号。
  # 同样不过管道：`sed ... | head -1` 在 pipefail 下会被 SIGPIPE 判成失败，
  # 而这个赋值失败会被 set -e 直接终止脚本。改成收进变量后自己取第一行。
  _pm="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$APP_DIR/package.json" 2>/dev/null || true)"
  PNPM_VERSION="${_pm%%$'\n'*}"
fi

# --prefix /usr/local 不能省：node 是从 tarball 解到 /usr/local/lib/nodejs 再软链进
# /usr/local/bin 的，不显式指定 prefix 时 npm 会顺着软链算出自己的 prefix，
# 结果把 pnpm 装到一个 PATH 里根本找不到的目录。
NPM_ARGS=(-g --prefix /usr/local)
if [ -n "$NPM_REGISTRY" ]; then NPM_ARGS+=(--registry "$NPM_REGISTRY"); fi

if [ -n "$PNPM_VERSION" ]; then
  npm install "${NPM_ARGS[@]}" "pnpm@${PNPM_VERSION}"
else
  warn "还没放代码，装 pnpm 最新版；代码到位后按 packageManager 字段核对一次版本"
  npm install "${NPM_ARGS[@]}" pnpm
fi
hash -r 2>/dev/null || true
pnpm -v || die "pnpm 不可用"
echo "  pnpm $(command -v pnpm)  $(pnpm -v)"

# ── 4. PostgreSQL ───────────────────────────────────────────────────────────
log "安装 PostgreSQL"
apt-get "${APT_OPTS[@]}" install -y -qq postgresql
systemctl enable --now postgresql

# 生成随机密码（只在首次建角色时用；已存在则跳过，不动现有密码）
DB_PASSWORD_FILE="/root/mymj-db-password.txt"
# 用「命令替换 + 字符串相等」而不是 `psql ... | grep -q 1`：同样的 pipefail 陷阱，
# 见上面 NEED_PKGS 那段注释。psql -tA 的输出就是一行 `1`，去掉换行正好等于 "1"。
if [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null)" = "1" ]; then
  warn "角色 ${DB_USER} 已存在，保留原密码"
  [ -f "$DB_PASSWORD_FILE" ] || die "角色已存在但找不到 $DB_PASSWORD_FILE —— 请从 .env 里取 DATABASE_URL 的密码，或手工 ALTER ROLE 重设"
  DB_PASSWORD="$(cat "$DB_PASSWORD_FILE")"
else
  DB_PASSWORD="$(openssl rand -hex 24)"
  sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';"
  printf '%s' "$DB_PASSWORD" > "$DB_PASSWORD_FILE"
  chmod 600 "$DB_PASSWORD_FILE"
  log "数据库密码已写入 ${DB_PASSWORD_FILE}（600，root only）"
fi

if [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null)" = "1" ]; then
  warn "数据库 ${DB_NAME} 已存在，跳过"
else
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
fi

# ── 5. 运行账号 ─────────────────────────────────────────────────────────────
log "创建运行账号 ${APP_USER}"
if id "$APP_USER" >/dev/null 2>&1; then
  warn "账号 ${APP_USER} 已存在"
else
  # 用 /bin/bash 而不是 nologin：部署脚本要 `sudo -u mymj` 以它的身份跑 pnpm 构建。
  # 这是无密码的系统账号，本身登不进来。
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi
mkdir -p "$APP_DIR"
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"

# 把 npm 源固定到运行账号的 HOME 下：以后手工跑 pnpm / npm（比如补装依赖、
# 排查问题）会直接走快的那条线，不用每次记得加 --registry。
if [ -n "$NPM_REGISTRY" ]; then
  APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  printf 'registry=%s\n' "$NPM_REGISTRY" > "$APP_HOME/.npmrc"
  chown "${APP_USER}:${APP_USER}" "$APP_HOME/.npmrc"
  chmod 644 "$APP_HOME/.npmrc"
  log "npm 源已固定为 ${NPM_REGISTRY}（写入 ${APP_HOME}/.npmrc）"
fi

# ── 6. 防火墙 ───────────────────────────────────────────────────────────────
# 默认【完全不碰防火墙】—— OPEN_PORT 的默认值就是 skip。
# 这是踩过坑之后改的：ufw enable 之后默认策略是全部 DROP，在**共用机器**上
# （实验室的 NUC 之类的，可能还跑着 VNC 5900、Samba 139/445、Docker）
# 会把那些服务一起关在门外，操作者还可能在 SSH 里把自己锁出去。
# 要开就显式指定端口：sudo OPEN_PORT=3000 bash 01-os-setup.sh
if [ "$OPEN_PORT" = "skip" ]; then
  # 同样不过管道：`ufw status | head -1` 的 head 提前退出会给 ufw 发 SIGPIPE
  UFW_STATE="$(ufw status 2>/dev/null || true)"
  UFW_STATE="${UFW_STATE%%$'\n'*}"
  warn "OPEN_PORT=skip —— 不碰防火墙（当前：${UFW_STATE:-未知}）"
  warn "  独占的公网机器建议改跑：sudo OPEN_PORT=3000 bash $0"
else
  log "防火墙放行 TCP ${OPEN_PORT}"
  # 规则必须在 enable 之前加好：ufw 生效的瞬间不在名单里的连接就断了
  ufw allow OpenSSH >/dev/null
  ufw allow "${OPEN_PORT}/tcp" >/dev/null
  # Nginx + HTTPS 时由 certbot 自己放行 80/443；这里顺手加不影响
  ufw allow 80/tcp  >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  ufw --force enable >/dev/null
  ufw status verbose
fi

# ── 汇总 ────────────────────────────────────────────────────────────────────
log "环境就绪"
cat <<EOF

  Node        $(node -v)   （$(command -v node)）
  pnpm        $(pnpm -v)   （$(command -v pnpm)）
  PostgreSQL  $(sudo -u postgres psql -tAc 'SHOW server_version')
  数据库      ${DB_NAME}（拥有者 ${DB_USER}）
  DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
  运行账号    ${APP_USER}
  代码目录    ${APP_DIR}
  npm 源      ${NPM_REGISTRY:-（默认官方源）}

  下一步：把代码放到 ${APP_DIR}，然后跑 02-deploy-app.sh

EOF
