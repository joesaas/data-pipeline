import { exportSite } from "@data-pipeline/exporter";
import type { PgPoolLike } from "./pg-pool.js";

export interface MaybeExportOptions {
  /** PG mode is selected by a null storeFilePath (PgCleanerStore has
   * no file); the pool then comes from getPgPool. SQLite mode passes
   * the store's file path and never touches the pool. */
  storeFilePath: string | null;
  /** Lazily-created export pool for PG mode (the cleaner process owns
   * it; it is created once and reused across exports). Only called
   * in PG mode, never in SQLite mode. */
  getPgPool: () => PgPoolLike;
  outDir: string;
  publicApiPath?: string;
  publicSiteUrl?: string;
  detailDir?: string;
  /** Raw WEB_EXPORT_ON_CLEAN value; exactly "false" disables export. */
  webExportOnClean?: string;
  /** Injectable for tests; defaults to the real exportSite. */
  runExport?: typeof exportSite;
  log?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
}

/**
 * After a batch that cleaned something new, re-export the static site.
 * Failure isolation is a hard rule: an export error is logged and
 * ignored, it must never change the batch outcome.
 *
 * PG mode exports from PG (via getPgPool), it does NOT skip: the
 * exporter now reads the cleaner schema, so a PG-mode cleaner keeps
 * refreshing the static list exactly like the SQLite path does. A
 * failed export writes nothing — exportSite reads before creating
 * any directory and only flips `current` after a complete release —
 * so a failure can never leave a half-written site behind.
 */
export async function maybeExport(
  stats: { cleaned: number; translated: number },
  opts: MaybeExportOptions,
): Promise<void> {
  if (stats.cleaned <= 0 && stats.translated <= 0) return;
  if (opts.webExportOnClean === "false") return;
  const run = opts.runExport ?? exportSite;
  const log = opts.log ?? console.log;
  const logError = opts.logError ?? console.error;
  try {
    const result = opts.storeFilePath
      ? await run({
          dbFile: opts.storeFilePath,
          outDir: opts.outDir,
          publicApiPath: opts.publicApiPath,
          publicSiteUrl: opts.publicSiteUrl,
          detailDir: opts.detailDir,
        })
      : await run({
          pgPool: opts.getPgPool(),
          outDir: opts.outDir,
          publicApiPath: opts.publicApiPath,
          publicSiteUrl: opts.publicSiteUrl,
          detailDir: opts.detailDir,
        });
    log(`[cleaner] exported static site: ${result.items} items (${result.detailPages} rich detail) -> ${result.currentLink}`);
  } catch (err) {
    logError(`[cleaner] export failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
