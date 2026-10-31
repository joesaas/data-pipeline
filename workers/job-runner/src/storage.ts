import { createPgPool, resolvePgConfig, type PgPoolLike } from "./pg-pool.js";

/**
 * Standalone job-runner storage switch, mirroring the exporter's
 * switch (workers/exporter/src/storage.ts) and the other three
 * switches (STORAGE_DRIVER / CLEANER_STORAGE_DRIVER /
 * NEWS_DETAIL_STORAGE_DRIVER / EXPORTER_STORAGE_DRIVER).
 *
 * Default SQLite; PG only when JOB_RUNNER_STORAGE_DRIVER=pg. An
 * unknown value throws at startup instead of silently falling back
 * — a mistyped env must not serve the wrong database. The job files
 * and main.ts call this at startup for exactly that fail-fast; the
 * DB functions themselves never throw (see below), so they treat an
 * unreadable switch as "no database" (null/false) rather than
 * guessing a backend.
 */
export function resolveJobRunnerStorageDriver(env: NodeJS.ProcessEnv = process.env): "sqlite" | "pg" {
  const raw = (env.JOB_RUNNER_STORAGE_DRIVER ?? "").trim();
  if (raw === "" || raw === "sqlite") return "sqlite";
  if (raw === "pg") return "pg";
  throw new Error(`unknown JOB_RUNNER_STORAGE_DRIVER: ${raw} (expected sqlite or pg)`);
}

/** Validate the PG env config without connecting. Throws on
 * incomplete/invalid config — call at startup when the driver is pg
 * so a bad PG_* env fails loudly instead of skipping every tick. */
export function assertJobRunnerPgConfig(env: NodeJS.ProcessEnv = process.env): void {
  const config = resolvePgConfig(env);
  if ("error" in config) throw new Error(config.error);
}

/**
 * Lazy singleton pool for the PG path. Jobs run in Bree worker
 * threads, so this singleton lives per worker thread: it is created
 * on the first PG call of a tick and ended by the job file at tick
 * end (endJobRunnerPgPool). A thread killed by Bree (throwing or
 * hung job) takes its pool with it, so no pool can leak past a tick.
 */
let pool: PgPoolLike | null = null;

export function getJobRunnerPgPool(): PgPoolLike {
  if (pool) return pool;
  const config = resolvePgConfig();
  if ("error" in config) throw new Error(config.error);
  pool = createPgPool(config);
  return pool;
}

/** End the tick's pool, if one was created. No-op when PG was never used. */
export async function endJobRunnerPgPool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
