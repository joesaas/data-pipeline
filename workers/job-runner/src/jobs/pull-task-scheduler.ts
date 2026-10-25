/**
 * pull-task-scheduler job — ticks every minute, inserts pending rows
 * for pull tasks whose latest cron occurrence has no row yet. It never
 * executes prompts and never sends anything: execution belongs to the
 * target agent, which claims rows from the queue (see
 * ../pull-task-scheduler.ts for the rules).
 *
 * Must exit on its own when done: no timers, no servers. A hung run is
 * killed by Bree's closeWorkerAfterMs and retried on the next tick.
 * A missing database/table/column (pre-migration) skips the tick with
 * a log line instead of throwing, so the runner survives an API that
 * has not migrated yet.
 */
import { loadDefaultEnv } from "../load-env.js";
import { apiDbPath } from "../webhook-config.js";
import {
  insertPendingTask,
  loadActivePullTasks,
  loadExistingDueKeys,
  tasksToSchedule,
} from "../pull-task-scheduler.js";

const envFile = loadDefaultEnv();
const dbPath = apiDbPath(envFile);
const now = new Date();

const tasks = loadActivePullTasks(dbPath);
if (tasks === null) {
  console.log("[pull-task-scheduler] skip: pull_tasks unavailable (missing db/table)");
} else {
  const existing = loadExistingDueKeys(dbPath);
  if (existing === null) {
    console.log("[pull-task-scheduler] skip: pending_tasks unavailable (missing db/table)");
  } else {
    const inserts = tasksToSchedule(tasks, existing, now);
    let inserted = 0;
    for (const insert of inserts) {
      if (insertPendingTask(dbPath, insert)) inserted++;
    }
    console.log(
      `[pull-task-scheduler] tick: ${tasks.length} active task(s), ${inserts.length} due, ${inserted} pending row(s) inserted`,
    );
  }
}
