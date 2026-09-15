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
    const { payload } = await jwtVerify(token, this.key, { issuer: "mianyang-mahjong" });
    if (payload.scope !== "admin" || typeof payload.sub !== "string") throw new Error("INVALID_ADMIN_TOKEN");
    if (payload.role !== "super_admin" && payload.role !== "review_admin") throw new Error("INVALID_ADMIN_TOKEN");
    return { adminId: payload.sub, role: payload.role };
  }

  async verifyUserToken(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.key, { issuer: "mianyang-mahjong" });
    if (payload.scope !== "user" || typeof payload.sub !== "string") throw new Error("INVALID_USER_TOKEN");
    return payload.sub;
  }
}

export function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("AUTH_REQUIRED");
  return match[1]!;
}
