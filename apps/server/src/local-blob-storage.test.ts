import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDiskBlobStorage } from "./local-blob-storage.js";

const SECRET = "test-signing-secret-that-is-longer-than-32-characters";
const KEY = "uploads/1234567890/image/11111111-2222-3333-4444-555555555555";

const directories: string[] = [];

async function storageAt(): Promise<LocalDiskBlobStorage> {
  const directory = await mkdtemp(join(tmpdir(), "mymj-blobs-"));
  directories.push(directory);
  return new LocalDiskBlobStorage(directory, "http://127.0.0.1:3000", SECRET);
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** 从签出来的 URL 里取出校验需要的几个字段。 */
function queryOf(url: string): { expires: string; contentType: string; signature: string } {
  const parsed = new URL(url);
  return {
    expires: parsed.searchParams.get("expires")!,
    contentType: parsed.searchParams.get("contentType") ?? "",
    signature: parsed.searchParams.get("signature")!,
  };
}

describe("LocalDiskBlobStorage", () => {
  it("写进去再读出来，内容与类型都保持", async () => {
    const storage = await storageAt();
    await storage.put(KEY, Buffer.from("假装这是图片字节"), "image/png");

    const object = await storage.get(KEY);
    expect(object?.body.toString("utf8")).toBe("假装这是图片字节");
    expect(object?.contentType).toBe("image/png");
  });

  it("读不存在的对象返回 undefined 而不是抛错", async () => {
    const storage = await storageAt();
    expect(await storage.get(KEY)).toBeUndefined();
  });

  it("签发上传地址：带上方法、内容类型与过期时间", async () => {
    const storage = await storageAt();
    const presigned = await storage.presignUpload({ key: KEY, contentType: "image/jpeg" });

    expect(presigned.method).toBe("PUT");
    expect(presigned.headers["Content-Type"]).toBe("image/jpeg");
    const url = new URL(presigned.url);
    expect(url.pathname).toBe(`/v1/blobs/${KEY}`);
    expect(Number(url.searchParams.get("expires")) * 1000).toBeGreaterThan(Date.now());
  });

  it("上传签名可验证，且绑定内容类型", async () => {
    const storage = await storageAt();
    const presigned = await storage.presignUpload({ key: KEY, contentType: "image/jpeg" });
    const query = queryOf(presigned.url);

    expect(storage.verify({ method: "PUT", key: KEY, ...query })).toBe(true);
    // 换成别的内容类型就不认了 —— 类型白名单在签发时就定了。
    expect(storage.verify({ method: "PUT", key: KEY, ...query, contentType: "image/png" })).toBe(false);
    // 拿上传签名去读也不行：签名覆盖了方法。
    expect(storage.verify({ method: "GET", key: KEY, ...query })).toBe(false);
    // 换一个对象键也不行：签名覆盖了键。
    expect(storage.verify({ method: "PUT", key: KEY.replace("1234567890", "9999999999"), ...query })).toBe(false);
  });

  it("读取签名只能读、不能用来越权覆盖", async () => {
    const storage = await storageAt();
    const url = await storage.presignDownload(KEY);
    const query = queryOf(url);

    expect(storage.verify({ method: "GET", key: KEY, ...query })).toBe(true);
    expect(storage.verify({ method: "PUT", key: KEY, ...query })).toBe(false);
  });

  it("伪造或改动的签名一律拒绝", async () => {
    const storage = await storageAt();
    const presigned = await storage.presignUpload({ key: KEY, contentType: "image/jpeg" });
    const query = queryOf(presigned.url);

    expect(storage.verify({ method: "PUT", key: KEY, ...query, signature: "forged" })).toBe(false);
    expect(storage.verify({ method: "PUT", key: KEY, ...query, signature: query.signature.slice(0, -1) + "x" })).toBe(false);
    // 过期时间被改大也不行：它参与签名。
    expect(storage.verify({ method: "PUT", key: KEY, ...query, expires: String(Number(query.expires) + 86_400) })).toBe(false);
  });

  it("过期的签名即使没被改动也拒绝", async () => {
    const storage = await storageAt();
    const presigned = await storage.presignUpload({ key: KEY, contentType: "image/jpeg" });
    const query = queryOf(presigned.url);

    expect(storage.verify({ method: "PUT", key: KEY, ...query, expires: String(Math.floor(Date.now() / 1000) - 1) })).toBe(false);
  });

  it("对象键不合规范时拒绝，挡住路径穿越", async () => {
    const storage = await storageAt();
    for (const key of [
      "../../etc/passwd",
      "uploads/1234567890/image/../../../secret",
      "uploads/1234567890/../image/11111111-2222-3333-4444-555555555555",
      "uploads/1234567890/other/11111111-2222-3333-4444-555555555555",
      "not-a-key",
    ]) {
      await expect(storage.put(key, Buffer.from("x"), "image/png")).rejects.toThrow("INVALID_OBJECT_KEY");
    }
  });

  it("签名密钥太短时直接拒绝构造", async () => {
    expect(() => new LocalDiskBlobStorage("/tmp", "http://127.0.0.1:3000", "short")).toThrow("at least 32 characters");
  });
});
