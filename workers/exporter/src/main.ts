import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportSite } from "./export.js";
import { loadDefaultEnv } from "./load-env.js";

const envFile = loadDefaultEnv();
if (envFile) console.log(`[exporter] loaded env from ${envFile}`);

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "../../../..");
const dbFile =
  process.env.CLEANED_DB_FILE ??
  join(process.env.CLEANER_DATA_DIR?.trim() || join(repoRoot, "workers/cleaner/data"), "cleaned.sqlite");
const outDir = process.env.WEB_EXPORT_DIR?.trim() || join(repoRoot, "web-dist");

const result = exportSite({ dbFile, outDir, publicApiPath: process.env.PUBLIC_API_PATH });
console.log(`[exporter] exported ${result.items} items -> ${result.currentLink}`);
