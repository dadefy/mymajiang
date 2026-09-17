#!/usr/bin/env bash
# 绵阳血战麻将 —— 公网访问（Cloudflare Quick Tunnel，可重复执行）
#
# 前置：02-deploy-app.sh 已经跑过，本机 127.0.0.1:3000 的 /health 是 200。
# 做的事：装 cloudflared（缺才装）→ 装隧道包装脚本与 systemd 单元
#        → 确保 .env 里的 TRUST_PROXY → 起隧道 → 打印公网地址 → 自检
#
# 用法：  sudo bash 03-public-access.sh
#
# 为什么选隧道而不是「路由器端口映射 + 公网 IP」：见 README.md「公网访问」一节 ——
# 多数宽带没有可入向的公网 IP（本项目实测穿了 3 层私网），端口映射这条路根本走不通。

set -euo pipefail

APP_DIR="/srv/mianyang-mahjong"
APP_SERVICE="mymj"
TUNNEL_SERVICE="mymj-tunnel"
APP_USER="mymj"
PORT="${PORT:-3000}"
CLOUDFLARED_BIN="/usr/local/bin/cloudflared"
HERE="$(dirname "$(readlink -f "$0")")"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m[✗] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash 03-public-access.sh"

# ── 0. 前置：本机服务得好好的 ────────────────────────────────────────────────
log "检查本机服务"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || true)"
[ "$code" = "200" ] || die "127.0.0.1:${PORT}/health 不是 200（当前 ${code}）—— 先跑 02-deploy-app.sh"
echo "  /health → 200"

# ── 1. cloudflared ─────────────────────────────────────────────────────────
if [ -x "$CLOUDFLARED_BIN" ]; then
  log "cloudflared 已存在：$("$CLOUDFLARED_BIN" --version 2>&1 | sed -n '1p')"
else
  log "安装 cloudflared"
  arch="$(dpkg --print-architecture)"
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
  tmp="$(mktemp)"
  if curl -fL --retry 3 --connect-timeout 15 --max-time 180 -o "$tmp" "$url"; then
    install -m 0755 "$tmp" "$CLOUDFLARED_BIN"
    rm -f "$tmp"
    echo "  $("$CLOUDFLARED_BIN" --version 2>&1 | sed -n '1p')"
  else
    rm -f "$tmp"
    die "下不动 cloudflared（$url）。可换镜像，例如：
    https://ghproxy.net/${url#https://github.com/}
  下载后 install -m 0755 <文件> ${CLOUDFLARED_BIN}"
  fi
fi

# ── 2. 隧道包装脚本 + systemd 单元 ──────────────────────────────────────────
log "安装隧道组件"
install -m 0755 "$HERE/mymj-tunnel-run" /usr/local/bin/mymj-tunnel-run
sed "s#@APP_USER@#${APP_USER}#g; s#@APP_SERVICE@#${APP_SERVICE}#g; s#@NODE_BIN@#${CLOUDFLARED_BIN}#g" \
  "$HERE/mymj-tunnel.service" > "/etc/systemd/system/${TUNNEL_SERVICE}.service"
echo "  /usr/local/bin/mymj-tunnel-run"
echo "  /etc/systemd/system/${TUNNEL_SERVICE}.service"

# ── 3. TRUST_PROXY（公网访问的**必需项**，不是优化项）────────────────────────
# 隧道是从本机 127.0.0.1 连进来的 ⇒ 服务端看到的客户端 IP 全是回环地址。
# 不开 trustProxy，限流会**把所有公网用户算成一个 IP**：一个人的操作就能把
# 全站每分钟 30 次的登录额度吃光（见 docs/DEPLOYMENT.md）。
# 取 loopback 而不是 true：只信任本机来的转发，局域网直连的客户端伪造
# X-Forwarded-For 无效，绕不过限流。
ENV_FILE="${APP_DIR}/apps/server/.env"
[ -f "$ENV_FILE" ] || die "找不到 ${ENV_FILE}"
log "确保 .env 的 TRUST_PROXY=loopback"
if grep -q '^TRUST_PROXY=' "$ENV_FILE"; then
  cur="$(sed -n 's/^TRUST_PROXY=//p' "$ENV_FILE" | sed -n '1p')"
  if [ "$cur" = "loopback" ]; then
    echo "  已是 loopback，不动"
  else
    sed -i 's#^TRUST_PROXY=.*#TRUST_PROXY=loopback#' "$ENV_FILE"
    echo "  ${cur:-（空）} → loopback"
    NEED_RESTART=yes
  fi
