import { describe, expect, it } from "vitest";
import { ScryptPasswordHasher } from "./password-hasher.js";

const hasher = new ScryptPasswordHasher();

describe("ScryptPasswordHasher", () => {
  it("校验自己生成的哈希，并拒绝错误的密码", () => {
    const stored = hasher.hash("correct horse battery staple");
    expect(hasher.verify("correct horse battery staple", stored)).toBe(true);
    expect(hasher.verify("correct horse battery stapl", stored)).toBe(false);
    expect(hasher.verify("", stored)).toBe(false);
  });

  it("同一个密码每次哈希都不同（盐是随机的），但都能验过", () => {
    const first = hasher.hash("same password twice");
    const second = hasher.hash("same password twice");
    expect(first).not.toBe(second);
    expect(hasher.verify("same password twice", first)).toBe(true);
    expect(hasher.verify("same password twice", second)).toBe(true);
  });

  it("哈希串自描述算法与参数，明文不出现在里面", () => {
    const stored = hasher.hash("do not leak me");
    expect(stored.startsWith("scrypt$N=16384,r=8,p=1$")).toBe(true);
    expect(stored.split("$")).toHaveLength(4);
    expect(stored).not.toContain("do not leak me");
  });

  it("认不出的哈希串一律当作验证失败，而不是抛异常", () => {
    for (const broken of [
      "",
      "plaintext",
      "scrypt$N=16384,r=8,p=1$onlythreeparts",
      "bcrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==",
      "scrypt$N=0,r=8,p=1$c2FsdA==$aGFzaA==",
      "scrypt$N=abc,r=8,p=1$c2FsdA==$aGFzaA==",
      "scrypt$N=16384,r=8,p=1$$aGFzaA==",
    ]) {
      expect(hasher.verify("whatever", broken)).toBe(false);
    }
  });
});
