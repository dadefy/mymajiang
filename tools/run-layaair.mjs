import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const userInstall = process.platform === "win32"
  ? join(homedir(), ".layaair", "layaair.cmd")
  : join(homedir(), ".layaair", "layaair");
const command = existsSync(userInstall) ? userInstall : "layaair";
const result = spawnSync(command, process.argv.slice(2), {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error?.code === "ENOENT") {
  console.error("LayaAir CLI 未安装。请先按 docs/INTERNAL_TESTING.md 第十节安装 3.4.0。");
  process.exit(1);
}
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
