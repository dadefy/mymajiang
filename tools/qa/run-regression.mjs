#!/usr/bin/env node
/**
 * 一键回归（run-regression）—— 回答一个问题：
 * 「这些功能到底真的没坏，还是只是看起来没坏？」
 *
 * 四档，从零依赖到真实环境：
 *
 *   offline      不需要任何服务在跑（默认）：build → typecheck → 单测全量 →
 *                离线 domcheck 探针（结算浮层 / 暗杠 / 两次点击 / 整局累计 / 托管浮层）。
 *                单测里含关键风险探针：四人掉线终局、三票解散桥接、claiming deadline
 *                固定、断线窗口 1ms 边界重试、8 局积分一次入账、杠分零和。
 *
 *   local-online 需要本机 3000 端口有服务端（内存或 PostgreSQL 都行）：
 *                smoke.mjs（接口自检）→ acceptance.mjs（四个真实连接打满 8 局、
 *                零和、断线重连、群聊实时推送、解散后入口消失）。
 *
 *   public-online 需要公网地址（SERVER_BASE_URL 或默认 https://0106.wiki）：
 *                /health → smoke.mjs。只验「线上那一份还活着、接口通」；
 *                完整线上行为验收用 `tools/domcheck/check-remote.mjs`（要 4 把密钥）。
 *
 *   manual       打印真机验收清单入口（docs/INTERNAL_TESTING.md 第七节）。
 *
 * 用法：
 *   pnpm qa                       # = offline
 *   node tools/qa/run-regression.mjs local-online
 *   node tools/qa/run-regression.mjs public-online
 *   SERVER_BASE_URL=https://... node tools/qa/run-regression.mjs public-online
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tier = process.argv[2] ?? "offline";
const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";
const node = process.execPath;

const results = [];

function run(label, command, args, opts = {}) {
  console.log(`\n▶ ${label}`);
  const started = Date.now();
  // Windows 上的 spawn 规则（修「'C:\Program' 不是内部或外部命令」）：
  // - node 子进程：executable + args 数组 + shell:false。process.execPath 通常是
  //   "C:\Program Files\nodejs\node.exe"，含空格；以前 shell:true 把它整条拼进 cmd
  //   字符串，空格处被截断。数组形式不做任何 shell 解析，天然免疫空格路径。
  // - pnpm：Windows 上它是 pnpm.cmd 批处理 shim，新版 Node 出于 CVE-2024-27980
  //   防护，shell:false 拉起 .cmd 会直接 EINVAL；必须走 shell。但传给 cmd 的是
  //   不含路径的裸名 "pnpm.cmd"（由 PATH 解析），不存在空格问题，故保持 shell:true。
  const useShell = isWin && command === pnpm;
  const r = spawnSync(command, args, {
    cwd: ROOT,
    stdio: opts.quiet ? "ignore" : "inherit",
    shell: useShell,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeoutMs ?? 15 * 60_000,
  });
  const ok = r.status === 0;
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ label, ok, seconds });
  console.log(`${ok ? "  ✓ 通过" : `  ✗ 失败（退出码 ${r.status}）`}  ${label}  [${seconds}s]`);
  return ok;
}

/** 探针失败时告诉人工该看哪一层，而不是只给一个退出码。 */
function report() {
  console.log("\n========== 回归结果 ==========");
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"}  ${r.label}  [${r.seconds}s]`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log(`\n全部通过（${results.length} 步）`);
  } else {
    console.log(`\n${failed.length} 步失败：${failed.map((f) => f.label).join(" / ")}`);
    console.log("排查提示：单测失败看 vitest 输出的用例名；domcheck 失败先确认 pnpm build 产物是最新的；");
    console.log("online 档失败先确认服务真的在跑（curl $BASE/health），再分不清是代码还是环境时看 docs/INTERNAL_TESTING.md 常见问题表。");
  }
  return failed.length === 0 ? 0 : 1;
}

const OFFLINE_DOMCHECK = [
  "tools/domcheck/check-countdown.mjs",     // 小场结算：只弹数字、无牌型/牌面/按钮、倒计时自收
  "tools/domcheck/check-meld-dom.mjs",      // 暗杠只亮一张、牌数守恒
  "tools/domcheck/check-two-click.mjs",     // 两次点击出牌、只在有权时出按钮
  "tools/domcheck/check-match-points.mjs",  // 整局累计跨小场不清零、整局结算四行明细
  "tools/domcheck/check-takeover-flow.mjs", // 托管浮层 / 退出二次确认 / 三种在场状态词
];