else
  printf '\n# 隧道从本机 127.0.0.1 转发进来：不设这项限流会把所有公网用户算成一个 IP\nTRUST_PROXY=loopback\n' >> "$ENV_FILE"
  echo "  已追加 TRUST_PROXY=loopback"
  NEED_RESTART=yes
fi

if [ "${NEED_RESTART:-no}" = "yes" ]; then
  log "重启 ${APP_SERVICE} 让新配置生效"
  systemctl restart "$APP_SERVICE"
  sleep 2
fi

# ── 4. 起隧道 ──────────────────────────────────────────────────────────────
log "启动隧道服务"
systemctl daemon-reload
systemctl enable --now "$TUNNEL_SERVICE"

URL_FILE="${APP_DIR}/apps/server/.public-url"
log "等公网地址就绪（最多 60 秒）"
url=""
for _ in $(seq 1 30); do
  # ⚠️ 别写成 `sed ... | sed ...`：地址文件是隧道进程稍后才创建的，头几轮它还不存在，
  # 而 sed **读不到文件时返回 2** —— 配上本脚本的 `set -o pipefail`，整条管道判失败，
  # `set -e` 会当场把脚本打死（exit 2，且一句错误都不打，实测踩过一次）。
  # 规则同 02：先判文件在不在 → 再收进变量 → 然后自己取第一行，全程不过管道。
  if [ -f "$URL_FILE" ]; then
    url="$(sed -n 's#^\(https://[A-Za-z0-9._-]\{1,\}\.trycloudflare\.com\)$#\1#p' "$URL_FILE" 2>/dev/null || true)"
    url="${url%%$'\n'*}"
  fi
  [ -n "$url" ] && break
  sleep 2
done
[ -n "$url" ] || die "60 秒内没拿到公网地址 —— 看 journalctl -u ${TUNNEL_SERVICE} -n 50"
echo "  ${url}"

# ── 5. 自检（从公网这一侧打回来）─────────────────────────────────────────────
log "自检"
for i in $(seq 1 10); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url/health" || true)"
  [ "$code" = "200" ] && break
  sleep 3
done
if [ "$code" = "200" ]; then
  echo "  ${url}/health → 200  $(curl -s --max-time 15 "$url/health")"
else
  warn "${url}/health 返回 ${code} —— 边缘节点刚建好时可能还要几秒，稍后重试"
fi

# 页面与静态资源也过一遍，确认不是只有 /health 通
for path in /debug /admin; do
  printf '  %-14s → %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${url}${path}" || true)"
done

log "公网访问已就绪"
cat <<EOF

  公网地址  ${url}/debug
  本机地址  http://127.0.0.1:${PORT}/debug
  局域网    http://<本机IP>:${PORT}/debug

  ⚠️ 这是 quick tunnel，**域名每次重启都会变**。当前地址记在：
       ${URL_FILE}
     查一下：cat ${URL_FILE}        或   systemctl status ${TUNNEL_SERVICE}

  运维：
    systemctl status ${TUNNEL_SERVICE}      # 隧道状态
    journalctl -u ${TUNNEL_SERVICE} -f      # 隧道日志
    systemctl restart ${TUNNEL_SERVICE}     # 换一个公网地址

  访问异常时按这个顺序查：
    1) 本机通不通        curl -s 127.0.0.1:${PORT}/health
    2) 隧道连上没有      journalctl -u ${TUNNEL_SERVICE} | grep 'Registered tunnel connection'
    3) 边缘到本机通不通  journalctl -u ${TUNNEL_SERVICE} | grep -i error
    4) 地址是不是变了    cat ${URL_FILE}

EOF
