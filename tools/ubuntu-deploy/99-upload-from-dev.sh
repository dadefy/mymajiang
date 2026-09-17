#!/usr/bin/env bash
# 从开发机（Windows / Git Bash）把仓库打包传到 Ubuntu 服务器。
#
# 用法：
#   bash 99-upload-from-dev.sh root@1.2.3.4 [/srv/mianyang-mahjong]
#
# 为什么要打包而不是在服务器上 git clone：
#   仓库是私有的，服务器上 clone 需要先配 deploy key（要用 GitHub 后台加一次公钥）。
#   打包直传不依赖任何 GitHub 配置，马上就能跑；等要持续更新了再配 deploy key 也不迟。
#
# 有意排除的东西：
#   node_modules / dist   —— 服务器上重新装、重新构建（Linux 产物和 Windows 不通用）
#   .env                  —— 本地库连接串与 JWT_SECRET 不能泄漏到服务器，那边会自己生成
#   .keys-ledger*.txt     —— 明文邀请密钥，两边环境各存一份
#   storage/              —— 本地上传的图片/语音（且可能很大）
#   .workbuddy/           —— 工具的本地数据
#
# .git 会一起传（2 MB 左右）：服务器上能 git log / git status，回滚方便。

set -euo pipefail

TARGET="${1:-}"
REMOTE_DIR="${2:-/srv/mianyang-mahjong}"

if [ -z "$TARGET" ]; then
  echo "用法：bash 99-upload-from-dev.sh <user@host> [/srv/mianyang-mahjong]" >&2
  echo "例如：bash 99-upload-from-dev.sh root@1.2.3.4" >&2
  exit 1
fi

# 定位仓库根（本脚本在 <仓库>/tools/ubuntu-deploy/ 或独立目录下都行）
REPO="$(git -C "$(dirname "$(readlink -f "$0")")" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO" ]; then
  REPO="C:/Users/24386/WorkBuddy/2026-09-15-19-47-34/mymajiang"
fi
[ -f "$REPO/package.json" ] || { echo "找不到仓库：$REPO" >&2; exit 1; }

# 找一个真的可写的临时目录。
# 别直接用 `mktemp -t`：在 Windows 的 Git Bash 里它落点是 MSYS 的 /tmp，
# 而某些受限终端（沙箱、企业策略）下 /tmp 是只读的，报
#   mktemp: failed to create file via template '/tmp/mymj-XXXXXX.tar.gz': Permission denied
# 这里按 MYMJ_TMPDIR → /tmp → $HOME → 当前目录 的顺序试。
WORKDIR=""
for d in "${MYMJ_TMPDIR:-}" /tmp "${HOME:-}" "$PWD"; do
  [ -n "$d" ] || continue
  probe="$d/.mymj-writable.$$"
  if touch "$probe" 2>/dev/null; then rm -f "$probe"; WORKDIR="$d"; break; fi
done
[ -n "$WORKDIR" ] || { echo "[✗] 找不到可写的临时目录，用 MYMJ_TMPDIR=<目录> 指定一个" >&2; exit 1; }
TARBALL="$WORKDIR/mymj-upload-$$.tar.gz"
echo "仓库   $REPO"
echo "目标   $TARGET:$REMOTE_DIR"
echo "打包   $TARBALL"

echo "打包中..."
tar -czf "$TARBALL" \
  --exclude=./node_modules --exclude=./.pnpm-store \
  --exclude='./*/node_modules' --exclude='./*/*/node_modules' \
  --exclude='./*/dist' --exclude='./*/*/dist' \
  --exclude=./.env --exclude='./apps/server/.env' \
  --exclude='./apps/server/.keys-ledger*.txt' \
  --exclude='./apps/server/storage' \
  --exclude=./.workbuddy --exclude=./coverage \
  --exclude='./apps/apk/release' --exclude='./apps/apk/library' \
  --exclude='./apps/apk/local' --exclude='./apps/apk/temp' \
  -C "$REPO" .

SIZE="$(du -h "$TARBALL" | cut -f1)"
echo "包大小 $SIZE"

echo "上传..."
scp "$TARBALL" "$TARGET:/tmp/mymj-upload.tar.gz"

echo "解包到 $REMOTE_DIR ..."
# 先建目录再解包；解包前不删旧文件（增量覆盖，.env 之类不在包里所以不受影响）。
# 目标目录通常在 /srv 下，普通用户写不进去 —— 所以远端自己判断要不要 sudo，
# 这样 `lab@host`（有 sudo）和 `root@host` 两种用法都能跑。
ssh "$TARGET" bash -s -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"
if [ "$(id -u)" -eq 0 ]; then SUDO=""
elif sudo -n true 2>/dev/null; then SUDO="sudo"
else
  echo "[✗] 当前用户既不是 root 也没有免密 sudo，写不进 $REMOTE_DIR" >&2
  echo "    换成 root@host，或先在服务器上给这个用户配好免密 sudo。" >&2
  exit 1
fi
$SUDO mkdir -p "$REMOTE_DIR"
$SUDO tar -xzf /tmp/mymj-upload.tar.gz -C "$REMOTE_DIR"
rm -f /tmp/mymj-upload.tar.gz
echo "已解包到 $REMOTE_DIR："
# `| head` 后面跟 `|| true`：远端那段是 `set -o pipefail`，head 提前退出会让 ls
# 收到 SIGPIPE（141），整个远端脚本就会以非 0 结束 —— 本地上传会误报“失败”。
ls -1 "$REMOTE_DIR" | head -n 20 || true
REMOTE

rm -f "$TARBALL"
echo
echo "完成。接下来在服务器上："
echo "  sudo bash $REMOTE_DIR/tools/ubuntu-deploy/01-os-setup.sh"
echo "  sudo bash $REMOTE_DIR/tools/ubuntu-deploy/02-deploy-app.sh"
