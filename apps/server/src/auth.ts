import { SignJWT, jwtVerify } from "jose";
import type { AdminRole } from "@mianyang-mahjong/domain";

export class TokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("JWT secret must contain at least 32 characters");
    this.key = new TextEncoder().encode(secret);
  }

  issueAdminToken(adminId: string, role: AdminRole): Promise<string> {
    return new SignJWT({ scope: "admin", role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(adminId)
      .setIssuer("mianyang-mahjong")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(this.key);
  }

  issueUserToken(userId: string): Promise<string> {
    return new SignJWT({ scope: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer("mianyang-mahjong")
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(this.key);
  }

  async verifyAdminToken(token: string): Promise<{ adminId: string; role: AdminRole }> {
    const payload = await this.verify(token, "INVALID_ADMIN_TOKEN");
    if (payload.scope !== "admin" || typeof payload.sub !== "string") throw new Error("INVALID_ADMIN_TOKEN");
    if (payload.role !== "super_admin" && payload.role !== "review_admin") throw new Error("INVALID_ADMIN_TOKEN");
    return { adminId: payload.sub, role: payload.role };
  }

  async verifyUserToken(token: string): Promise<string> {
    const payload = await this.verify(token, "INVALID_USER_TOKEN");
    if (payload.scope !== "user" || typeof payload.sub !== "string") throw new Error("INVALID_USER_TOKEN");
    return payload.sub;
  }

  /**
   * 校验签名与有效期，并把**任何**失败归一成调用方给的那个错误码。
   *
   * 不这么做的话，`jose` 抛出的原始信息（如 `signature verification failed`）会一路冒到
   * 错误处理器，被当成「业务冲突」返回 409 并把内部细节泄露出去 —— 而它其实是认证失败，
   * 应该返回 401。令牌过期、签名不对、格式损坏都属于这一类。
   */
  private async verify(token: string, failureCode: string): Promise<Record<string, unknown>> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: "mianyang-mahjong" });
      return payload as Record<string, unknown>;
    } catch {
      throw new Error(failureCode);
    }
  }
}

export function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("AUTH_REQUIRED");
  return match[1]!;
}

/**
 * 从请求头里取令牌，**优先自定义头 `X-Auth-Token`，回退标准 `Authorization`**。
 *
 * 为什么需要自定义头：某些部署平台（反向代理、Serverless 网关）会在应用前面加一层
 * 自己的鉴权，**覆盖或污染 `Authorization` 头** —— 我们发出去的 `Bearer <jwt>` 到服务端
 * 手里时，`authorization` 里装的已经是平台自己的令牌。用平台不会碰的 `X-Auth-Token`
 * 承载我们自己的令牌，才能绕过这层干扰。
 *
 * 两个头都支持 `Bearer ` 前缀，也支持不带前缀的裸令牌。
 */
export function authToken(headers: { "x-auth-token"?: string | undefined; authorization?: string | undefined } | undefined): string {
  const raw = headers?.["x-auth-token"] ?? headers?.authorization;
  if (!raw) throw new Error("AUTH_REQUIRED");
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("AUTH_REQUIRED");
  // 带 Bearer 前缀就剥掉，否则当裸令牌用。
  return trimmed.replace(/^Bearer\s+/i, "");
}
