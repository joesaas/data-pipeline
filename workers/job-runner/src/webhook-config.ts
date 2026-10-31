import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PgPoolLike } from "./pg-pool.js";
import { getJobRunnerPgPool, resolveJobRunnerStorageDriver } from "./storage.js";

/**
 * Where the API's SQLite file lives, from the job's point of view.
 * Mirrors the API's own resolution (config.ts: DATA_DIR ?? "./data",
 * database file "data.db" inside it): an absolute DATA_DIR is used as-is;
 * a relative one resolves against the repo root (the directory of the
 * loaded .env) when one was found, else against the process cwd — which
 * is the repo root in production (pm2 starts from there).
 */
export function apiDbPath(envFile: string | null): string {
  const raw = process.env.DATA_DIR ?? "./data";
  const dir = isAbsolute(raw) ? raw : envFile ? join(dirname(envFile), raw) : resolve(raw);
  return join(dir, "data.db");
}

/**
 * Read the trigger webhook endpoint from the API's database (webhooks
 * table, console-managed) — the only source. Read-only open with a busy
 * timeout: the API runs WAL mode, so readers proceed alongside writers,
 * and a contended read waits briefly instead of failing outright.
 *
 * There is no environment fallback: when no row is marked active, the
 * scheduled trigger skips the tick (see the job file) instead of sending
 * anywhere.
 *
 * Returns null on ANY failure — missing file, missing table or column,
 * locked, unreadable.
 */
export interface DbWebhook {
  /** Row id and name: recorded in trigger history (name as a snapshot). */
  id: number;
  name: string;
  url: string;
  token: string;
  payload: string | null;
  /** Per-webhook cron expression, or null when the row has none (legacy interval gate). */
  cron: string | null;
}

/** SQLite implementation of readWebhookRow (original body). */
function readWebhookRowSqlite(
  dbPath: string,
  where: string,
  params: (string | number)[],
): DbWebhook | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    // Old databases predate the cron column (the API migrates on its own
    // startup, but the runner must not break if it ticks first): select
    // cron only when the column exists, else read the row without it.
    const cols = db.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[];
    const hasCron = cols.some((c) => c.name === "cron");
    const row = db
      .prepare(
        `SELECT id, name, url, token, payload${hasCron ? ", cron" : ""} FROM webhooks ${where}`,
      )
      .get(...params) as
      | { id: number; name: string; url: string; token: string; payload: string | null; cron?: string | null }
      | undefined;
    if (!row || !row.url || !row.token) return null;
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      token: row.token,
      payload: row.payload ?? null,
      cron: row.cron ?? null,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed; nothing to do.
    }
  }
}

/**
 * Which backend the public functions below use. Unknown switch values
 * yield null (no database) rather than a guessed backend — the job
 * files and main.ts fail fast on unknown values at startup, so this
 * is only a backstop for direct library callers.
 */
function currentDriver(): "sqlite" | "pg" | null {
  try {
    return resolveJobRunnerStorageDriver();
  } catch {
    return null;
  }
}

/** Map one PG webhooks row. The url/token are returned to the caller
 * (as before) but never logged here — same secrets rule as the
 * SQLite path. PG always has the cron column, so no hasCron check. */
function mapWebhookRow(row: Record<string, unknown> | undefined): DbWebhook | null {
  if (!row) return null;
  const url = row.url;
  const token = row.token;
  if (typeof url !== "string" || !url || typeof token !== "string" || !token) return null;
  return {
    id: Number(row.id),
    name: String(row.name),
    url,
    token,
    payload: row.payload == null ? null : String(row.payload),
    cron: row.cron == null ? null : String(row.cron),
  };
}

/** PG implementation of a single webhooks-row read over schema app.*. */
async function readWebhookRowPg(
  pool: PgPoolLike,
  where: string,
  params: (string | number)[],
): Promise<DbWebhook | null> {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, url, token, payload, cron FROM app.webhooks ${where}`,
      params,
    );
    return mapWebhookRow(rows[0]);
  } catch {
    return null;
  }
}

/** The row marked scheduled (is_active), newest-updated first, or null. */
export async function loadActiveWebhookFromDb(dbPath: string): Promise<DbWebhook | null> {
  const mode = currentDriver();
  if (mode === "pg") {
    try {
      return await readWebhookRowPg(getJobRunnerPgPool(), "WHERE is_active ORDER BY updated_at DESC LIMIT 1", []);
    } catch {
      return null;
    }
  }
  if (mode === "sqlite") return readWebhookRowSqlite(dbPath, "WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1", []);
  return null;
}

/** One row by id (used for test-firing a specific webhook), or null. */
export async function loadWebhookByIdFromDb(dbPath: string, id: number): Promise<DbWebhook | null> {
  const mode = currentDriver();
  if (mode === "pg") {
    try {
      return await readWebhookRowPg(getJobRunnerPgPool(), "WHERE id = $1", [id]);
    } catch {
      return null;
    }
  }
  if (mode === "sqlite") return readWebhookRowSqlite(dbPath, "WHERE id = ?", [id]);
  return null;
}

/** PG implementations of the two public readers above, exported for
 * stub-pool tests (same mapping, no live database). */
export async function loadActiveWebhookFromDbPg(pool: PgPoolLike): Promise<DbWebhook | null> {
  return readWebhookRowPg(pool, "WHERE is_active ORDER BY updated_at DESC LIMIT 1", []);
}

export async function loadWebhookByIdFromDbPg(pool: PgPoolLike, id: number): Promise<DbWebhook | null> {
  return readWebhookRowPg(pool, "WHERE id = $1", [id]);
}

/**
 * Content of the active payload-list item, or null when there is none
 * (no table yet, no active row, or any read failure — the caller falls
 * back to the single template / prompt / ping). The payloads table is
 * still read here even though the console no longer manages it: a row
 * left active keeps shaping the body until it is cleared in the database.
 */
export async function loadActivePayloadFromDb(dbPath: string): Promise<string | null> {
  const mode = currentDriver();
  if (mode === "pg") {
    try {
      return await loadActivePayloadFromDbPg(getJobRunnerPgPool());
    } catch {
      return null;
    }
  }
  if (mode === "sqlite") return loadActivePayloadFromDbSqlite(dbPath);
  return null;
}

/** PG implementation of loadActivePayloadFromDb over schema app.*,
 * exported for stub-pool tests. Same blank-content rule as SQLite:
 * whitespace-only content counts as no active payload. */
export async function loadActivePayloadFromDbPg(pool: PgPoolLike): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      "SELECT content FROM app.webhook_payloads WHERE is_active ORDER BY updated_at DESC, id ASC LIMIT 1",
    );
    const content = rows[0]?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** SQLite implementation of loadActivePayloadFromDb (original body). */
function loadActivePayloadFromDbSqlite(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db
      .prepare(
        "SELECT content FROM webhook_payloads WHERE is_active = 1 ORDER BY updated_at DESC, id ASC LIMIT 1",
      )
      .get() as { content: string } | undefined;
    return row?.content?.trim() ? row.content : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed; nothing to do.
    }
  }
}
