import type { RawRecord } from "@data-pipeline/shared";
import type { RecordsClient } from "./client.js";
import type { LlmProvider } from "./providers.js";
import { checkQuality } from "./quality.js";
import type { CleanerStore } from "./store.js";
import { PROMPT_VERSION } from "./prompt.js";

export interface BatchStats {
  fetched: number;
  rejected: number;
  skipped: number;
  cleaned: number;
  failed: number;
  items: number;
}

export interface BatchDeps {
  client: RecordsClient;
  provider: LlmProvider;
  store: CleanerStore;
  systemPrompt: string;
  limit: number;
  maxPerRun: number;
  log?: (line: string) => void;
}

/** One cleaning pass. Per-record failures are counted, never fatal to the batch. */
export async function runBatch(deps: BatchDeps): Promise<BatchStats> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const stats: BatchStats = { fetched: 0, rejected: 0, skipped: 0, cleaned: 0, failed: 0, items: 0 };
  const records: RawRecord[] = await deps.client.fetchAll(deps.limit);
  stats.fetched = records.length;
  for (const record of records) {
    if (stats.cleaned >= deps.maxPerRun) {
      log(`[cleaner] max-per-run reached (${deps.maxPerRun}), remaining records wait for the next cycle`);
      break;
    }
    const quality = checkQuality(record);
    if (!quality.ok) {
      stats.rejected += 1;
      log(`[cleaner] rejected ${record.id}: ${quality.reason}`);
      continue;
    }
    if (deps.store.cleanedHash(record.id) === record.content_hash) {
      stats.skipped += 1;
      continue;
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
      stats.cleaned += 1;
      stats.items += items.length;
      log(`[cleaner] cleaned ${record.id}: ${items.length} items via ${deps.provider.name}/${deps.provider.model}`);
    } catch (err) {
      stats.failed += 1;
      log(`[cleaner] failed ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(
    `[cleaner] batch done: fetched=${stats.fetched} cleaned=${stats.cleaned} items=${stats.items} skipped=${stats.skipped} rejected=${stats.rejected} failed=${stats.failed}`,
  );
  return stats;
}
