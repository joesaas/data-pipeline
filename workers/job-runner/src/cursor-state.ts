import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * cursor-trigger job state: the file that makes its cadence adjustable
 * without a runner restart.
 *
 * Bree's registry interval is fixed at startup, so this job ticks every
 * minute and gates on its own state instead:
 *   - lastTriggeredAt: ISO timestamp of the last SUCCESSFUL trigger.
 *     A failed tick leaves it untouched, so failures retry every minute
 *     until one succeeds; successes pace out to the full interval.
 *   - intervalMinutes: console override. null means "use the environment"
 *     (CURSOR_TRIGGER_INTERVAL_MINUTES, default 60). The console writes
 *     only this field; it never touches webhook secrets.
 *   - prompt: console-set instruction text, or null for "no prompt".
 *     When set, the webhook body carries it as the `prompt` field, so the
 *     receiving automation knows what to run; when null, the body stays
 *     the old ping shape ({source, triggered_at}) and the receiver
 *     decides on its own. The prompt is not a secret — the console shows
 *     and edits it — but it is never logged (it can be long).
 *
 * A missing or corrupt file behaves like "never triggered": the next tick
 * fires immediately. That direction is safe — at most one extra trigger —
 * and it matches the old service's start-immediate behaviour.
 */
export interface CursorTriggerState {
  lastTriggeredAt: string | null;
  intervalMinutes: number | null;
  prompt: string | null;
}

export function defaultState(): CursorTriggerState {
  return { lastTriggeredAt: null, intervalMinutes: null, prompt: null };
}

export function loadState(path: string): CursorTriggerState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CursorTriggerState>;
    return {
      lastTriggeredAt: typeof parsed.lastTriggeredAt === "string" ? parsed.lastTriggeredAt : null,
      intervalMinutes:
        typeof parsed.intervalMinutes === "number" && parsed.intervalMinutes >= 1
          ? Math.floor(parsed.intervalMinutes)
          : null,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : null,
    };
  } catch {
    return defaultState();
  }
}

export function saveState(path: string, state: CursorTriggerState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Console override wins; else the environment; else 60. Clamped to >= 1. */
export function resolveIntervalMinutes(state: CursorTriggerState, env: NodeJS.ProcessEnv): number {
  if (state.intervalMinutes !== null) return Math.max(1, state.intervalMinutes);
  const fromEnv = Number(env.CURSOR_TRIGGER_INTERVAL_MINUTES ?? 60) || 60;
  return Math.max(1, fromEnv);
}

/** True when never triggered, when the stored timestamp is unusable, or when the interval has elapsed. */
export function shouldTrigger(state: CursorTriggerState, intervalMinutes: number, now: Date): boolean {
  if (!state.lastTriggeredAt) return true;
  const last = Date.parse(state.lastTriggeredAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMinutes * 60_000;
}

/**
 * Where the state file lives. Next to the repo-root .env when one was
 * loaded (production: <root>/workers/job-runner/data/...); otherwise
 * package-relative from the job module (dist/src/jobs -> ../../..).
 * The directory is git-ignored (data/): runtime state, never committed.
 */
export function stateFilePath(envFile: string | null, moduleDir: string): string {
  if (envFile) return join(dirname(envFile), "workers/job-runner/data/cursor-trigger-state.json");
  return join(moduleDir, "..", "..", "..", "data", "cursor-trigger-state.json");
}

export function stateFileExists(path: string): boolean {
  return existsSync(path);
}
