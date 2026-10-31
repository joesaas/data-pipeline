import { Signer } from "@aws-sdk/rds-signer";
import { Pool } from "pg";

/**
 * PostgreSQL migration verification probe.
 *
 * This module is deliberately independent of the SQLite storage driver: it
 * exists so the migration can be gated — build the PG tables, then hit
 * GET /api/v1/admin/pg/verify and only start the driver rewrite / data
 * load / cutover once this reports ok:true. It never creates real tables
 * and never writes durable rows: the write probe runs inside a transaction
 * that is always rolled back.
 *
 * Authentication is IAM database auth, not a static password: every new
 * pool connection asks @aws-sdk/rds-signer for a fresh token (tokens live
 * 15 minutes and are only checked at connect time, so a stored password
 * would go stale). The token value is never logged, returned, or put in
 * an error message.
 *
 * Deploy note: this file's first push (ccd3ab0f) failed to deploy on
 * ENOSPC during npm install; this comment-only change retriggers the
 * auto-deploy after disk space was freed.
 */

export interface PgVerifyConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  region: string;
}

export interface PgTableRef {
  schema: string;
  name: string;
}

/** The 16 tables from the migration DDL draft, in DDL order. */
export const EXPECTED_TABLES: PgTableRef[] = [
  { schema: "app", name: "records" },
  { schema: "app", name: "tokens" },
  { schema: "app", name: "webhooks" },
  { schema: "app", name: "webhook_payloads" },
  { schema: "app", name: "webhook_trigger_history" },
  { schema: "app", name: "pull_tasks" },
  { schema: "app", name: "pending_tasks" },
  { schema: "app", name: "chat_messages" },
  { schema: "app", name: "site_nonces" },
  { schema: "app", name: "site_sessions" },
  { schema: "app", name: "site_favorites" },
  { schema: "news_detail", name: "detail_pages" },
  { schema: "cleaner", name: "cleaned_records" },
  { schema: "cleaner", name: "cleaned_items" },
  { schema: "cleaner", name: "cleaner_meta" },
  { schema: "cleaner", name: "llm_calls" },
];

export interface PgVerifyTables {
  expected: string[];
  found: string[];
  missing: string[];
}

export interface PgVerifyResult {
  ok: boolean;
  pg_version: string | null;
  current_user: string | null;
  tables: PgVerifyTables;
  write_probe: boolean;
  latency_ms: number;
  checked_at: string;
  reason?: string;
}

/** Minimal query surface, so tests can stub the database without a live PG. */
export interface PgProbeClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

function refOf(t: PgTableRef): string {
  return `${t.schema}.${t.name}`;
}

function asRecord(row: unknown): Record<string, unknown> {
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  return String(err).slice(0, 300);
}

function emptyTables(): PgVerifyTables {
  const expected = EXPECTED_TABLES.map(refOf);
  return { expected, found: [], missing: [...expected] };
}

/**
 * Connection parameters from the environment. Every variable has a default
 * matching the migration target; a variable explicitly set to an empty
 * string counts as missing configuration (a silent empty host or user
 * would otherwise produce a confusing downstream error).
 */
export function resolvePgConfig(
  env: NodeJS.ProcessEnv = process.env,
): { config: PgVerifyConfig } | { error: string } {
  const pick = (key: string, fallback: string): string | null => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const value = raw.trim();
    return value.length > 0 ? value : null;
  };
  const host = pick("PG_HOST", "database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com");
  const database = pick("PG_DATABASE", "data_pipeline");
  const user = pick("PG_USER", "data_pipeline_app");
  const region = pick("PG_REGION", "ap-southeast-1");
  const portRaw = pick("PG_PORT", "5432");
  if (host === null || database === null || user === null || region === null || portRaw === null) {
    return {
      error:
        "missing PG configuration: PG_HOST, PG_PORT, PG_DATABASE, PG_USER and PG_REGION must all be non-empty",
    };
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: "invalid PG_PORT: expected an integer between 1 and 65535" };
  }
  return { config: { host, port, database, user, region } };
}

/**
 * The check sequence, run on one client: version, current user, the
 * 16-table inventory, then the transactional write probe. Never throws
 * for a check failure — failures are reported in the result so the
 * endpoint can return a diagnostic envelope instead of a 500.
 */
