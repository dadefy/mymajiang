import { describe, expect, it } from "vitest";
import { CryptoInvitationKeyCodec } from "./invitation-key-codec.js";

const codec = new CryptoInvitationKeyCodec();

describe("CryptoInvitationKeyCodec", () => {
  it("生成 MYMJ 开头、四段四位的密钥", () => {
    const key = codec.generate();

    expect(key).toMatch(/^MYMJ(-[0-9A-Z]{4}){4}$/);
    // 归一化后是前缀 + 16 位，也就是 80 bit 随机量。
    expect(codec.normalize(key)).toBe(key.replace(/-/g, ""));
    expect(codec.normalize(key)).toHaveLength(20);
  });

  it("连续生成不会重复", () => {
    const keys = new Set(Array.from({ length: 200 }, () => codec.generate()));
    expect(keys.size).toBe(200);
  });

  it("归一化时忽略大小写与分隔符，所以哈希一致", () => {
    const key = codec.generate();
    const loose = `  ${key.toLowerCase().replace(/-/g, " ")}  `;

    // 同一把密钥，输入方式不同也要归到同一个哈希上 —— 登录时就是这样查账号的。
    expect(codec.hash(codec.normalize(loose))).toBe(codec.hash(codec.normalize(key)));
  });

  it("提示位只取前 8 位，不暴露明文其余部分", () => {
    const key = codec.generate();
    const canonical = codec.normalize(key);

    expect(codec.hint(canonical)).toBe(canonical.slice(0, 8));
    expect(codec.hash(canonical)).toHaveLength(64);
    expect(codec.hint(canonical)).not.toBe(canonical);
  });

  it("格式不对时抛 KEY_MALFORMED", () => {
    expect(() => codec.normalize("MYMJ-0000-0000")).toThrow("KEY_MALFORMED");
    expect(() => codec.normalize("XXXX-0000-0000-0000-0000")).toThrow("KEY_MALFORMED");
    expect(() => codec.normalize("")).toThrow("KEY_MALFORMED");
    expect(() => codec.normalize("MYMJ-0000-0000-0000-00000")).toThrow("KEY_MALFORMED");
  });
});
