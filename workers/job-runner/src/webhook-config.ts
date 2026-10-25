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
 * Returns null on ANY failure — missing file, missing table (a database
 * from before the table existed), locked, unreadable — so the caller
 * falls back to the environment instead of failing the trigger.
 */
export function loadWebhookConfigFromDb(dbPath: string): { url: string; token: string; payload: string | null } | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db
      .prepare("SELECT url, token, payload FROM webhook_configs WHERE name = ?")
      .get("cursor-trigger") as { url: string; token: string; payload: string | null } | undefined;
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
