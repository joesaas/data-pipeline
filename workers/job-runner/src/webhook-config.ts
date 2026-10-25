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
 * Read the cursor-trigger webhook endpoint from the API's database
 * (webhook_configs table, console-managed). Read-only open with a busy
 * timeout: the API runs WAL mode, so readers proceed alongside writers,
 * and a contended read waits briefly instead of failing outright.
 *
 * Resolution order for the scheduled trigger: the row marked active
 * (newest-updated wins if several are marked — the API keeps at most one
 * active, this is belt and braces), then the legacy cursor-trigger row
 * (databases from before the webhook list existed, where the migration
 * has not marked it yet), then null — the caller falls back to the
 * environment instead of failing the trigger.
 *
 * Returns null on ANY failure — missing file, missing table or column (a
 * database from before the table/column existed), locked, unreadable.
 */
export function loadWebhookConfigFromDb(dbPath: string): { url: string; token: string; payload: string | null } | null {
  return loadActiveWebhookFromDb(dbPath) ?? loadWebhookConfigByName(dbPath, "cursor-trigger");
}

/** The row marked scheduled (is_active), newest-updated first, or null. */
export function loadActiveWebhookFromDb(dbPath: string): { url: string; token: string; payload: string | null } | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db
      .prepare("SELECT url, token, payload FROM webhook_configs WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1")
      .get() as { url: string; token: string; payload: string | null } | undefined;
    if (!row || !row.url || !row.token) return null;
    return { url: row.url, token: row.token, payload: row.payload ?? null };
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

/** One row by name (used for test-firing a specific webhook), or null. */
export function loadWebhookConfigByName(dbPath: string, name: string): { url: string; token: string; payload: string | null } | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db
      .prepare("SELECT url, token, payload FROM webhook_configs WHERE name = ?")
      .get(name) as { url: string; token: string; payload: string | null } | undefined;
    if (!row || !row.url || !row.token) return null;
    return { url: row.url, token: row.token, payload: row.payload ?? null };
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
 * Content of the active payload-list item, or null when there is none
 * (no table yet, no active row, or any read failure — the caller falls
 * back to the single template / prompt / ping).
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
