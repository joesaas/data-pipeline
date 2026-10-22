/**
 * cleaner worker entry (batch, run manually or on a schedule):
 *
 *   fetch raw records via GET /api/v1/records
 *   -> quality gate (src/quality.ts)
 *   -> LLM cleaning (src/providers.ts) into structured items
 *   -> write cleaned output (sink not decided yet, see docs/architecture.md)
 *
 * Current state (2026-10-22): steps 1-2 are live. Step 3 is not wired (no LLM
 * provider chosen), and the output sink is an open decision, so records that
 * pass the gate are reported as "pending" instead of being cleaned. Nothing
 * is written anywhere yet.
 */
import type { RawRecord, RecordsPage } from "@data-pipeline/shared";
import { checkQuality } from "./quality.js";
import { createLlmProvider } from "./providers.js";

const baseUrl = (process.env.DATA_PIPELINE_BASE_URL ?? "https://agent101.uk/data-pipeline").replace(/\/$/, "");
const limit = Number(process.env.CLEANER_LIMIT ?? 100);

async function fetchRecords(): Promise<RawRecord[]> {
  const res = await fetch(`${baseUrl}/api/v1/records?limit=${limit}&offset=0`);
  if (!res.ok) throw new Error(`GET records failed: ${res.status} ${res.statusText}`);
  const page = (await res.json()) as RecordsPage;
  return page.items;
}

async function main(): Promise<void> {
  const provider = createLlmProvider(process.env);
  console.log(`[cleaner] source=${baseUrl} llm=${provider ? `${provider.name}/${provider.model}` : "not configured"}`);
  const records = await fetchRecords();
  let rejected = 0;
  let pending = 0;
  for ( const record of records) {
    const quality = checkQuality(record);
    if (!quality.ok) {
      rejected += 1;
      console.log(`[cleaner] rejected ${record.id}: ${quality.reason}`);
      continue;
    }
    if (!provider) {
      pending += 1;
      console.log(`[cleaner] pending ${record.id}: passed quality gate, no LLM provider yet`);
      continue;
    }
    // TODO(cleaning): call provider.clean(record), validate against the
    // shared schema, then write to the decided sink.
    throw new Error("cleaning step not implemented yet");
  }
  console.log(`[cleaner] done: total=${records.length} rejected=${rejected} pending=${pending}`);
}

main().catch((err) => {
  console.error(`[cleaner] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
