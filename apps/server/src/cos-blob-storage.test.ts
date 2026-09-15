import { describe, expect, it } from "vitest";
import { CosBlobStorage } from "./cos-blob-storage.js";

const OPTIONS = {
  secretId: "AKIDexampleexampleexample",
  secretKey: "example-secret-key-value",
  bucket: "examplebucket-1250000000",
  region: "ap-chengdu",
};

const KEY = "uploads/1234567890/image/11111111-2222-3333-4444-555555555555";

function signer(): CosBlobStorage {
  return new CosBlobStorage(OPTIONS);
}

describe("CosBlobStorage", () => {
  it("缺密钥或桶信息时拒绝构造", () => {
    expect(() => new CosBlobStorage({ ...OPTIONS, secretId: "" })).toThrow("credentials");
    expect(() => new CosBlobStorage({ ...OPTIONS, secretKey: "" })).toThrow("credentials");
    expect(() => new CosBlobStorage({ ...OPTIONS, bucket: "" })).toThrow("bucket and region");
    expect(() => new CosBlobStorage({ ...OPTIONS, region: "" })).toThrow("bucket and region");
  });

  it("签发上传地址：指向正确的虚拟主机与对象路径，并带上签名参数", async () => {
    const presigned = await signer().presignUpload({ key: KEY, contentType: "image/jpeg" });
    expect(presigned.method).toBe("PUT");
    const url = new URL(presigned.url);
    expect(url.host).toBe("examplebucket-1250000000.cos.ap-chengdu.myqcloud.com");
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get("q-sign-algorithm")).toBe("sha1");
    expect(url.searchParams.get("q-ak")).toBe(OPTIONS.secretId);
    expect(url.searchParams.get("q-signature")).toMatch(/^[0-9a-f]{40}$/);
    // 过期时间在将来。
    const expires = Number(url.searchParams.get("q-key-time")!.split(";")[1]);
    expect(expires).toBeGreaterThan(Date.now() / 1000);
  });

  it("上传签名绑定内容类型，下载签名只绑 host", async () => {
    const upload = new URL((await signer().presignUpload({ key: KEY, contentType: "image/jpeg" })).url);
    expect(upload.searchParams.get("q-header-list")).toBe("content-type;host");
    expect(upload.searchParams.get("q-header-list")).not.toContain("host;content-type");

    const download = new URL(await signer().presignDownload(KEY));
    expect(download.searchParams.get("q-header-list")).toBe("host");
  });

  it("签名绑定对象键与内容类型：任一不同则签名不同", async () => {
    const storage = signer();
    const signatureOf = async (key: string, contentType: string): Promise<string> =>
      new URL((await storage.presignUpload({ key, contentType })).url).searchParams.get("q-signature")!;

    const base = await signatureOf(KEY, "image/jpeg");
    expect(await signatureOf(KEY, "image/png")).not.toBe(base);
    expect(await signatureOf(KEY.replace("1234567890", "9999999999"), "image/jpeg")).not.toBe(base);
  });

  it("上传地址的请求头里带上内容类型，客户端照着发就行", async () => {
    const presigned = await signer().presignUpload({ key: KEY, contentType: "audio/mp4" });
    expect(presigned.headers).toEqual({ "Content-Type": "audio/mp4" });
  });

  it("下载地址不带内容类型签名，因为下载时无法预知类型", async () => {
    const url = new URL(await signer().presignDownload(KEY));
    expect(url.searchParams.get("q-header-list")).toBe("host");
    expect(url.searchParams.get("q-url-param-list")).toBe("");
  });

  it("不同密钥签出的地址不同", async () => {
    const one = await signer().presignDownload(KEY);
    const other = await new CosBlobStorage({ ...OPTIONS, secretKey: "another-secret-key-value" }).presignDownload(KEY);
    expect(new URL(one).searchParams.get("q-signature")).not.toBe(new URL(other).searchParams.get("q-signature"));
  });
});
