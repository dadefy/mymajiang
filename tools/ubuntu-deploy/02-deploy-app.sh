#!/usr/bin/env bash
# 绵阳血战麻将 —— 应用部署（可重复执行）
#
# 前置：01-os-setup.sh 已经跑过，代码已经在 /srv/mianyang-mahjong。
# 做的事：装依赖 → 构建 → 生成 .env → 安装 systemd 服务 → 启动 → 自检
#
# 用法：  sudo bash 02-deploy-app.sh
#
# 幂等：.env 已存在时不覆盖（想重生成先删掉或备份）；
#       systemd 单元每次覆盖成仓库里的这一份。

set -euo pipefail

APP_USER="mymj"
APP_DIR="/srv/mianyang-mahjong"
DB_NAME="mianyang_mahjong"
DB_USER="mianyang"
DB_PASSWORD_FILE="/root/mymj-db-password.txt"
PORT="${PORT:-3000}"
# 对外给客户端用的地址（写进 .env 的 PUBLIC_BASE_URL，影响图片/语音直传地址）。
# 直连就用 http://<IP>:3000；有域名走 HTTPS 就填 https://<域名>
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
BEHIND_PROXY="${BEHIND_PROXY:-no}"     # 有 Nginx 反代时设 yes
# npm 源。01-os-setup.sh 会把它写进运行账号的 ~/.npmrc；在这里再显式传一遍，
# 是为了「先用官方源跑了 01、后来发现太慢」这种情况也能补救。
NPM_REGISTRY="${NPM_REGISTRY:-}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m[✗] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash 02-deploy-app.sh"
[ -f "$APP_DIR/package.json" ] || die "找不到 $APP_DIR/package.json —— 代码还没放上去？"
[ -f "$DB_PASSWORD_FILE" ] || die "找不到 $DB_PASSWORD_FILE —— 先跑 01-os-setup.sh"

# runs <命令> 以运行账号的身份执行（HOME 指向它的家目录，pnpm 的 store 才落得对地方）
runs() { sudo -u "$APP_USER" -H -- "$@"; }

# ── 0. pnpm 版本对齐 ────────────────────────────────────────────────────────
# 01-os-setup.sh 如果是在代码上传之前跑的，装的是 pnpm 最新版 —— 和仓库
# packageManager 字段不一致时，pnpm install 可能拒绝跑或改写锁文件。这里对齐一次。
# ⚠️ 别写成 `sed ... | head -1`：本脚本是 `set -o pipefail`，head 读够就退出会让
# sed 收到 SIGPIPE（141），整条管道判为失败，而这个赋值失败会被 set -e 终止脚本。
# 改成先收进变量、再自己取第一行，全程不过管道。
_pm="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$APP_DIR/package.json" 2>/dev/null || true)"
WANT_PNPM="${_pm%%$'\n'*}"
if [ -n "$WANT_PNPM" ] && [ "$(pnpm -v)" != "$WANT_PNPM" ]; then
  log "pnpm 版本对齐：$(pnpm -v) → ${WANT_PNPM}"
  # --prefix /usr/local 与 01 保持一致，原因见那边注释
  npm install -g --prefix /usr/local "pnpm@${WANT_PNPM}"
fi
echo "  pnpm $(pnpm -v)"

# pnpm 的 env 前缀（npm_config_*）优先于配置文件；只有显式传了才加
PNPM_ENV=()
if [ -n "$NPM_REGISTRY" ]; then
  PNPM_ENV=(env "npm_config_registry=${NPM_REGISTRY}")
  echo "  npm 源 ${NPM_REGISTRY}"
fi

# ── 1. 依赖 ─────────────────────────────────────────────────────────────────
log "安装依赖（以 ${APP_USER} 身份）"
cd "$APP_DIR"
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"
# 用 frozen-lockfile：锁文件与 package.json 不一致时直接失败，别让线上跑出不一样的树
runs "${PNPM_ENV[@]}" pnpm install --frozen-lockfile

# ── 2. 构建 ─────────────────────────────────────────────────────────────────
# /debug 页面是从 apps/client/dist 发出去的，所以客户端也必须构建。
log "构建（rules / domain / client / server）"
runs pnpm build

[ -f "$APP_DIR/apps/server/dist/main.js" ] || die "构建产物缺失：apps/server/dist/main.js"
[ -f "$APP_DIR/apps/client/dist/browser/debug-client.js" ] || die "构建产物缺失：apps/client/dist/browser/debug-client.js"

# ── 3. 环境变量 ─────────────────────────────────────────────────────────────
ENV_FILE="$APP_DIR/apps/server/.env"
if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE 已存在，保留不动（要重建就先删掉它）"
else
  log "生成 $ENV_FILE"
  DB_PASSWORD="$(cat "$DB_PASSWORD_FILE")"
  JWT_SECRET="$(openssl rand -hex 32)"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  ADMIN_ID="${ADMIN_ID:-local-developer}"

  [ -n "$PUBLIC_BASE_URL" ] || warn "没给 PUBLIC_BASE_URL，将按 http://<公网IP>:${PORT} 之外的默认值推断 —— 图片/语音的直传地址可能不对，稍后手工改"

  # 用 heredoc 一次写清；追加方式写 .env 容易把顺序弄乱（本项目踩过）
  cat > "$ENV_FILE" <<EOF
