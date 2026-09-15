/**
 * 读取 `apps/server/.env`。
 *
 * 用 Node 内建的 `process.loadEnvFile`，不引入 dotenv。文件不存在就直接跳过 ——
 * 生产环境用真实的环境变量，没有 `.env` 是正常情况。
 *
 * 路径用 `../.env` 而不是当前工作目录：`src/` 与 `dist/` 都在 `apps/server` 下面一层，
 * 所以从源码跑和从构建产物跑解析结果一致，不受启动目录影响。
 *
 * **必须在任何 `process.env` 读取之前调用**，否则读到的是未加载的值。
 */
export function loadEnvironment(): void {
  try {
    process.loadEnvFile(new URL("../.env", import.meta.url));
  } catch {
    // 没有 .env 就用进程已有的环境变量。
  }
}