async function main() {
  if (tier === "offline" || tier === "all") {
    if (!run("build", pnpm, ["build"])) return finish();
    if (!run("typecheck", pnpm, ["typecheck"])) return finish();
    if (!run("unit tests（全量，含关键风险探针）", pnpm, ["test"])) return finish();
    for (const script of OFFLINE_DOMCHECK) {
      const label = `domcheck:${path.basename(script)}`;
      if (!existsSync(path.join(ROOT, script))) {
        results.push({ label, ok: false, seconds: 0 });
        console.log(`  ✗ 探针脚本缺失：${script}`);
        continue;
      }
      // quiet 先跑；失败再重放一次带输出，让人看到红在哪
      if (!run(label, node, [script], { quiet: true })) {
        run(`${label}（重放输出）`, node, [script]);
      }
    }
  }

  if (tier === "local-online" || tier === "all") {
    // node 子进程一律 shell:false（见 run() 内注释：空格路径免疫）
    const health = spawnSync(node, ["-e",
      "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { shell: false, timeout: 15_000 });
    if (health.status !== 0) {
      console.log("\n✗ 本机 3000 端口没有服务端 —— 先启动它：");
      console.log("    cd apps/server && node dist/main.js   （或 pnpm --filter @mianyang-mahjong/server start）");
      results.push({ label: "local-online: 服务可达性", ok: false, seconds: 0 });
      return finish();
    }
    const envFile = path.join(ROOT, "apps", "server", ".env");
    const envArgs = existsSync(envFile) ? ["--env-file=" + envFile] : [];
    if (!run("smoke（接口自检）", node, [...envArgs, "apps/server/scripts/smoke.mjs"])) return finish();
    if (!run("acceptance（四人 8 局端到端）", node, [...envArgs, "apps/server/scripts/acceptance.mjs"], { timeoutMs: 10 * 60_000 })) return finish();
    if (!run("abandonment（四人弃局提前终局）", node, [...envArgs, "apps/server/scripts/abandonment-acceptance.mjs"], { timeoutMs: 5 * 60_000 })) return finish();
  }

  if (tier === "public-online" || tier === "all") {
    const base = process.env.SERVER_BASE_URL ?? "https://0106.wiki";
    const envFile = path.join(ROOT, "apps", "server", ".env");
    const envArgs = existsSync(envFile) ? ["--env-file=" + envFile] : [];
    console.log(`\n▶ public-online 目标：${base}`);
    if (!run("公网 /health", node, ["-e",
      `fetch('${base}/health').then(async r=>{console.log(r.ok?await r.text():'HTTP '+r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(String(e));process.exit(1)})`],
      { shell: false, timeout: 30_000 })) return finish();
    if (!run("公网 smoke（SERVER_BASE_URL 指向线上）", node, [...envArgs, "apps/server/scripts/smoke.mjs"],
      { env: { SERVER_BASE_URL: base }, timeoutMs: 5 * 60_000 })) return finish();
    console.log("\n提示：完整线上行为验收（真渲染 + 真协议）需要 4 把密钥：");
    console.log("  PAGE=<线上地址> KEYS=KEY1,KEY2,KEY3,KEY4 node tools/domcheck/check-remote.mjs");
  }

  if (tier === "manual") {
    console.log(`
真机 / 人工验收清单：docs/INTERNAL_TESTING.md 第七节（A 登录 / B 对局 8 局 / C 群聊 / D 图片 / E 语音 / F 异常恢复）。
离线自动验不到、必须真机的：Android 相册桥接、麦克风桥接、横屏分辨率适配、弱网、长时间运行、云存储直传。
每一条都要"真的失败一次"才算有效覆盖 —— 见 INTERNAL_TESTING.md 第六节末尾的假绿说明。
`);
    results.push({ label: "manual: 清单已打印（无自动断言）", ok: true, seconds: 0 });
  }

  return finish();
}

function finish() { process.exit(report()); }

main().catch((e) => { console.error("run-regression 异常：", e); process.exit(2); });
