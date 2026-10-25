/**
 * cursor-trigger job — migrated from the standalone data-cursor-trigger
 * service (same webhook request shape, same prompt/state rules). The
 * endpoint itself now comes from the API database first (console-managed
 * webhook_configs table), with the environment as fallback.
 *
 * Bree ticks this file every minute; the file itself decides whether the
 * configured interval has elapsed (see cursor-state.ts), so the cadence
 * stays adjustable without a runner restart. A tick inside the interval
 * exits immediately with only a log line.
 *
 * Must exit on its own when done: no timers, no servers. A hung run is
 * killed by Bree's closeWorkerAfterMs and retried on the next tick.
 * A throwing run is reported by the runner's errorHandler and retried too.
 * Note: config.intervalMinutes from resolveConfig is unused here — the
 * cadence comes from the state/env gating above, not the old service's
 * setTimeout chain. triggerOnce itself only needs url + token.
 *
 * Secrets are never logged: resolveConfig and triggerOnce messages name
 * variables and problem classes only, and only the webhook origin (never
 * the full URL or token) appears in logs.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefaultEnv } from "../load-env.js";
import { resolveWebhookConfig, triggerOnce } from "../trigger.js";
import {
  loadState,
  resolveIntervalMinutes,
  saveState,
  shouldTrigger,
  stateFilePath,
} from "../cursor-state.js";
import { apiDbPath, loadWebhookConfigFromDb } from "../webhook-config.js";

const envFile = loadDefaultEnv();
const statePath = stateFilePath(envFile, dirname(fileURLToPath(import.meta.url)));

const now = new Date();
const state = loadState(statePath);
const intervalMinutes = resolveIntervalMinutes(state, process.env);

if (!shouldTrigger(state, intervalMinutes, now)) {
  console.log(
    `[job-runner] cursor-trigger: skip (last ok ${state.lastTriggeredAt}, interval ${intervalMinutes}m)`,
  );
} else {
  try {
    // Database config (console-managed) wins; .env is only the fallback.
    // The read happens on every trigger attempt, so a console save takes
    // effect on the next tick with no runner restart.
    const dbConfig = loadWebhookConfigFromDb(apiDbPath(envFile));
    const config = resolveWebhookConfig(process.env, dbConfig);
    const result = await triggerOnce(
      { ...config, prompt: state.prompt ?? undefined },
      now,
    );
    saveState(statePath, { ...state, lastTriggeredAt: now.toISOString() });
    const origin = new URL(config.url).origin;
    const bodyKind = config.payload ? "payload" : state.prompt ? "prompt" : "ping";
    console.log(
      `[job-runner] cursor-trigger: triggered ok (HTTP ${result.status}) target=${origin}/… interval=${intervalMinutes}m body=${bodyKind} cfg=${dbConfig ? "db" : "env"}`,
    );
  } catch (err) {
    console.error(
      `[job-runner] cursor-trigger: trigger failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
