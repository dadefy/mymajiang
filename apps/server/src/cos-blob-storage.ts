import { createHash, createHmac } from "node:crypto";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  type BlobStorage,
  type PresignedUpload,
} from "./blob-storage.js";

/**
 * 腾讯云 COS 驱动。
 *
 * 签名按官方 v5 XML API 的规则手写（HMAC-SHA1 + 规范化请求串），不引入官方 SDK ——
 * 这个项目一直保持极少依赖，而这里需要的接口面很窄。
 * 实现已经对着真实桶验证过：列桶、读子资源、预签名 PUT/GET/DELETE 全部通过。
 *
 * 两个签法都用到了：
 *   * **预签名 URL**（签名放 query）给客户端直传与直读，客户端不需要任何密钥；
 *   * **Authorization 头**（签名放 header）给服务端自己读写，用于测试与后端处理。
 *
 * **服务端加密不需要在这里做任何事**：桶上开了默认加密之后，不带加密头的 PUT 会自动被加密。
 * 实测确认预签名直传上传的对象带回 `x-cos-server-side-encryption: AES256`，
 * 而预签名 URL 本身是**不能**携带 SSE-COS 头的（带了会破坏签名）。
 */
export class CosBlobStorage implements BlobStorage {
  private readonly host: string;

  constructor(private readonly options: {
    secretId: string;
    secretKey: string;
    bucket: string;
    region: string;
  }) {
    if (!options.secretId || !options.secretKey) throw new Error("COS credentials are required");
    if (!options.bucket || !options.region) throw new Error("COS bucket and region are required");
    this.host = `${options.bucket}.cos.${options.region}.myqcloud.com`;
  }

  async presignUpload(input: { key: string; contentType: string }): Promise<PresignedUpload> {
    // 内容类型参与签名，客户端就不能改用别的类型上传。
    const url = this.presign({ method: "PUT", objectKey: input.key, contentType: input.contentType, ttl: UPLOAD_URL_TTL_SECONDS });
    return { url, method: "PUT", headers: { "Content-Type": input.contentType } };
  }

  async presignDownload(key: string): Promise<string> {
    return this.presign({ method: "GET", objectKey: key, contentType: "", ttl: DOWNLOAD_URL_TTL_SECONDS });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await fetch(`https://${this.host}/${key}`, {
      method: "PUT",
      headers: {
        Authorization: this.authorization({ method: "put", objectKey: key, contentType }),
        "Content-Type": contentType,
      },
      // 转成 Uint8Array：Node 的 fetch 类型不接受 Buffer（Buffer<ArrayBufferLike> 与
      // BodyInit 要求的 ArrayBuffer 视图不兼容）。这条路径只用于服务端自己写入，
      // 客户端走的是预签名直传，不经过这里。
      body: new Uint8Array(body),
    });
    if (!response.ok) throw new Error(`COS put failed: ${response.status} ${await response.text()}`);
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | undefined> {
    const response = await fetch(`https://${this.host}/${key}`, {
      headers: { Authorization: this.authorization({ method: "get", objectKey: key, contentType: "" }) },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`COS get failed: ${response.status} ${await response.text()}`);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** 预签名一个携带签名信息的 URL；签名信息全部放在 query 里。 */
  private presign(input: { method: string; objectKey: string; contentType: string; ttl: number }): string {
    const keyTime = this.keyTime(input.ttl);
    const signKey = hmacSha1Hex(this.options.secretKey, keyTime);
    const headerKeys = input.contentType ? ["content-type", "host"] : ["host"];
    const headerString = headerKeys
      .map((name) => `${name}=${encodeURIComponent(name === "host" ? this.host : input.contentType)}`)
      .join("&");
    const httpString = `${input.method.toLowerCase()}\n/${input.objectKey}\n\n${headerString}\n`;
    const signature = hmacSha1Hex(signKey, `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`);

    const query = new URLSearchParams({
      "q-sign-algorithm": "sha1",
      "q-ak": this.options.secretId,
      "q-sign-time": keyTime,
      "q-key-time": keyTime,
      "q-header-list": headerKeys.join(";"),
      "q-url-param-list": "",
      "q-signature": signature,
    });
    return `https://${this.host}/${input.objectKey}?${query.toString()}`;
  }

  /** 服务端自己调用时用的 Authorization 头。 */
  private authorization(input: { method: string; objectKey: string; contentType: string }): string {
    const keyTime = this.keyTime(60);
    const signKey = hmacSha1Hex(this.options.secretKey, keyTime);
    const headers: Record<string, string> = { host: this.host };
    if (input.contentType) headers["content-type"] = input.contentType;
    const headerKeys = Object.keys(headers).sort();
    const headerString = headerKeys.map((name) => `${name}=${encodeURIComponent(headers[name]!)}`).join("&");
    const httpString = `${input.method.toLowerCase()}\n/${input.objectKey}\n\n${headerString}\n`;
    const signature = hmacSha1Hex(signKey, `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`);

    return [
      "q-sign-algorithm=sha1",
      `q-ak=${this.options.secretId}`,
      `q-sign-time=${keyTime}`,
      `q-key-time=${keyTime}`,
      `q-header-list=${headerKeys.join(";")}`,
      "q-url-param-list=",
      `q-signature=${signature}`,
    ].join("&");
  }

  private keyTime(ttlSeconds: number): string {
    const now = Math.floor(Date.now() / 1000);
    return `${now};${now + ttlSeconds}`;
  }
}

const hmacSha1Hex = (key: string, data: string): string =>
  createHmac("sha1", key).update(data, "utf8").digest("hex");

const sha1Hex = (data: string): string => createHash("sha1").update(data, "utf8").digest("hex");
