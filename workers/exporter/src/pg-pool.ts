import { Signer } from "@aws-sdk/rds-signer";
import { Pool, types } from "pg";
import type { Pool as PgPool, PoolClient } from "pg";

/**
 * PG connection config for the exporter, mirroring the cleaner's pool
 * (workers/cleaner/src/pg-pool.ts) and the API's pool
 * (apps/api/src/pg/pool.ts). The exporter package cannot import from
 * the cleaner (the cleaner depends on the exporter), so the small
 * config + pool factory are duplicated here on purpose; keep the
 * defaults in sync with the cleaner side.
 *
 * Auth: IAM database authentication. The pool's `password` is a
 * callback, so every NEW connection asks rds-signer for a fresh token
 * (tokens live 15 minutes and are checked only at connect time). The
 * token is never logged, never returned, and never stored — it exists
 * only inside the callback's return value.
 *
 * SSL is encryption-required but does not verify the RDS CA chain
 * (same documented caveat as the verify endpoint: the service has no
 * RDS CA bundle yet; tightening it is a later step).
 */
export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  region: string;
}

export function resolvePgConfig(env: NodeJS.ProcessEnv = process.env): PgConfig | { error: string } {
  // Same pick semantics as the verify endpoint (apps/api/src/pg/verify.ts):
  // an UNSET variable takes the default; an explicitly EMPTY one is an
  // error (fail fast) instead of silently falling back to the default.
  const pick = (key: string, fallback: string): string | null => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const value = raw.trim();
    return value.length > 0 ? value : null;
  };
  const host = pick("PG_HOST", "database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com");
  const portRaw = pick("PG_PORT", "5432");
  const database = pick("PG_DATABASE", "data_pipeline");
  const user = pick("PG_USER", "data_pipeline_app");
  const region = pick("PG_REGION", "ap-southeast-1");
  if (host === null || database === null || user === null || region === null || portRaw === null) {
    return { error: "pg driver configuration is incomplete (need PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_REGION non-empty)" };
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    return { error: `pg driver configuration is invalid: PG_PORT=${portRaw}` };
  }
  return { host, port, database, user, region };
}

/** Narrow pool/client surface the PG export read depends on (real pg
 * Pool satisfies these structurally; tests inject stubs). The export
 * is a pure read, so only query() is ever called; connect()/end()
 * exist so callers can manage the pool lifecycle through one type. */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

// PG returns BIGINT (int8) as strings by default; the reader Number()s
// every count at the mapping boundary anyway, but parsing int8 to a
// number here keeps stub-test realism aligned with production rows.
types.setTypeParser(20, (v: string) => parseInt(v, 10));

export function createPgPool(config: PgConfig, max = 5): PgPool {
  const signer = new Signer({
    hostname: config.host,
    port: config.port,
    region: config.region,
    username: config.user,
  });
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: () => signer.getAuthToken(),
    ssl: { rejectUnauthorized: false },
    max,
  });
}
