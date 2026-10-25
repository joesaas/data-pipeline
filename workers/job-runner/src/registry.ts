/**
 * The job registry: the single list of jobs the runner hosts.
 *
 * Adding a job = two steps, nothing else:
 *   1. Add a script file `src/jobs/<name>.ts` (it runs in its own worker
 *      thread, once per tick; it must exit on its own when done).
 *   2. Add one entry below.
 *
 * A job is deliberately NOT discovered by scanning the directory: an
 * explicit list means a stray file can never start running in production.
 *
 * The `interval` is the tick. A job may tick more often than it acts —
 * cursor-trigger ticks every minute and gates on its own state file —
 * and must say so in its description.
 *
 * Durations use a small human syntax, restricted here to
 * `<number><ms|s|m|h|d>` (e.g. "30m", "1h"). `maxRunMs` is the hung-job
 * killer: Bree terminates a run that exceeds it (closeWorkerAfterMs),
 * and the next tick retries the job. That is the automatic recovery for
 * a stuck job; for a throwing job, recovery is the next tick itself
 * (the scheduler survives because the job ran in its own worker thread).
 *
 * NOTE on Bree vocabulary, easy to get wrong: Bree's `timeout` is a
 * delay before the FIRST run, not a kill switch. Do not use it here.
 */
export interface JobDef {
  /** File stem under src/jobs/ (kebab-case, e.g. "runner-heartbeat"). */
  name: string;
  /** How often the job runs. */
  interval: string;
  /** Kill a single run that exceeds this; the next tick retries. */
  maxRunMs: string;
  /** One line, for the startup log and README. */
  description: string;
}

export const JOBS: JobDef[] = [
  {
    name: "runner-heartbeat",
    interval: "30m",
    maxRunMs: "1m",
    description: "Proves the runner is alive: one log line per tick, no side effects.",
  },
  {
    name: "cursor-trigger",
    interval: "1m",
    maxRunMs: "1m",
    description:
      "POSTs the automation webhook when its schedule is due. Ticks every minute and self-gates: the active webhooks row's cron (Asia/Shanghai time) when set, else cursor-state interval (state file, else CURSOR_TRIGGER_INTERVAL_MINUTES, default 60m); the 1m here is the tick, not the trigger cadence. The endpoint is the active row of the webhooks table — no active row means the tick skips.",
  },
];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "30m"/"1h"/"500ms" to milliseconds; null when malformed or zero. */
export function parseDurationMs(value: string): number | null {
  const m = DURATION_RE.exec(value);
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  return ms > 0 ? ms : null;
}

/** Validate the registry. Returns error strings; empty means valid. */
export function validateJobs(jobs: JobDef[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!NAME_RE.test(job.name)) {
      errors.push(`job "${job.name}": name must be kebab-case`);
    }
    if (seen.has(job.name)) {
      errors.push(`job "${job.name}": duplicate name`);
    }
    seen.add(job.name);
    for (const [field, value] of [
      ["interval", job.interval],
      ["maxRunMs", job.maxRunMs],
    ] as const) {
      if (parseDurationMs(value) === null) {
        errors.push(`job "${job.name}": ${field} "${value}" must be like "30m", "1h", "500ms"`);
      }
    }
  }
  return errors;
}
