/**
 * 一次把内测账号准备好：签发密钥 → 建号 → 发积分。
 *
 * 为什么需要它：现在跑的是**内存模式**（没配 DATABASE_URL），服务端一重启，
 * 账号、密钥记录、房间、群全部清零。而验收期间为了应用代码改动，重启是免不了的 ——
 * 手工重来一遍（签密钥 → 每人激活 → 逐个发积分）要好几分钟，还容易漏。
 * 这个脚本把那一轮操作压成一条命令。
 *
 * 用法（在 apps/server 目录下）：
 *   node --env-file=.env scripts/seed-testers.mjs 张三 李四 王五 赵六
 *   node --env-file=.env scripts/seed-testers.mjs 张三 --points 5000   # 改发放额度
 *
 * 明文密钥会**写进台账**（`apps/server/.keys-ledger.txt`，已在 .gitignore 里），
 * 屏幕上也打一份方便当场发给测试的人。想只看台账就加 `--quiet`。
 *
 * 环境变量：ADMIN_ID / ADMIN_PASSWORD / SERVER_BASE_URL（默认 http://127.0.0.1:3000）
 */
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.SERVER_BASE_URL ?? "http://127.0.0.1:3000";
const LEDGER = process.env.KEYS_LEDGER ?? fileURLToPath(new URL("../.keys-ledger.txt", import.meta.url));

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const pointsIndex = args.indexOf("--points");
const points = pointsIndex >= 0 ? Number(args[pointsIndex + 1]) : 2000;
const nicknames = args.filter((arg, index) =>
  !arg.startsWith("--") && index !== pointsIndex + 1);

if (nicknames.length === 0 || !Number.isInteger(points) || points < 500) {
  console.error("用法: node --env-file=.env scripts/seed-testers.mjs <昵称...> [--points 2000] [--quiet]");
  console.error("（积分不能低于 500 —— 那是进房的门槛）");
  process.exit(1);
}
const adminId = process.env.ADMIN_ID;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminId || !adminPassword) {
  console.error("缺 ADMIN_ID / ADMIN_PASSWORD —— 用 --env-file=.env 启动，别把它们写进命令行。");
  process.exit(1);
}

const stamp = (date = new Date()) => {
  const pad = (value) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

async function call(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { "X-Auth-Token": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> HTTP ${response.status} ${parsed?.code ?? parsed?.message ?? ""}`);
  }
  return parsed;
}

async function main() {
  const session = await call("/v1/admin/session", {
    method: "POST",
    body: { adminId, password: adminPassword },
  });
  const adminToken = session.token;

  const issued = await call("/v1/admin/invitation-keys", {
    method: "POST",
    token: adminToken,
    body: { count: nicknames.length, note: `内测：${nicknames.join("、")}` },
  });
  const keys = issued.keys.map((item) => item.key);

  const rows = [];
  for (const [index, nickname] of nicknames.entries()) {
    const key = keys[index];
    const activated = await call("/v1/auth/activate", {
      method: "POST",
      body: { key, nickname, avatarUrl: "https://example.invalid/avatar.png" },
    });
    await call(`/v1/admin/users/${activated.userId}/points`, {
      method: "POST",
      token: adminToken,
      body: { delta: points, reason: "内测发放" },
    });
    rows.push({ nickname, userId: activated.userId, key });
  }

  const now = stamp();
  const header = existsSync(LEDGER)
    ? ""
    : "## 内测邀请密钥台账（明文，勿提交、勿外传）\n## 一把密钥只能建一个账号；丢失等于账号丢失。\n\n";
  const lines = rows.map((row) => `${row.key}\t${row.nickname}（${row.userId}）\t${now}`).join("\n");
  await appendFile(
    LEDGER,
    `${header}### ${now}  建号 ${rows.length} 个，各发 ${points} 积分\n${lines}\n\n`,
    "utf8",
  );

  console.log(`已建号 ${rows.length} 个，各发 ${points} 积分。台账：${LEDGER}`);
  console.log("");
  for (const row of rows) {
    // 默认把密钥打出来，方便直接发给对应的人；--quiet 则只留台账。
    console.log(`  ${row.nickname.padEnd(8)} 用户ID ${row.userId}${quiet ? "" : `  密钥 ${row.key}`}`);
  }
  if (quiet) console.log("\n（--quiet：密钥只写进了台账，用 Get-Content 查看）");
}

await main();
