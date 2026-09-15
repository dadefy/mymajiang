/**
 * 对象存储能力。
 *
 * 客户端**直传**云存储，服务端不中转字节：服务端只签发一个有时效的上传地址，
 * 客户端把文件 PUT 上去，再把对象键当作群消息内容发回来。这样服务端不承担带宽与内存，
 * 也不会因为一次大文件上传而占住一个连接。
 *
 * 对象键的规范是 `uploads/<userId>/<kind>/<id>`：**归属与类型都写在键前缀里**，
 * 于是「这条图片消息引用的是不是发送者自己的文件」只需要一次字符串前缀校验，
 * 不必为上传单独建一张表。
 */

export type UploadKind = "image" | "voice";

export const UPLOAD_LIMITS = {
  image: { maximumBytes: 5 * 1024 * 1024, contentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
  voice: {
    maximumBytes: 2 * 1024 * 1024,
    contentTypes: ["audio/mp4", "audio/aac", "audio/amr", "audio/mpeg", "audio/ogg", "audio/webm"],
  },
} as const;

/** 直传地址的有效期。短一点：它只是一次性上传用的，不该长期可用。 */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
/** 读取地址的有效期。群聊回看历史时也够用，同时限制链接被转发后的可用窗口。 */
export const DOWNLOAD_URL_TTL_SECONDS = 30 * 60;

export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** 客户端 PUT 时必须一并带上的请求头，缺了会被存储端拒绝。 */
  headers: Record<string, string>;
}

export interface BlobStorage {
  /**
   * 签发一个直传地址。
   *
   * `contentType` 参与签名，所以客户端不能改用别的类型上传 —— 类型白名单在签发时就已经确定。
   */
  presignUpload(input: { key: string; contentType: string }): Promise<PresignedUpload>;

  /** 签发一个带时效的读取地址。私有桶只能靠它读取。 */
  presignDownload(key: string): Promise<string>;

  /** 服务端自己写入。测试与本地实现用，云上实现可以不走这条路。 */
  put(key: string, body: Buffer, contentType: string): Promise<void>;

  /** 服务端自己读取；不存在时返回 undefined。 */
  get(key: string): Promise<{ body: Buffer; contentType: string } | undefined>;
}

/** 校验对象键是不是某个用户、某个类型下的合法键。 */
export function isOwnedKey(key: string, userId: string, kind: UploadKind): boolean {
  return new RegExp(`^uploads/${escapeRegExp(userId)}/${kind}/[0-9a-fA-F-]{36}$`).test(key);
}

/** 从对象键里认出类型；认不出返回 undefined（例如老数据里存的是一段普通字符串）。 */
export function kindOfKey(key: string): UploadKind | undefined {
  const match = /^uploads\/[^/]+\/(image|voice)\//.exec(key);
  const kind = match?.[1];
  return kind === "image" || kind === "voice" ? kind : undefined;
}

export function buildObjectKey(userId: string, kind: UploadKind, id: string): string {
  return `uploads/${userId}/${kind}/${id}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
