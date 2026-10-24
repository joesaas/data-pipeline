import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { StoredToken, TokenRole } from "../domain/types.js";
import { ADMIN_IDENTITY } from "../domain/types.js";
import type { StorageDriver } from "../storage/storage-driver.js";

export const ANONYMOUS = "anonymous";

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Auth module: its single job is to answer "who is this request, and may it
 * proceed". When authRequired is false every request proceeds as anonymous.
 */
export class AuthService {
  constructor(
    private driver: StorageDriver,
    private authRequired: boolean,
  ) {}

  /** Returns the identity for a request, or null when auth fails.
   *  Admin tokens resolve to ADMIN_IDENTITY (cross-identity reader). */
  resolveIdentity(apiKey: string | undefined): string | null {
    if (!this.authRequired) return ANONYMOUS;
    if (!apiKey) return null;
    const tok = this.driver.findTokenByHash(hashKey(apiKey));
    if (!tok || tok.revoked_at !== null) return null;
    return tok.role === "admin" ? ADMIN_IDENTITY : tok.id;
  }

  /** Issue a token; the plain key is returned once and never stored. */
  createToken(name: string, role: TokenRole = "user"): { token: StoredToken; plainKey: string } {
    const plainKey = randomBytes(32).toString("hex");
    const token: StoredToken = {
      id: randomUUID(),
      name,
      key_hash: hashKey(plainKey),
      created_at: new Date().toISOString(),
      revoked_at: null,
      role,
    };
    this.driver.createToken(token);
    return { token, plainKey };
  }
}
