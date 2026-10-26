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
 * Bree ticks this file every minute; the file itself decides whether to
 * fire. Two cadence modes, per active webhook row (plan A, 2026-10-25):
 *   - cron set: the row's 5-field cron expression, evaluated in
 *     Asia/Shanghai time (see @data-pipeline/shared). A tick fires only
 *     when the current Shanghai minute matches and that minute has not
 *     already fired; a missed minute is skipped, never caught up.
 *   - cron empty: the legacy interval gate (see cursor-state.ts) — the
 *     interval stays adjustable without a runner restart, and a tick
 *     inside the interval exits immediately with only a log line.
 * Either way the endpoint, payload template and cron are re-read from
 * the database on every tick, so a console save takes effect on the
 * next tick with no runner restart.
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
import { cronMinuteKey, isCronDue, parseCron } from "@data-pipeline/shared";
import { loadDefaultEnv } from "../load-env.js";
import { buildRequest, resolveWebhookConfig, templateKind, triggerOnce } from "../trigger.js";
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
import { appendTriggerHistory, snapshotBody } from "../webhook-history.js";

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
let scheduleLabel = `interval=${intervalMinutes}m`;
if (isTest) {
  const id = Number(webhookOverride);
  dbConfig = Number.isInteger(id) && id > 0 ? loadWebhookByIdFromDb(dbPath, id) : null;
  if (!dbConfig) {
    throw new Error(`test webhook "${webhookOverride}" not found in the database`);
  }
} else {
  const active = loadActiveWebhookFromDb(dbPath);
  if (!active) {
    console.log("[job-runner] cursor-trigger: skip (no active webhook in the webhooks table)");
  } else if (active.cron?.trim()) {
    scheduleLabel = `cron="${active.cron.trim()}"`;
    const parsed = parseCron(active.cron.trim());
    if (!parsed) {
      // An invalid cron can only reach the database by a manual edit —
      // the API rejects it on save. Skip loudly instead of firing on a
      // schedule nobody meant, and never crash the runner over it.
      console.log(
        `[job-runner] cursor-trigger: skip (invalid cron "${active.cron.trim()}" — fix it in the console)`,
      );
    } else if (!isCronDue(parsed, now, state.lastTriggeredAt)) {
      console.log(
        `[job-runner] cursor-trigger: skip (cron not due, cron="${active.cron.trim()}", now Shanghai ${cronMinuteKey(now)})`,
      );
    } else {
      dbConfig = active;
    }
  } else if (!shouldTrigger(state, intervalMinutes, now)) {
    console.log(
      `[job-runner] cursor-trigger: skip (last ok ${state.lastTriggeredAt}, interval ${intervalMinutes}m)`,
    );
  } else {
    dbConfig = active;
  }
}

if (dbConfig) {
  // History is one row per actual HTTP attempt (success or failure) —
  // never for a skipped tick, and never when config resolution fails
  // before any attempt. A failed history write only warns: it must
  // never fail the trigger itself (appendTriggerHistory never throws).
  const startedAt = Date.now();
  const historyKind = isTest ? "test" : "scheduled";
  let attempted = false;
  let bodyKind = "ping";
  // The exact body that goes out, for the history snapshot. buildRequest
  // is pure for a given config + timestamp, so this is byte-identical
  // to what triggerOnce sends below — and it is available for the
  // failure row too, where triggerOnce throws without returning.
  let sentBody: string | null = null;
  try {
    // The read happens on every trigger attempt, so a console save takes
    // effect on the next tick with no runner restart.
    const config = resolveWebhookConfig(dbConfig);
    const full = {
      ...config,
      prompt: state.prompt ?? undefined,
      activePayload: loadActivePayloadFromDb(dbPath),
    };
    const kind = templateKind(full);
    bodyKind = kind ? `payload(${kind})` : state.prompt ? "prompt" : "ping";
    sentBody = buildRequest(full, now).body;
    attempted = true;
    const result = await triggerOnce(full, now);
    if (!isTest) {
      saveState(statePath, { ...state, lastTriggeredAt: now.toISOString() });
    }
    const snap = snapshotBody(sentBody);
    if (
      !appendTriggerHistory(dbPath, {
        webhook_id: dbConfig.id,
        webhook_name: dbConfig.name,
        kind: historyKind,
        triggered_at: now.toISOString(),
        http_status: result.status,
        ok: true,
        body_kind: bodyKind,
        body: snap.body,
        body_truncated: snap.body_truncated,
        error: null,
        duration_ms: Date.now() - startedAt,
      })
    ) {
      console.log("[job-runner] cursor-trigger: trigger history write failed (trigger itself succeeded)");
    }
    const origin = new URL(config.url).origin;
    console.log(
      `[job-runner] cursor-trigger: triggered ok (HTTP ${result.status}) target=${origin}/… ${scheduleLabel} body=${bodyKind}${isTest ? " test" : ""}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempted) {
      const statusMatch = /HTTP (\d{3})/.exec(message);
      const snap = sentBody === null ? null : snapshotBody(sentBody);
      if (
        !appendTriggerHistory(dbPath, {
          webhook_id: dbConfig.id,
          webhook_name: dbConfig.name,
          kind: historyKind,
          triggered_at: now.toISOString(),
          http_status: statusMatch ? Number(statusMatch[1]) : null,
          ok: false,
          body_kind: bodyKind,
          body: snap?.body ?? null,
          body_truncated: snap?.body_truncated ?? false,
          error: message.slice(0, 500),
          duration_ms: Date.now() - startedAt,
        })
      ) {
        console.log("[job-runner] cursor-trigger: trigger history write failed (trigger itself failed)");
      }
    }
    console.error(`[job-runner] cursor-trigger: trigger failed: ${message}`);
    throw err;
  }
}