export async function runPgChecks(client: PgProbeClient): Promise<{
  pg_version: string | null;
  current_user: string | null;
  tables: PgVerifyTables;
  write_probe: boolean;
  reason?: string;
}> {
  try {
    const versionRows = await client.query("SELECT version()");
    const pg_version = asString(asRecord(versionRows.rows[0]).version);
    const userRows = await client.query("SELECT current_user");
    const current_user = asString(asRecord(userRows.rows[0]).current_user);

    const tableRows = await client.query(
      "SELECT table_schema, table_name FROM information_schema.tables " +
        "WHERE table_schema IN ('app', 'cleaner', 'news_detail') AND table_type = 'BASE TABLE'",
    );
    const present = new Set(
      tableRows.rows.map((row) => {
        const r = asRecord(row);
        return `${String(r.table_schema)}.${String(r.table_name)}`;
      }),
    );
    const expected = EXPECTED_TABLES.map(refOf);
    const found = expected.filter((t) => present.has(t));
    const missing = expected.filter((t) => !present.has(t));

    // Write probe: temp table inside an explicit transaction, always
    // rolled back — zero persistent writes, even if a step fails.
    let write_probe = false;
    try {
      await client.query("BEGIN");
      try {
        await client.query("CREATE TEMP TABLE pg_verify_probe (id INTEGER PRIMARY KEY, note TEXT)");
        await client.query("INSERT INTO pg_verify_probe (id, note) VALUES (1, 'probe')");
        const probeRows = await client.query("SELECT note FROM pg_verify_probe WHERE id = 1");
        write_probe =
          probeRows.rows.length === 1 && asRecord(probeRows.rows[0]).note === "probe";
      } finally {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Already failed or already rolled back: nothing left to undo.
        }
      }
    } catch {
      write_probe = false;
    }

    return { pg_version, current_user, tables: { expected, found, missing }, write_probe };
  } catch (err) {
    return {
      pg_version: null,
      current_user: null,
      tables: emptyTables(),
      write_probe: false,
      reason: messageOf(err),
    };
  }
}

/** Default live connection: one pooled client, IAM token per new connection. */
async function defaultConnect(config: PgVerifyConfig): Promise<{
  client: PgProbeClient;
  close: () => Promise<void>;
}> {
  const signer = new Signer({
    hostname: config.host,
    port: config.port,
    username: config.user,
    region: config.region,
  });
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    max: 1,
    // Fresh IAM token for every new connection (see module docstring).
    password: () => signer.getAuthToken(),
    // Encryption required (sslmode=require equivalent). Chain
    // verification is off on purpose: the RDS CA bundle is not shipped
    // with this service, so verify-full would fail closed on a missing
    // bundle rather than on a real problem. Tightening to verify-full
    // with the RDS CA is a follow-up, not a probe blocker.
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  return {
    client: {
      query: (text: string, params?: unknown[]) =>
        client.query(text, params as never[]).then((r) => ({ rows: r.rows as unknown[] })),
    },
    close: async () => {
      client.release();
      await pool.end();
    },
  };
}

/**
 * Full verification: resolve config, connect, run the checks, report.
 * Never throws: every failure path returns ok:false with a reason, so
 * the HTTP handler can always answer with a diagnostic envelope.
 */
export async function verifyPg(opts?: {
  env?: NodeJS.ProcessEnv;
  connect?: (
    config: PgVerifyConfig,
  ) => Promise<{ client: PgProbeClient; close: () => Promise<void> }>;
}): Promise<PgVerifyResult> {
  const started = Date.now();
  const checked_at = new Date().toISOString();
  const finish = (partial: Omit<PgVerifyResult, "latency_ms" | "checked_at">): PgVerifyResult => ({
    ...partial,
    latency_ms: Date.now() - started,
    checked_at,
  });

  const resolved = resolvePgConfig(opts?.env);
  if ("error" in resolved) {
    return finish({
      ok: false,
      pg_version: null,
      current_user: null,
      tables: emptyTables(),
      write_probe: false,
      reason: resolved.error,
    });
  }
  const config = resolved.config;
  const connect = opts?.connect ?? defaultConnect;
  let conn: { client: PgProbeClient; close: () => Promise<void> };
  try {
    conn = await connect(config);
  } catch (err) {
    return finish({
      ok: false,
      pg_version: null,
      current_user: null,
      tables: emptyTables(),
      write_probe: false,
      reason: `pg connection failed: ${messageOf(err)}`,
    });
  }
  try {
    const checks = await runPgChecks(conn.client);
    const ok =
      checks.pg_version !== null &&
      checks.current_user !== null &&
      checks.tables.missing.length === 0 &&
      checks.write_probe &&
      checks.reason === undefined;
    return finish({
      ok,
      pg_version: checks.pg_version,
      current_user: checks.current_user,
      tables: checks.tables,
      write_probe: checks.write_probe,
      ...(checks.reason ? { reason: checks.reason } : {}),
    });
  } finally {
    try {
      await conn.close();
    } catch {
      // Closing a dead pool must not mask the check result.
    }
  }
}
