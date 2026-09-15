import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { PasswordHasher } from "@mianyang-mahjong/domain";

/**
 * scrypt 参数。内存开销约 `128 * N * r` ≈ 16 MB，低于 Node 的默认 `maxmem`（32 MB），
 * 所以不需要额外放宽限制。
 */
const PARAMETERS = { N: 16_384, r: 8, p: 1, keyLength: 32 } as const;
const ALGORITHM = "scrypt";

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/**
 * 用 node:crypto 的 scrypt 做密码哈希，不引入第三方依赖。
 *
 * 存的是自描述串 `scrypt$N=...,r=...,p=...$salt$hash`：把参数一起写进去，将来调强参数时
 * 老哈希仍然可验证，可以逐个升级，而不是一次性作废所有密码。
 *
 * scrypt 是刻意吃 CPU 与内存的算法，所以全部用同步版本 —— 这些调用只出现在登录与改密，
 * 频率极低；换成异步反而会让「登录要等多少次 tick」变得不确定。
 */
export class ScryptPasswordHasher implements PasswordHasher {
  hash(password: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, PARAMETERS.keyLength, {
      N: PARAMETERS.N,
      r: PARAMETERS.r,
      p: PARAMETERS.p,
    });
    const header = `${ALGORITHM}$N=${PARAMETERS.N},r=${PARAMETERS.r},p=${PARAMETERS.p}`;
    return `${header}$${salt.toString("base64")}$${derived.toString("base64")}`;
  }

  verify(password: string, storedHash: string): boolean {
    const parsed = parseHash(storedHash);
    if (!parsed) return false;
    let derived: Buffer;
    try {
      derived = scryptSync(password, parsed.salt, parsed.hash.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
      });
    } catch {
      // 参数离谱（例如被改坏了）时 scrypt 会直接抛错；这属于「验不过」，不是异常。
      return false;
    }
    // 长度已经由 keyLength 对齐，但 timingSafeEqual 要求严格等长，所以再确认一次。
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  }
}

/** 认不出的格式一律返回 `undefined`，由调用方当成「验证失败」处理。 */
function parseHash(storedHash: string): ParsedHash | undefined {
  const parts = storedHash.split("$");
  if (parts.length !== 4) return undefined;
  const [algorithm, parameters, salt, hash] = parts;
  if (algorithm !== ALGORITHM || !parameters || !salt || !hash) return undefined;
  const fields = new Map(
    parameters.split(",").map((field) => {
      const [key, value] = field.split("=");
      return [key, Number(value)];
    }),
  );
  const N = fields.get("N");
  const r = fields.get("r");
  const p = fields.get("p");
  if (!isUsableParameter(N) || !isUsableParameter(r) || !isUsableParameter(p)) return undefined;
  const saltBuffer = Buffer.from(salt, "base64");
  const hashBuffer = Buffer.from(hash, "base64");
  if (saltBuffer.length === 0 || hashBuffer.length === 0) return undefined;
  return { N, r, p, salt: saltBuffer, hash: hashBuffer };
}

function isUsableParameter(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
