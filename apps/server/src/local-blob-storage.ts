import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DOWNLOAD_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS, type BlobStorage, type PresignedUpload } from "./blob-storage.js";

const META_SUFFIX = ".meta";

/**
 * 把对象存到本地磁盘，并用**自签名的 URL 模拟云端的预签名直传**。
 *
 * 为什么要模拟预签名，而不是让客户端直接把文件 POST 给一个普通接口：
 * 这样客户端代码在本地与云端**完全一样** —— 都是「拿到一个 URL，PUT 上去」。
 * 换存储驱动不需要动客户端一行，也让整条链路在没有云账号时就能被完整测试。
 *
 * 签名覆盖方法、对象键、内容类型与过期时间，所以：
 *   * 拿上传签名去读、或拿读签名去覆盖写，都会被拒；
 *   * 换一个 Content-Type 上传也会被拒（类型白名单在签发时就定死了）。
 */
export class LocalDiskBlobStorage implements BlobStorage {
  private readonly root: string;

  constructor(
    directory: string,
    /**
     * 服务端对外可达的地址，例如 `http://127.0.0.1:3000`；签出来的 URL 指向它。
     *
     * **留空则签发相对地址**（`/v1/blobs/...`）—— 本地驱动的文件本来就由**这台服务器**
     * 自己在 `/v1/blobs/*` 上收发，相对地址一定同源，也就不存在跨域与配错域名的问题。
     * 只有「存与取不在同一个域」时才需要填它。
     */
    private readonly publicBaseUrl: string = "",
    private readonly signingSecret: string,
  ) {
    if (signingSecret.length < 32) throw new Error("Blob signing secret must contain at least 32 characters");
    this.root = resolve(directory);
  }

  async presignUpload(input: { key: string; contentType: string }): Promise<PresignedUpload> {
    const expires = this.expiry(UPLOAD_URL_TTL_SECONDS);
    const signature = this.sign("PUT", input.key, input.contentType, expires);
    const query = new URLSearchParams({
      expires: String(expires),
      contentType: input.contentType,
      signature,
    });
    return {
      url: `${this.publicBaseUrl}/v1/blobs/${input.key}?${query.toString()}`,
      method: "PUT",
      headers: { "Content-Type": input.contentType },
    };
  }

  async presignDownload(key: string): Promise<string> {
    const expires = this.expiry(DOWNLOAD_URL_TTL_SECONDS);
    const signature = this.sign("GET", key, "", expires);
    const query = new URLSearchParams({ expires: String(expires), signature });
    return `${this.publicBaseUrl}/v1/blobs/${key}?${query.toString()}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(path + META_SUFFIX, JSON.stringify({ contentType }), "utf8");
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | undefined> {
    const path = this.pathFor(key);
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      return undefined;
    }
    let contentType = "application/octet-stream";
    try {
      const meta = JSON.parse(await readFile(path + META_SUFFIX, "utf8")) as { contentType?: unknown };
      if (typeof meta.contentType === "string") contentType = meta.contentType;
    } catch {
      // 元信息丢了不影响把字节读回去，用兜底类型即可。
    }
    return { body, contentType };
  }

  /**
   * 校验一个请求带的签名。返回是否放行。
   *
   * 供路由层在 `PUT` / `GET /v1/blobs/*` 时调用。
   */
  verify(input: { method: "PUT" | "GET"; key: string; contentType: string; expires: string; signature: string }): boolean {
    const expires = Number(input.expires);
    if (!Number.isSafeInteger(expires) || expires * 1000 < Date.now()) return false;
    const expected = this.sign(input.method, input.key, input.contentType, expires);
    const given = Buffer.from(input.signature, "utf8");
    const want = Buffer.from(expected, "utf8");
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private expiry(ttlSeconds: number): number {
    return Math.floor(Date.now() / 1000) + ttlSeconds;
  }

  private sign(method: string, key: string, contentType: string, expires: number): string {
    return createHmac("sha256", this.signingSecret)
      .update(`${method}\n${key}\n${contentType}\n${expires}`)
      .digest("base64url");
  }

  /**
   * 把对象键映射到磁盘路径。
   *
   * 先按白名单形状校验键，再确认解析后的路径仍在根目录内 —— 两道一起挡住 `../` 穿越。
   */
  private pathFor(key: string): string {
    if (!/^uploads\/\d{10}\/(image|voice)\/[0-9a-fA-F-]{36}$/.test(key)) {
      throw new Error("INVALID_OBJECT_KEY");
    }
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) throw new Error("INVALID_OBJECT_KEY");
    return path;
  }
}