# 由 02-deploy-app.sh 生成于 $(date -Iseconds)
HOST=0.0.0.0
PORT=${PORT}

# 生产模式：强制要求 DATABASE_URL，并要求至少存在一个管理员
NODE_ENV=production
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
DATABASE_SSL=false

JWT_SECRET=${JWT_SECRET}
ADMIN_ID=${ADMIN_ID}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF

  if [ "$BEHIND_PROXY" = "yes" ]; then
    cat >> "$ENV_FILE" <<'EOF'

# Nginx 与它同机 —— 不设这项限流会把所有人算成一个 IP（登录 30 次/分钟被一个人吃光）
TRUST_PROXY=loopback
EOF
  fi

  if [ -n "$PUBLIC_BASE_URL" ]; then
    cat >> "$ENV_FILE" <<EOF

# 图片 / 语音：本地磁盘驱动，不需要云账号
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=storage/blobs
STORAGE_SIGNING_SECRET=$(openssl rand -hex 32)
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
EOF
  else
    cat >> "$ENV_FILE" <<'EOF'

# 图片 / 语音：留空则上传接口返回 501，群聊与牌局都不受影响。
# 想开启：把下面三行的注释去掉，并把地址改成客户端真正访问得到的地址。
# STORAGE_DRIVER=local
# STORAGE_LOCAL_DIR=storage/blobs
# PUBLIC_BASE_URL=http://<公网IP>:3000
EOF
  fi

  chown "${APP_USER}:${APP_USER}" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "管理员账号 ${ADMIN_ID} / 密码 ${ADMIN_PASSWORD}"
  warn "这行密码只在这里出现一次，请现在抄走（之后改密码走 /admin 或 POST /v1/admin/password）"
fi

# 数据目录（local 驱动落文件的地方）与代码一起归运行账号
mkdir -p "$APP_DIR/apps/server/storage/blobs"
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR/apps/server/storage"

# ── 4. systemd ──────────────────────────────────────────────────────────────
log "安装 systemd 服务"
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || die "找不到 node 可执行文件 —— 先跑 01-os-setup.sh"
echo "  node        ${NODE_BIN}"
sed "s#@APP_DIR@#${APP_DIR}#g; s#@APP_USER@#${APP_USER}#g; s#@NODE_BIN@#${NODE_BIN}#g" \
  "$(dirname "$(readlink -f "$0")")/mymj.service" > /etc/systemd/system/mymj.service
systemctl daemon-reload
# 先 enable（登记开机自启），再**显式 restart**。
#
# ⚠️ 这里**不能**用 `systemctl enable --now mymj`：服务已经在跑的时候，`--now` 只保证
# 「处于运行状态」，**不会重启它**。于是新构建出来的 dist 根本不会被加载，而紧接着的
# 自检（/health、/debug）照样全绿 —— 因为应答的是**旧进程**。
# 结果就是整条「传新代码 → 跑 02」的更新路径**静默地不生效**，还告诉你「部署完成」。
# （2026-09-17 实测踩到：跑完 02 看到 `active since 18:34`，而当时已经 19:24。）
#
# 服务端收到 SIGTERM 时会排空排队中的积分/流水，所以用 systemctl 重启是安全的。
systemctl enable mymj
systemctl restart mymj
sleep 2

# 服务端 SIGTERM 时会排空排队中的积分/流水，用 systemctl 停是安全的
systemctl --no-pager --lines=20 status mymj || true

# ── 5. 自检 ─────────────────────────────────────────────────────────────────
log "自检"
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || true)"
[ "$code" = "200" ] || die "/health 不是 200（当前 ${code}）—— 看 journalctl -u mymj -n 50"
echo "  /health      → $(curl -s "http://127.0.0.1:${PORT}/health")"

for path in /debug /admin; do
  echo "  ${path}        → $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${path}")"
done

log "部署完成"
cat <<EOF

  服务      systemctl status mymj     /     journalctl -u mymj -f
  本地地址  http://127.0.0.1:${PORT}/debug
  对外地址  ${PUBLIC_BASE_URL:-http://<公网IP>:${PORT}}/debug

  签发测试账号（在 ${APP_DIR}/apps/server 下跑）：
    sudo -u ${APP_USER} node --env-file=.env scripts/seed-testers.mjs 张三 李四 王五 赵六

  改完代码后重新上线（重跑本脚本也行）：
    cd ${APP_DIR} && pnpm build && systemctl restart mymj

  确认新代码**真的**被加载了 —— 别只看 /health，旧进程也会回 200：
    systemctl show mymj -p ActiveEnterTimestamp   # 时间应当是刚刚
    systemctl show mymj -p MainPID                # PID 应当变了

EOF
