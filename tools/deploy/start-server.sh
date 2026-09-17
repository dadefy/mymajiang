#!/bin/sh
# 托管平台（PaaS）沙箱里的启动脚本。
#
# 为什么要有这个文件，而不是把命令直接填在平台的启动框里：
#   1. 平台要求服务在 60 秒内监听 $PORT —— 上传时会排除 dist/ 与 node_modules/，
#      所以每次都得现编译，一长串 `&&` 串起来既难读、出错时也看不出死在哪一步。
#   2. 平台不接受内联环境变量（`JWT_SECRET=x node ...` 不生效），配置只能来自 .env。
#   3. 编译有先后：domain 依赖 rules，server 又依赖两者；client 与 rules 互不依赖。
#
# 进度全部打到 stderr —— 平台会把 stderr 回显出来，失败时据此定位。
# 本地想模拟沙箱，直接 `sh tools/deploy/start-server.sh` 也能跑。

set -e

# 平台可能用任意 cwd 调用，先定位到仓库根。
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
# 用相对路径调 tsc：在 Git Bash 之类把 cwd 报成 /c/... 的环境里，
# 绝对路径会被 node 解读成 C:\c\... 而找不到模块。
TSC="node node_modules/typescript/bin/tsc"

log() {
  echo "[deploy] $*" >&2
}

log "cwd=$ROOT node=$(node -v 2>&1) port=${PORT:-3000}"

if [ ! -x "$ROOT/node_modules/typescript/bin/tsc" ]; then
  log "❌ 找不到 node_modules/typescript/bin/tsc —— 依赖没装上（install 步骤的问题）"
  ls "$ROOT/node_modules" 2>&1 | head -20 >&2
  exit 1
fi

# rules 与 client 互不依赖，并行编译；两者都好了再按依赖顺序往下走。
log "编译 rules / client（并行）..."
$TSC -p packages/rules/tsconfig.json &
p_rules=$!
$TSC -p apps/client/tsconfig.json &
p_client=$!
wait $p_rules || { log "❌ rules 编译失败"; exit 1; }
wait $p_client || { log "❌ client 编译失败"; exit 1; }

log "编译 domain..."
$TSC -p packages/domain/tsconfig.json || { log "❌ domain 编译失败"; exit 1; }

log "编译 server..."
$TSC -p apps/server/tsconfig.json || { log "❌ server 编译失败"; exit 1; }

log "编译完成，启动服务"
# exec：让 node 顶替 shell 成为主进程，平台的信号与退出码才传得进去。
exec node apps/server/dist/main.js
