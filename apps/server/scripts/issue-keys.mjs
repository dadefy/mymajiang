/**
 * 签发内测邀请密钥，并把明文记进本地台账。
 *
 * 为什么需要这个脚本：服务端**按设计只存哈希**（见 PROJECT_STATUS 4.3 与第 11 节第 16 条），
 * 明文只在签发响应里出现一次 —— 这样「数据库被拖走」不会导致所有账号失守。
 * 代价是签发之后**无法在后台查回明文**，所以把记账挪到签发这一侧：
 * 签发 → 明文追加进本地台账文件 → 以后随时能查。
 *
 * 服务端的安全模型一点没变，明文也不会进仓库（台账文件已在 .gitignore 里）。
 *
 * 用法（在 apps/server 目录下）：
 *   node --env-file=.env scripts/issue-keys.mjs 4 "给测试组"
 *   node --env-file=.env scripts/issue-keys.mjs 1 "给张三" --quiet   # 只写台账、屏幕不打印
 *
 * 环境变量：
 *   ADMIN_ID / ADMIN_PASSWORD   管理员凭据（用 --env-file=.env 传，不要写进命令行）
 *   KEYS_LEDGER                 台账文件路径，默认 apps/server/.keys-ledger.txt
 *   SERVER_BASE_URL             服务端地址，默认 http://127.0.0.1:3000
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.SERVER_BASE_URL ?? "http://127.0.0.1:3000";
const LEDGER = process.env.KEYS_LEDGER ?? fileURLToPath(new URL("../.keys-ledger.txt", import.meta.url));

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const [countRaw, noteRaw] = args.filter((arg) => !arg.startsWith("--"));
const count = Number(countRaw);

if (!Number.isInteger(count) || count < 1 || count > 100) {
  console.error("用法: node --env-file=.env scripts/issue-keys.mjs <数量 1-100> [备注] [--quiet]");
  process.exit(1);
}
const note = (noteRaw ?? "").trim();

const adminId = process.env.ADMIN_ID;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminId || !adminPassword) {
  console.error("缺 ADMIN_ID / ADMIN_PASSWORD —— 用 --env-file=.env 启动，别把它们写进命令行。");
  process.exit(1);
}

/** 台账里带日期，方便以后判断哪把是哪批发的。 */
function stamp(date = new Date()) {
  const pad = (value) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function main() {
  const loginResponse = await fetch(`${BASE}/v1/admin/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminId, password: adminPassword }),
  });
  if (!loginResponse.ok) {
    console.error(`管理员登录失败：HTTP ${loginResponse.status}`);
    process.exit(1);
  }
  const { token } = await loginResponse.json();

  const issuedResponse = await fetch(`${BASE}/v1/admin/invitation-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": token },
    body: JSON.stringify({ count, note }),
  });
  if (!issuedResponse.ok) {
    console.error(`签发失败：HTTP ${issuedResponse.status} ${await issuedResponse.text()}`);
    process.exit(1);
  }
  const issued = await issuedResponse.json();
  const keys = issued.keys.map((item) => item.key);
  const now = stamp();

  // 台账只追加：即使这次签发完就把屏幕清了，明文也在这里躺着。
  const header = existsSync(LEDGER)
    ? ""
    : "## 内测邀请密钥台账（明文，勿提交、勿外传）\n## 一把密钥只能建一个账号；丢失等于账号丢失。\n\n";
  const lines = keys.map((key) => `${key}\t${note || "-"}\t${now}`).join("\n");
  const block = `${header}### ${now}  签发 ${keys.length} 把${note ? `  备注：${note}` : ""}\n${lines}\n\n`;
  await appendFile(LEDGER, block, "utf8");

  console.log(`已签发 ${keys.length} 把，台账：${LEDGER}`);
  if (!quiet) {
    // 屏幕上也打一份，方便当场发给别人。打完就存进台账了，不用怕滚屏。
    for (const key of keys) console.log(`  ${key}`);
  }
}

await main();
