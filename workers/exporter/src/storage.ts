/**
 * Standalone exporter CLI switch. The cleaner-triggered export does
 * NOT read this variable: the cleaner passes its own mode
 * (CLEANER_STORAGE_DRIVER) explicitly to exportSite, so a PG-mode
 * cleaner can never silently export from a stale SQLite file. This
 * switch governs only `node dist/src/main.js` run on its own.
 *
 * Default SQLite; PG only when EXPORTER_STORAGE_DRIVER=pg. An unknown
 * value throws at startup instead of silently falling back — a
 * mistyped env must not serve the wrong database.
 */
export function resolveExporterStorageDriver(env: NodeJS.ProcessEnv = process.env): "sqlite" | "pg" {
  const raw = (env.EXPORTER_STORAGE_DRIVER ?? "").trim();
  if (raw === "" || raw === "sqlite") return "sqlite";
  if (raw === "pg") return "pg";
  throw new Error(`unknown EXPORTER_STORAGE_DRIVER: ${raw} (expected sqlite or pg)`);
}
