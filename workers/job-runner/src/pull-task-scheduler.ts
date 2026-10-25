import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseCron, previousCronOccurrence } from "@data-pipeline/shared";
import { apiDbPath } from "./webhook-config.js";

/**
 * Pull-task scheduler (2026-10-25, queue redesign). The runner ticks
 * every minute; this module decides which active pull tasks need a new
 * pending row and writes it. It never executes a prompt — execution
 * belongs to the target agent, which claims rows from the queue.
 *
 * Scheduling rule: a task is due for its most recent cron occurrence
 * (Asia/Shanghai, via shared previousCronOccurrence). A row is
 * inserted only when no row exists for (pull_task_id, due_at) in ANY
 * status — rows are never deleted, they only change status, so this
 * check alone prevents duplicates. A task that came due between ticks
 * is queued late, never skipped; a missed occurrence older than the
 * 7-day shared lookback simply waits for its next occurrence.
 *
 * DB access mirrors webhook-config.ts: read-write open with a busy
 * timeout (the API runs WAL mode), and ANY failure (missing file,
 * missing table/column, locked) returns null / skips the tick instead
 * of throwing — the API migrates old databases on its own startup,
 * and the runner must not break if it ticks first.
 */

export interface DbPullTask {
  id: number;
  name: string;
  prompt: string;
  cron: string;
  target: string;
  is_active: boolean;
}

export interface PendingInsert {
  pull_task_id: number;
  pull_task_name: string;
  target: string;
  prompt: string;
  due_at: string;
}

/** Pure decision: which tasks need a new pending row right now. */
export function tasksToSchedule(
  tasks: DbPullTask[],
  existingDueKeys: Set<string>,
  now: Date,
): PendingInsert[] {
  const inserts: PendingInsert[] = [];
  for (const task of tasks) {
    if (!task.is_active) continue;
    const parsed = parseCron(task.cron);
    if (!parsed) continue;
    const prev = previousCronOccurrence(parsed, now);
    if (!prev) continue;
    const dueAt = prev.toISOString();
    if (existingDueKeys.has(`${task.id}|${dueAt}`)) continue;
    inserts.push({
      pull_task_id: task.id,
      pull_task_name: task.name,
      target: task.target,
      prompt: task.prompt,
      due_at: dueAt,
    });
  }
  return inserts;
}

function openDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch {
    return null;
  }
}

/** Active pull tasks from the API database, or null on any failure. */
export function loadActivePullTasks(dbPath: string): DbPullTask[] | null {
  const db = openDb(dbPath);
  if (!db) return null;
  try {
    const cols = db.prepare("PRAGMA table_info(pull_tasks)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "id")) return null;
    const hasTarget = cols.some((c) => c.name === "target");
    const rows = db
      .prepare(
        `SELECT id, name, prompt, cron${hasTarget ? ", target" : ""}, is_active FROM pull_tasks WHERE is_active = 1`,
      )
      .all() as (Omit<DbPullTask, "target" | "is_active"> & { target?: string; is_active: number })[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      cron: r.cron,
      target: r.target ?? "muse",
      is_active: r.is_active === 1,
    }));
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
}

/** Existing (pull_task_id, due_at) keys, or null on any failure. */
export function loadExistingDueKeys(dbPath: string): Set<string> | null {
  const db = openDb(dbPath);
  if (!db) return null;
  try {
    const cols = db.prepare("PRAGMA table_info(pending_tasks)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "id")) return null;
    const rows = db
      .prepare("SELECT pull_task_id, due_at FROM pending_tasks")
      .all() as { pull_task_id: number; due_at: string }[];
    return new Set(rows.map((r) => `${r.pull_task_id}|${r.due_at}`));
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
}

/** Insert one pending row. Returns false when the row already exists (UNIQUE) or on any failure. */
export function insertPendingTask(dbPath: string, insert: PendingInsert): boolean {
  const db = openDb(dbPath);
  if (!db) return false;
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO pending_tasks (pull_task_id, pull_task_name, target, prompt, due_at, kind, status, result_external_id, result_record_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 'waiting', NULL, NULL, NULL, ?, ?)`,
    ).run(insert.pull_task_id, insert.pull_task_name, insert.target, insert.prompt, insert.due_at, now, now);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
}

export { apiDbPath };
