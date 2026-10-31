import { Signer } from "@aws-sdk/rds-signer";
import { Pool, types } from "pg";
import type { PgVerifyConfig } from "./verify.js";

/**
 * Minimal query surface the PG drivers depend on. A real pg Pool
 * satisfies it structurally, and tests inject a stub instead — so no
 * PG driver test ever touches a live database.
 */
export interface PgClientLike {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

export interface PgPoolLike {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

// node-postgres parses BIGINT (int8, e.g. IDENTITY ids and COUNT(*))
// as strings by default. The drivers also Number() every id/count at
// the mapping boundary, but the parser makes the default safe for any
// column a mapper forgets: ids and counts arrive as numbers.
let int8ParserInstalled = false;
function ensureInt8Parser(): void {
  if (int8ParserInstalled) return;
  types.setTypeParser(20, (value: string) => parseInt(value, 10));
  int8ParserInstalled = true;
}

/**
 * Resident pool for a PG driver. Unlike the verify probe (max: 1,
 * created and closed per call), this pool lives for the process
 * lifetime and is closed by the driver's close(). Authentication is
 * IAM database auth, exactly like verify.ts: every NEW connection
 * asks rds-signer for a fresh token (tokens live 15 minutes and are
 * only checked at connect time), so a stored password would go stale.
 * The token value is never logged, returned, or embedded in an error.
 *
 * SSL is encryption-required but the CA chain is not verified
 * (sslmode=require equivalent, same documented caveat as verify.ts:
 * the RDS CA bundle is not shipped with this service, so verify-full
 * would fail closed on a missing bundle rather than on a real problem).
 */
export function createPgPool(config: PgVerifyConfig, max = 10): Pool {
  ensureInt8Parser();
  const signer = new Signer({
    hostname: config.host,
    port: config.port,
    username: config.user,
    region: config.region,
  });
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    max,
    password: () => signer.getAuthToken(),
    ssl: { rejectUnauthorized: false },
  });
}
