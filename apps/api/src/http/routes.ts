import type { Express, Request, Response } from "express";
import express from "express";
import type { AppConfig } from "../config.js";
import { ValidationError } from "../domain/types.js";
import type { AuthService } from "../auth/auth.js";
import type { IngestService } from "../ingest/ingest-service.js";
import type { StorageDriver } from "../storage/storage-driver.js";
import { CleanedReader } from "../cleaned/cleaned-reader.js";

/**
 * Routing layer only: parse HTTP, delegate, format responses. No business rules.
 * All routes live on one router, mounted twice: under the project base path
 * (config.basePath, default /data-pipeline) and at the root for compatibility.
 * So POST {basePath}/api/v1/records and POST /api/v1/records are the same API.
 */
export function registerRoutes(
  app: Express,
  deps: { config: AppConfig; auth: AuthService; ingest: IngestService; driver: StorageDriver },
): void {
  const { config, auth, ingest, driver } = deps;
  const router = express.Router();

  // Simple fixed-window rate limit, keyed by identity (or IP when anonymous).
  const windows = new Map<string, { start: number; count: number }>();
  function rateLimited(key: string): boolean {
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      return false;
    }
    w.count += 1;
    return w.count > config.rateLimitPerMin;
  }

  function identityOf(req: Request, res: Response): string | null {
    const identity = auth.resolveIdentity(req.header("x-api-key") ?? undefined);
    if (identity === null) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    return identity;
  }

  router.use(express.json({ limit: Math.ceil(config.maxContentBytes * 1.6) }));

  // Service info root (also the project base path root). No auth, no data.
  router.get("/", (_req, res) => {
    const base = config.basePath;
    res.json({
      name: "data-pipeline",
      version: "0.1.0",
      description: "Agents push prompt+content pairs here via the pipe-push skill.",
      base_path: base || "/",
      storage: config.storage,
      auth_required: config.authRequired,
      endpoints: {
        health: `GET ${base}/api/v1/health`,
        push: `POST ${base}/api/v1/records`,
        list: `GET ${base}/api/v1/records?source_agent=&tag=&limit=&offset=&order=updated_asc&updated_after=&after_id=`,
        get: `GET ${base}/api/v1/records/:id`,
        delete: `DELETE ${base}/api/v1/records/:id`,
        cleaned_items: `GET ${base}/api/v1/cleaned/items?category=&q=&limit=&offset=`,
        cleaned_item: `GET ${base}/api/v1/cleaned/items/:id`,
        cleaned_stats: `GET ${base}/api/v1/cleaned/stats`,
      },
      docs: "https://github.com/joesaas/data-pipeline",
    });
  });

  router.get("/api/v1/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.post("/api/v1/records", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    if (rateLimited(config.authRequired ? identity : (req.ip ?? "unknown"))) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    try {
      const result = ingest.push(identity, req.body);
      res.status(result.status === "created" ? 201 : 200).json(result);
    } catch (err) {
      if (err instanceof ValidationError) {
        res
          .status(err.tooLarge ? 413 : 400)
          .json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
        return;
      }
      throw err;
    }
  });

  router.get("/api/v1/records", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const { items, total } = driver.listRecords(identity, {
      source_agent: typeof req.query.source_agent === "string" ? req.query.source_agent : undefined,
      tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
      limit,
      offset,
      updated_after: typeof req.query.updated_after === "string" ? req.query.updated_after : undefined,
      after_id: typeof req.query.after_id === "string" ? req.query.after_id : undefined,
      order: req.query.order === "updated_asc" ? "updated_asc" : undefined,
    });
    res.json({ items, total, limit, offset });
  });

  router.get("/api/v1/records/:id", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const rec = driver.getRecord(identity, req.params.id);
    if (!rec) {
      res.status(404).json({ error: "record not found" });
      return;
    }
    res.json(rec);
  });

  const cleaned = new CleanedReader(config.cleanedDbFile);

  router.get("/api/v1/cleaned/items", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const { items, total } = cleaned.listItems({
      category: typeof req.query.category === "string" && req.query.category ? req.query.category : undefined,
      q: typeof req.query.q === "string" && req.query.q ? req.query.q : undefined,
      limit,
      offset,
    });
    res.json({ items, total, limit, offset });
  });

  router.get("/api/v1/cleaned/items/:id", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const item = cleaned.getItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "cleaned item not found" });
      return;
    }
    res.json(item);
  });

  router.get("/api/v1/cleaned/stats", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    res.json(cleaned.stats());
  });

  router.delete("/api/v1/records/:id", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    if (!driver.deleteRecord(identity, req.params.id)) {
      res.status(404).json({ error: "record not found" });
      return;
    }
    res.status(204).send();
  });

  if (config.basePath) app.use(config.basePath, router);
  app.use(router);
}
