/**
 * cleaner worker — a pm2-managed scheduled service.
 *
 * Default (service) mode: run one batch on start, then repeat every
 * CLEANER_INTERVAL_MINUTES (default 60). Batches never overlap; SIGINT /
 * SIGTERM finish the in-flight batch, then exit.
 *
 * One-shot mode: `node dist/src/main.js --once` runs a single batch and
 * exits (exit code 1 when any record failed).
 *
 * Pipeline per record: fetch via API -> quality gate -> skip when
 * (id, content_hash) already cleaned -> LLM (or mock) -> validate -> SQLite.
 */
import { join } from "node:path";
import { loadDefaultEnv } from "./load-env.js";

const envFile = loadDefaultEnv();
if (envFile) console.log(`[cleaner] loaded env from ${envFile}`);
import { createRecordsClient } from "./client.js";
import { createLlmProvider } from "./providers.js";
import { CleanerStore } from "./store.js";
import { loadCleanPrompt } from "./prompt.js";
import { runBatch, type BatchStats } from "./batch.js";
import { repoRoot, setupFileLogging } from "./log.js";
import { exportSite } from "@data-pipeline/exporter";

const logFile = setupFileLogging("data-cleaner");
if (logFile) console.log(`[cleaner] logging to ${logFile}`);
const once = process.argv.includes("--once");
const baseUrl = process.env.DATA_PIPELINE_BASE_URL?.trim() || "https://agent101.uk/data-pipeline";
const limit = Number(process.env.CLEANER_LIMIT ?? 100);
const maxPerRun = Number(process.env.CLEANER_MAX_PER_RUN ?? 20);
const intervalMinutes = Math.max(1, Number(process.env.CLEANER_INTERVAL_MINUTES ?? 60));

/**
 * After a batch that cleaned something new, re-export the static site.
 * Failure isolation is a hard rule: an export error is logged and ignored,
 * it must never change the batch outcome.
 */
function maybeExport(stats: BatchStats): void {
  if (stats.cleaned <= 0) return;
  if (process.env.WEB_EXPORT_ON_CLEAN === "false") return;
  try {
    const outDir = process.env.WEB_EXPORT_DIR?.trim() || join(repoRoot(), "web-dist");
    const result = exportSite({ dbFile: store.filePath, outDir, publicApiPath: process.env.PUBLIC_API_PATH });
    console.log(`[cleaner] exported static site: ${result.items} items -> ${result.currentLink}`);
  } catch (err) {
    console.error(`[cleaner] export failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}

const provider = createLlmProvider(process.env);
const store = new CleanerStore(CleanerStore.defaultPath());
const deps = {
  client: createRecordsClient(baseUrl),
  provider,
  store,
  systemPrompt: loadCleanPrompt(),
  limit,
  maxPerRun,
};

let stopping = false;
let inFlight: Promise<BatchStats> | null = null;

async function runOnce(): Promise<BatchStats> {
  inFlight = runBatch(deps);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function main(): Promise<void> {
  console.log(
    `[cleaner] start mode=${once ? "once" : "service"} source=${baseUrl} provider=${provider.name}/${provider.model} interval=${intervalMinutes}m store=${CleanerStore.defaultPath()}`,
  );
  if (provider.name === "mock") {
    console.log("[cleaner] WARNING: no LLM_API_KEY set — running the heuristic mock provider; output is marked provider=mock");
  }
  if (once) {
    const stats = await runOnce();
    maybeExport(stats);
    store.close();
    process.exit(stats.failed > 0 ? 1 : 0);
  }
  // service mode: run immediately, then schedule after each batch finishes
  const tick = async () => {
    if (stopping) return;
    try {
      const stats = await runOnce();
      maybeExport(stats);
    } catch (err) {
      console.error(`[cleaner] batch error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stopping) {
      // NOTE: the timer must stay ref'd — it is the only handle keeping the
      // daemon alive between batches.
      timer = setTimeout(tick, intervalMinutes * 60_000);
    }
  };
  let timer: NodeJS.Timeout | null = setTimeout(tick, 0);
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    console.log(`[cleaner] ${signal}: finishing in-flight batch, then exit`);
    try {
      await inFlight;
    } catch {
      /* already logged */
    }
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[cleaner] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
