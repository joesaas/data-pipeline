import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Trigger-history writer for the cursor-trigger job. It writes directly
 * to the API's SQLite database — the same pattern as the pull-task
 * scheduler's pending-row writes and the webhook-config reads: the job
 * cannot go through the API's storage driver (a separate process with
 * its own driver abstraction), and the API creates the same table on
 * its own startup, so this module re-creates it here too in case the
 * runner ticks before the API restarts after a deploy.
 *
 * Best-effort by contract: appendTriggerHistory never throws. A history
 * write must never fail a trigger — the caller logs a warning and
 * carries on with the trigger result. No secrets are ever written here:
 * the row carries the webhook name snapshot, not the URL or the token.
 */

export interface TriggerHistoryRow {
  webhook_id: number;
  webhook_name: string;
  kind: "scheduled" | "test";
  triggered_at: string;
  http_status: number | null;
  ok: boolean;
  body_kind: string;
  /** Exact request body sent (already truncated by snapshotBody, if needed). */
  body: string | null;
  body_truncated: boolean;
  error: string | null;
  duration_ms: number | null;
}

/** Keep only the latest 1000 rows overall, matching the API drivers. */
export const TRIGGER_HISTORY_LIMIT = 1000;

/**
 * Stored body cap: templates may be up to 200000 chars, and 1000 rows
 * of those would bloat the database — 8000 chars covers real prompts
 * while bounding the table to ~8MB. Longer bodies are cut, flagged.
 */
export const TRIGGER_BODY_LIMIT = 8000;

/** Cut a sent body to the stored cap, reporting whether it was cut. */
export function snapshotBody(body: string): { body: string; body_truncated: boolean } {
  if (body.length <= TRIGGER_BODY_LIMIT) return { body, body_truncated: false };
  return { body: body.slice(0, TRIGGER_BODY_LIMIT), body_truncated: true };
}

const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS webhook_trigger_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  webhook_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  http_status INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  body_kind TEXT NOT NULL,
  body TEXT,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trigger_history_webhook_time
  ON webhook_trigger_history(webhook_id, triggered_at DESC, id DESC);`;

/**
 * Append one history row. Returns true on success, false on any failure
 * (missing file, locked database, missing table that could not be
 * created) — never throws.
 */
export function appendTriggerHistory(dbPath: string, row: TriggerHistoryRow): boolean {
  if (!existsSync(dbPath)) return false;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(HISTORY_DDL);
    // Migration for tables created before body snapshots: CREATE TABLE
    // IF NOT EXISTS never adds a column to an old table.
    const cols = db.prepare("PRAGMA table_info(webhook_trigger_history)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "body")) {
      db.exec("ALTER TABLE webhook_trigger_history ADD COLUMN body TEXT");
    }
    if (!cols.some((c) => c.name === "body_truncated")) {
      db.exec("ALTER TABLE webhook_trigger_history ADD COLUMN body_truncated INTEGER NOT NULL DEFAULT 0");
    }
    db.prepare(
      `INSERT INTO webhook_trigger_history
       (webhook_id, webhook_name, kind, triggered_at, http_status, ok, body_kind, body, body_truncated, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.webhook_id,
      row.webhook_name,
      row.kind,
      row.triggered_at,
      row.http_status,
      row.ok ? 1 : 0,
      row.body_kind,
      row.body,
      row.body_truncated ? 1 : 0,
      row.error,
      row.duration_ms,
    );
    db.prepare(
      `DELETE FROM webhook_trigger_history WHERE id NOT IN
       (SELECT id FROM webhook_trigger_history ORDER BY id DESC LIMIT ?)`,
    ).run(TRIGGER_HISTORY_LIMIT);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed; nothing to do.
    }
  }
}
