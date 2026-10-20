import type { Express, Request, Response } from "express";
import express from "express";
import type { AppConfig } from "../config.js";
import { ValidationError } from "../domain/types.js";
import type { AuthService } from "../auth/auth.js";
import type { IngestService } from "../ingest/ingest-service.js";
import type { StorageDriver } from "../storage/storage-driver.js";

/** Routing layer only: parse HTTP, delegate, format responses. No business rules. */
export function registerRoutes(
  app: Express,
  deps: { config: AppConfig; auth: AuthService; ingest: IngestService; driver: StorageDriver },
): void {
  const { config, auth, ingest, driver } = deps;

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

  app.use(express.json({ limit: Math.ceil(config.maxContentBytes * 1.6) }));

  app.get("/api/v1/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/v1/records", (req, res) => {
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

  app.get("/api/v1/records", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const { items, total } = driver.listRecords(identity, {
      source_agent: typeof req.query.source_agent === "string" ? req.query.source_agent : undefined,
      tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
      limit,
      offset,
    });
    res.json({ items, total, limit, offset });
  });

  app.get("/api/v1/records/:id", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const rec = driver.getRecord(identity, req.params.id);
    if (!rec) {
      res.status(404).json({ error: "record not found" });
      return;
    }
    res.json(rec);
  });

  app.delete("/api/v1/records/:id", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    if (!driver.deleteRecord(identity, req.params.id)) {
      res.status(404).json({ error: "record not found" });
      return;
    }
    res.status(204).send();
  });
}
