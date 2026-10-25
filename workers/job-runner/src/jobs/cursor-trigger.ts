/**
 * cursor-trigger job — migrated from the standalone data-cursor-trigger
 * service (same webhook request shape, same prompt/state rules). The
 * endpoint comes only from the API database (webhooks table, the row
 * marked active). There is no environment fallback: when no row is
 * active, the scheduled tick skips with a log line instead of sending
 * anywhere. CURSOR_TRIGGER_WEBHOOK_OVERRIDE names one webhook id to
 * test-fire once instead, bypassing the interval gate and the state
 * write so a test never disturbs the schedule.
 *
 * Bree ticks this file every minute; the file itself decides whether the
 * configured interval has elapsed (see cursor-state.ts), so the cadence
 * stays adjustable without a runner restart. A tick inside the interval
 * exits immediately with only a log line.
 *
 * Must exit on its own when done: no timers, no servers. A hung run is
 * killed by Bree's closeWorkerAfterMs and retried on the next tick.
 * A throwing run is reported by the runner's errorHandler and retried too.
 * Note: the cadence comes from the state/env gating above, not a
 * setTimeout chain. triggerOnce itself only needs url + token.
 *
 * Secrets are never logged: resolveWebhookConfig and triggerOnce messages
 * name variables and problem classes only, and only the webhook origin
 * (never the full URL or token) appears in logs.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefaultEnv } from "../load-env.js";
import { resolveWebhookConfig, templateKind, triggerOnce } from "../trigger.js";
import {
  loadState,
  resolveIntervalMinutes,
  saveState,
  shouldTrigger,
  stateFilePath,
} from "../cursor-state.js";
import {
  apiDbPath,
  loadActivePayloadFromDb,
  loadActiveWebhookFromDb,
  loadWebhookByIdFromDb,
  type DbWebhook,
} from "../webhook-config.js";

const envFile = loadDefaultEnv();
const statePath = stateFilePath(envFile, dirname(fileURLToPath(import.meta.url)));

const now = new Date();
const state = loadState(statePath);
const intervalMinutes = resolveIntervalMinutes(state, process.env);

// A webhook override means "test-fire this webhook once" (console test
// button): it bypasses the interval gate and never writes the state
// file, so testing neither waits for the cadence nor postpones the next
// scheduled fire. A missing override row is a hard error — a test must
// never silently fall back to the scheduled webhook.
const webhookOverride = process.env.CURSOR_TRIGGER_WEBHOOK_OVERRIDE?.trim() || null;
const isTest = webhookOverride !== null;

const dbPath = apiDbPath(envFile);
let dbConfig: DbWebhook | null = null;
if (isTest) {
  const id = Number(webhookOverride);
  dbConfig = Number.isInteger(id) && id > 0 ? loadWebhookByIdFromDb(dbPath, id) : null;
  if (!dbConfig) {
    throw new Error(`test webhook "${webhookOverride}" not found in the database`);
  }
} else if (!shouldTrigger(state, intervalMinutes, now)) {
  console.log(
    `[job-runner] cursor-trigger: skip (last ok ${state.lastTriggeredAt}, interval ${intervalMinutes}m)`,
  );
} else {
  dbConfig = loadActiveWebhookFromDb(dbPath);
  if (!dbConfig) {
    console.log("[job-runner] cursor-trigger: skip (no active webhook in the webhooks table)");
  }
}

if (dbConfig) {
  try {
    // The read happens on every trigger attempt, so a console save takes
    // effect on the next tick with no runner restart.
    const config = resolveWebhookConfig(dbConfig);
    const full = {
      ...config,
      prompt: state.prompt ?? undefined,
      activePayload: loadActivePayloadFromDb(dbPath),
    };
    const result = await triggerOnce(full, now);
    if (!isTest) {
      saveState(statePath, { ...state, lastTriggeredAt: now.toISOString() });
    }
    const origin = new URL(config.url).origin;
    const kind = templateKind(full);
    const bodyKind = kind ? `payload(${kind})` : state.prompt ? "prompt" : "ping";
    console.log(
      `[job-runner] cursor-trigger: triggered ok (HTTP ${result.status}) target=${origin}/… interval=${intervalMinutes}m body=${bodyKind}${isTest ? " test" : ""}`,
    );
  } catch (err) {
    console.error(
      `[job-runner] cursor-trigger: trigger failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
