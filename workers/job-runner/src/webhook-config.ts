import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  url: string;
  token: string;
  payload: string | null;
  /** Per-webhook cron expression, or null when the row has none (legacy interval gate). */
  cron: string | null;
}

function readWebhookRow(
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
        `SELECT url, token, payload${hasCron ? ", cron" : ""} FROM webhooks ${where}`,
      )
      .get(...params) as
      | { url: string; token: string; payload: string | null; cron?: string | null }
      | undefined;
    if (!row || !row.url || !row.token) return null;
    return { url: row.url, token: row.token, payload: row.payload ?? null, cron: row.cron ?? null };
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

/** The row marked scheduled (is_active), newest-updated first, or null. */
export function loadActiveWebhookFromDb(dbPath: string): DbWebhook | null {
  return readWebhookRow(dbPath, "WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1", []);
}

/** One row by id (used for test-firing a specific webhook), or null. */
export function loadWebhookByIdFromDb(dbPath: string, id: number): DbWebhook | null {
  return readWebhookRow(dbPath, "WHERE id = ?", [id]);
}

/**
 * Content of the active payload-list item, or null when there is none
 * (no table yet, no active row, or any read failure — the caller falls
 * back to the single template / prompt / ping). The payloads table is
 * still read here even though the console no longer manages it: a row
 * left active keeps shaping the body until it is cleared in the database.
 */
export function loadActivePayloadFromDb(dbPath: string): string | null {
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
