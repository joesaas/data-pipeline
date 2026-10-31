import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportSite } from "./export.js";
import { loadDefaultEnv } from "./load-env.js";
import { createPgPool, resolvePgConfig } from "./pg-pool.js";
import { resolveExporterStorageDriver } from "./storage.js";

const envFile = loadDefaultEnv();
if (envFile) console.log(`[exporter] loaded env from ${envFile}`);

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "../../../..");
const outDir = process.env.WEB_EXPORT_DIR?.trim() || join(repoRoot, "web-dist");
const common = {
  outDir,
  publicApiPath: process.env.PUBLIC_API_PATH,
  publicSiteUrl: process.env.PUBLIC_SITE_URL,
  detailDir: process.env.NEWS_DETAIL_DIR?.trim() || undefined,
};

// Unknown switch values fail fast here, before any work starts.
const driver = resolveExporterStorageDriver();
let result;
if (driver === "pg") {
  const config = resolvePgConfig();
  if ("error" in config) throw new Error(config.error);
  const pool = createPgPool(config);
  try {
    result = await exportSite({ pgPool: pool, ...common });
  } finally {
    await pool.end();
  }
} else {
  const dbFile =
    process.env.CLEANED_DB_FILE ??
    join(process.env.CLEANER_DATA_DIR?.trim() || join(repoRoot, "workers/cleaner/data"), "cleaned.sqlite");
  result = await exportSite({ dbFile, ...common });
}
console.log(`[exporter] exported ${result.items} items (${result.detailPages} rich detail) -> ${result.currentLink}`);
