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
import { createRecordsClient } from "./client.js";
import { LlmRateLimiter } from "./ratelimit.js";
import { createLlmProvider } from "./providers.js";
import { CleanerStore } from "./store.js";
import { PgCleanerStore } from "./pg-store.js";
import type { CleanerStoreLike } from "./store.js";
import { loadCleanPrompt } from "./prompt.js";
import { loadTranslatePrompt } from "./translate.js";
import { runBatch, type BatchStats } from "./batch.js";
import { repoRoot, setupFileLogging } from "./log.js";
import { maybeExport } from "./maybe-export.js";
import { createPgPool, resolvePgConfig, type PgPoolLike } from "./pg-pool.js";

const logFile = setupFileLogging("data-cleaner");
if (logFile) console.log(`[cleaner] logging to ${logFile}`);
console.log(`[cleaner] env file: ${envFile ?? "(none found)"}`);
const once = process.argv.includes("--once");
const baseUrl = process.env.DATA_PIPELINE_BASE_URL?.trim() || "https://agent101.uk/data-pipeline";
const limit = Number(process.env.CLEANER_LIMIT ?? 100);
const maxPerRun = Number(process.env.CLEANER_MAX_PER_RUN ?? 20);
const intervalMinutes = Math.max(1, Number(process.env.CLEANER_INTERVAL_MINUTES ?? 60));
const llmRateLimits = {
  perHour: Number(process.env.LLM_RATE_PER_HOUR ?? 30),
  perDay: Number(process.env.LLM_RATE_PER_DAY ?? 500),
};

/**
 * Export pool for PG mode, created once per cleaner process and reused
 * across exports (same IAM token-callback pool as the store pool, but
 * a separate instance: the store pool belongs to PgCleanerStore and
 * is not exposed). Only created when a PG-mode export actually runs;
 * a SQLite-mode cleaner never creates it. resolvePgConfig cannot fail
 * here in practice — a PG store already validated the same config at
 * construction — but a failure still surfaces through maybeExport's
 * log-and-ignore path instead of crashing the batch.
 */
let exportPool: PgPoolLike | null = null;
function getExportPool(): PgPoolLike {
  if (!exportPool) {
    const config = resolvePgConfig();
    if ("error" in config) throw new Error(config.error);
    exportPool = createPgPool(config);
  }
  return exportPool;
}

async function exportAfterBatch(stats: BatchStats): Promise<void> {
  await maybeExport(stats, {
    storeFilePath: store.filePath,
    getPgPool: getExportPool,
    outDir: process.env.WEB_EXPORT_DIR?.trim() || join(repoRoot(), "web-dist"),
    publicApiPath: process.env.PUBLIC_API_PATH,
    publicSiteUrl: process.env.PUBLIC_SITE_URL,
    // Same detailDir as the manual exporter: without it, a cleaner-
    // triggered export would silently revert list links to old pages.
    detailDir: process.env.NEWS_DETAIL_DIR?.trim() || undefined,
    webExportOnClean: process.env.WEB_EXPORT_ON_CLEAN,
  });
}

const provider = createLlmProvider(process.env);
/** Storage backend selection: default SQLite; PG only when
 * CLEANER_STORAGE_DRIVER=pg. An unknown value fails fast instead of
 * silently falling back — a mistyped env must not serve the wrong DB. */
const cleanerDriver = (process.env.CLEANER_STORAGE_DRIVER ?? "").trim();
if (cleanerDriver !== "" && cleanerDriver !== "sqlite" && cleanerDriver !== "pg") {
  throw new Error(`unknown CLEANER_STORAGE_DRIVER: ${cleanerDriver} (expected sqlite or pg)`);
}
const store: CleanerStoreLike =
  cleanerDriver === "pg" ? new PgCleanerStore() : new CleanerStore(CleanerStore.defaultPath());
const rateLimiter = new LlmRateLimiter(store, llmRateLimits);
const deps = {
  client: createRecordsClient(baseUrl, fetch, process.env.DATA_PIPELINE_API_KEY?.trim() || undefined),
  provider,
  store,
  systemPrompt: loadCleanPrompt(),
  translatePrompt: loadTranslatePrompt(),
  dedupeWindowDays: Math.max(1, Number(process.env.CLEANER_DEDUPE_WINDOW_DAYS ?? 7)),
  limit,
  maxPerRun,
  rateLimiter,
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
    `[cleaner] start mode=${once ? "once" : "service"} source=${baseUrl} provider=${provider.name}/${provider.model} interval=${intervalMinutes}m llm_budget=${llmRateLimits.perHour}/h,${llmRateLimits.perDay}/d store=${store.filePath ?? "pg:data_pipeline"}`,
  );
  if (provider.name === "mock") {
    console.log("[cleaner] WARNING: no LLM_API_KEY set — running the heuristic mock provider; output is marked provider=mock");
  }
  if (once) {
    const stats = await runOnce();
    await exportAfterBatch(stats);
    await store.close();
    if (exportPool) await exportPool.end();
    process.exit(stats.failed > 0 ? 1 : 0);
  }
  // service mode: run immediately, then schedule after each batch finishes
  const tick = async () => {
    if (stopping) return;
    try {
      const stats = await runOnce();
      await exportAfterBatch(stats);
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
    await store.close();
    if (exportPool) await exportPool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[cleaner] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
