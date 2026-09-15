import { createHash, randomBytes } from "node:crypto";
import type { InvitationKeyCodec } from "@mianyang-mahjong/domain";

/** Crockford base32：去掉了容易与数字混淆的 I、L、O、U。 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = "MYMJ";
/** 16 个 base32 字符 = 80 bit 随机量，内测阶段足够，也还念得出来。 */
const BODY_LENGTH = 16;
const GROUP_SIZE = 4;

/**
 * 邀请密钥的明文生成与哈希。
 *
 * 明文形如 `MYMJ-7K3M-9QXA-2WET-5ZVB`；归一化后（去掉分隔符、转大写）是 `MYMJ` + 16 个字符。
 * 存储与查找都用归一化明文的 SHA-256：密钥是 80 bit 随机量，不存在被暴力反推的问题，
 * 所以不需要再加盐，也就能用它做唯一索引。
 */
export class CryptoInvitationKeyCodec implements InvitationKeyCodec {
  generate(): string {
    // 10 字节 = 80 bit，正好切成 16 个 5 bit 的字符。
    let bits = 0n;
    for (const byte of randomBytes(10)) bits = (bits << 8n) | BigInt(byte);
    let body = "";
    for (let index = 0; index < BODY_LENGTH; index += 1) {
      body = ALPHABET[Number(bits & 31n)]! + body;
      bits >>= 5n;
    }
    const groups = body.match(new RegExp(`.{1,${GROUP_SIZE}}`, "g")) ?? [];
    return [PREFIX, ...groups].join("-");
  }

  normalize(input: string): string {
    const canonical = input.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!canonical.startsWith(PREFIX) || canonical.length !== PREFIX.length + BODY_LENGTH) {
      throw new Error("KEY_MALFORMED");
    }
    return canonical;
  }

  hash(canonicalKey: string): string {
    return createHash("sha256").update(canonicalKey).digest("hex");
  }

  hint(canonicalKey: string): string {
    return canonicalKey.slice(0, PREFIX.length + GROUP_SIZE);
  }
}
