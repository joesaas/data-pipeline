import { join } from "node:path";
import express from "express";
import type { AppConfig } from "./config.js";
import { AuthService } from "./auth/auth.js";
import { registerRoutes } from "./http/routes.js";
import { IngestService } from "./ingest/ingest-service.js";
import { FileDriver } from "./storage/file-driver.js";
import { SqliteDriver } from "./storage/sqlite-driver.js";
import type { StorageDriver } from "./storage/storage-driver.js";

export function createDriver(config: AppConfig): StorageDriver {
  if (config.storage === "file") return new FileDriver(join(config.dataDir, "files"));
  return new SqliteDriver(join(config.dataDir, "data.db"));
}

export function createApp(
  config: AppConfig,
  opts?: { envFile?: string | null },
): { app: express.Express; driver: StorageDriver; auth: AuthService } {
  const driver = createDriver(config);
  const auth = new AuthService(driver, config.authRequired);
  const ingest = new IngestService(driver, config);
  const app = express();
  registerRoutes(app, { config, auth, ingest, driver, envFile: opts?.envFile ?? null });
  return { app, driver, auth };
}
