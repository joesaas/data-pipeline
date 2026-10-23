import type { RawRecord } from "@data-pipeline/shared";
import type { RecordsClient, RecordCursor } from "./client.js";
import type { LlmProvider } from "./providers.js";
import { checkQuality } from "./quality.js";
import type { LlmRateLimiter } from "./ratelimit.js";
import type { CleanerStore } from "./store.js";
import { PROMPT_VERSION } from "./prompt.js";
import { needsTranslation, TRANSLATE_PROMPT_VERSION } from "./translate.js";

export interface BatchStats {
  fetched: number;
  rejected: number;
  skipped: number;
  cleaned: number;
  failed: number;
  deferred: number;
  items: number;
  translated: number;
}

export interface BatchDeps {
  client: RecordsClient;
  provider: LlmProvider;
  store: CleanerStore;
  systemPrompt: string;
  /** System prompt for the round's single batched translation call. */
  translatePrompt: string;
  limit: number;
  maxPerRun: number;
  /** Budget for real LLM calls; mock provider calls are never charged. */
  rateLimiter?: LlmRateLimiter;
  log?: (line: string) => void;
}

/** After this many consecutive failed rounds, a record is given up as
 *  rejected so one poison record cannot block everything behind it. */
const MAX_ATTEMPTS = 5;

/**
 * One cleaning pass over the records after the stored cursor, ascending.
 *
 * Cursor discipline: the cursor advances only past records that reached a
 * terminal state this round (cleaned, already-cleaned skip, quality reject,
 * or attempts exhausted). A failure or an exhausted LLM budget stops the
 * batch with the cursor left before the pending record — it is retried next
 * round, never silently dropped. Deferred records are not failures.
 */
export async function runBatch(deps: BatchDeps): Promise<BatchStats> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const stats: BatchStats = {
    fetched: 0,
    rejected: 0,
    skipped: 0,
    cleaned: 0,
    failed: 0,
    deferred: 0,
    items: 0,
    translated: 0,
  };
  const startCursor = deps.store.getCursor();
  const records: RawRecord[] = await deps.client.fetchSince(startCursor, deps.limit);
  stats.fetched = records.length;
  const advance = (record: RawRecord): void => {
    const cursor: RecordCursor = { updated_at: record.updated_at, id: record.id };
    deps.store.setCursor(cursor);
  };

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const remaining = records.length - i;
    if (stats.cleaned >= deps.maxPerRun) {
      log(`[cleaner] max-per-run reached (${deps.maxPerRun}), ${remaining} record(s) deferred to the next cycle`);
      stats.deferred += remaining;
      break;
    }
    const quality = checkQuality(record);
    if (!quality.ok) {
      stats.rejected += 1;
      log(`[cleaner] rejected ${record.id}: ${quality.reason}`);
      advance(record);
      continue;
    }
    if (deps.store.cleanedHash(record.id) === record.content_hash) {
      stats.skipped += 1;
      advance(record);
      continue;
    }
    if (deps.rateLimiter && deps.provider.name !== "mock" && !deps.rateLimiter.tryAcquire()) {
      const u = deps.rateLimiter.usage();
      log(
        `[cleaner] LLM budget exhausted (last hour ${u.lastHour}/${deps.rateLimiter.limits.perHour}, last day ${u.lastDay}/${deps.rateLimiter.limits.perDay}); ${remaining} record(s) deferred`,
      );
      stats.deferred += remaining;
      break;
    }
    try {
      const items = await deps.provider.clean(record, deps.systemPrompt);
      if (items.length === 0) throw new Error("provider returned no items");
      deps.store.save(
        record,
        {
          provider: deps.provider.name,
          model: deps.provider.model,
          promptVersion: PROMPT_VERSION,
          cleanedAt: new Date().toISOString(),
        },
        items,
      );
      deps.store.setAttempts(record.id, 0);
      stats.cleaned += 1;
      stats.items += items.length;
      log(`[cleaner] cleaned ${record.id}: ${items.length} items via ${deps.provider.name}/${deps.provider.model}`);
      advance(record);
    } catch (err) {
      const attempts = deps.store.getAttempts(record.id) + 1;
      deps.store.setAttempts(record.id, attempts);
      if (attempts >= MAX_ATTEMPTS) {
        stats.rejected += 1;
        log(
          `[cleaner] giving up on ${record.id} after ${attempts} failed attempts, treating as rejected: ${err instanceof Error ? err.message : String(err)}`,
        );
        deps.store.setAttempts(record.id, 0);
        advance(record);
        continue;
      }
      stats.failed += 1;
      log(
        `[cleaner] failed ${record.id} (attempt ${attempts}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)} — batch stops here, retried next cycle`,
      );
      stats.deferred += remaining - 1;
      break;
    }
  }
  await translatePending(deps, stats, log);
  log(
    `[cleaner] batch done: fetched=${stats.fetched} cleaned=${stats.cleaned} items=${stats.items} skipped=${stats.skipped} rejected=${stats.rejected} failed=${stats.failed} deferred=${stats.deferred} translated=${stats.translated}`,
  );
  return stats;
}

/** How many untranslated items one round looks at (newest first). */
const TRANSLATE_SWEEP_LIMIT = 200;

/**
 * Translation phase, once per round (never per item): sweep the store for
 * items without a translation — this round's fresh items plus any left
 * over from a failed or budget-deferred earlier round — mark the ones
 * already in Chinese, and translate the rest in ONE provider call that
 * shares the cleaner's LLM budget. Failures leave rows NULL; the next
 * round's sweep retries them.
 */
async function translatePending(
  deps: BatchDeps,
  stats: BatchStats,
  log: (line: string) => void,
): Promise<void> {
  if (deps.provider.name === "mock") return;
  const pending = deps.store.listUntranslated(TRANSLATE_SWEEP_LIMIT);
  const entries: { id: string; title: string; summary: string }[] = [];
  for (const row of pending) {
    if (needsTranslation(row.title, row.summary)) entries.push(row);
    else deps.store.markNoTranslation(row.id);
  }
  if (entries.length === 0) return;
  if (deps.rateLimiter && !deps.rateLimiter.tryAcquire()) {
    const u = deps.rateLimiter.usage();
    log(
      `[cleaner] translation deferred: LLM budget exhausted (last hour ${u.lastHour}/${deps.rateLimiter.limits.perHour}, last day ${u.lastDay}/${deps.rateLimiter.limits.perDay}); ${entries.length} item(s) wait for the next cycle`,
    );
    return;
  }
  try {
    const results = await deps.provider.translate(entries, deps.translatePrompt);
    for (const [id, zh] of results) deps.store.setTranslation(id, zh);
    stats.translated = results.size;
    log(
      `[cleaner] translated ${results.size}/${entries.length} items in one batch call (${TRANSLATE_PROMPT_VERSION} via ${deps.provider.name}/${deps.provider.model})`,
    );
  } catch (err) {
    log(
      `[cleaner] translation failed (items stay untranslated, retried next cycle): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
