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

  /**
   * Strict variant for endpoints that must never be anonymous, even
   * when the global AUTH_REQUIRED flag is off (e.g. writing files
   * that nginx then serves publicly). Returns null unless the key
   * matches a live token, regardless of authRequired.
   */
  async resolveValidKey(apiKey: string | undefined): Promise<string | null> {
    if (!apiKey) return null;
    const tok = await this.driver.findTokenByHash(hashKey(apiKey));
    if (!tok || tok.revoked_at !== null) return null;
    return tok.role === "admin" ? ADMIN_IDENTITY : tok.id;
  }

  /** Returns the identity for a request, or null when auth fails.
   *  Admin tokens resolve to ADMIN_IDENTITY (cross-identity reader). */
  async resolveIdentity(apiKey: string | undefined): Promise<string | null> {
    if (!this.authRequired) return ANONYMOUS;
    if (!apiKey) return null;
    const tok = await this.driver.findTokenByHash(hashKey(apiKey));
    if (!tok || tok.revoked_at !== null) return null;
    return tok.role === "admin" ? ADMIN_IDENTITY : tok.id;
  }

  /** Issue a token; the plain key is returned once and never stored. */
  async createToken(name: string, role: TokenRole = "user"): Promise<{ token: StoredToken; plainKey: string }> {
    const plainKey = randomBytes(32).toString("hex");
    const token: StoredToken = {
      id: randomUUID(),
      name,
      key_hash: hashKey(plainKey),
      created_at: new Date().toISOString(),
      revoked_at: null,
      role,
    };
    await this.driver.createToken(token);
    return { token, plainKey };
  }
}
