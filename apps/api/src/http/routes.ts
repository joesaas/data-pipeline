import type { Express, Request, Response } from "express";
import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { ValidationError } from "../domain/types.js";
import type { AuthService } from "../auth/auth.js";
import type { IngestService } from "../ingest/ingest-service.js";
import type { StorageDriver } from "../storage/storage-driver.js";
import { CleanedReader } from "../cleaned/cleaned-reader.js";
import { NewsDetailStore } from "../news-detail/news-detail-store.js";
import { NewsDetailService, NotFoundError } from "../news-detail/news-detail-service.js";
import { ResourceService } from "../resource/resource-service.js";
import * as admin from "./admin.js";
import * as site from "./site.js";

/**
 * Routing layer only: parse HTTP, delegate, format responses. No business rules.
 * All routes live on one router, mounted twice: under the project base path
 * (config.basePath, default /data-pipeline) and at the root for compatibility.
 * So POST {basePath}/api/v1/records and POST /api/v1/records are the same API.
 */
export function registerRoutes(
  app: Express,
  deps: { config: AppConfig; auth: AuthService; ingest: IngestService; driver: StorageDriver; envFile?: string | null },
): void {
  const { config, auth, ingest, driver } = deps;
  const adminDeps: admin.AdminDeps = { config, auth, driver, envFile: deps.envFile ?? null };
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

  // Base64 resource uploads are ~33% larger than the decoded file, so
  // the JSON parser limit must cover the resource limit too. Records
  // and news-detail still enforce their own (smaller) maxContentBytes
  // in their services, so a larger parser limit does not widen them.
  router.use(
    express.json({
      limit: Math.max(
        Math.ceil(config.maxContentBytes * 1.6),
        Math.ceil((config.resourceMaxBytes ?? 10_485_760) * 1.4),
      ),
    }),
  );

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
        news_detail_pending: `GET ${base}/api/v1/news-detail/pending?limit= (max 10, oldest first, no done detail page yet)`,
        news_detail_push: `POST ${base}/api/v1/news-detail/pages {item_id, html, detail_path?}`,
        news_detail_get: `GET ${base}/api/v1/news-detail/pages/:item_id`,
        news_detail_done_public: `GET ${base}/api/v1/news-detail/done (public, no key: item_ids with a done detail page, for list-page link rewriting)`,
        resource_upload: `POST ${base}/api/v1/resource/files {path?, filename, content, encoding?} (X-API-Key required, writes under RESOURCE_DIR, served at /resource/)`,
        admin_tokens: `GET ${base}/api/v1/admin/tokens`,
        admin_token_create: `POST ${base}/api/v1/admin/tokens`,
        admin_token_revoke: `POST ${base}/api/v1/admin/tokens/:id/revoke`,
        admin_token_delete: `DELETE ${base}/api/v1/admin/tokens/:id (revoked rows only)`,
        admin_webhooks: `GET ${base}/api/v1/admin/webhooks`,
        admin_webhook_create: `POST ${base}/api/v1/admin/webhooks`,
        admin_webhook_detail: `GET ${base}/api/v1/admin/webhooks/:id`,
        admin_webhook_update: `PUT ${base}/api/v1/admin/webhooks/:id`,
        admin_webhook_delete: `DELETE ${base}/api/v1/admin/webhooks/:id`,
        admin_webhook_active: `POST ${base}/api/v1/admin/webhooks/:id/active`,
        admin_webhook_trigger_history: `GET ${base}/api/v1/admin/webhook-trigger-history?webhook_id=&limit=`,
        admin_webhook_test: `POST ${base}/api/v1/admin/webhooks/:id/test`,
        admin_pull_tasks: `GET ${base}/api/v1/admin/pull-tasks`,
        admin_pull_task_create: `POST ${base}/api/v1/admin/pull-tasks`,
        admin_pull_task_detail: `GET ${base}/api/v1/admin/pull-tasks/:id`,
        admin_pull_task_update: `PUT ${base}/api/v1/admin/pull-tasks/:id`,
        admin_pull_task_delete: `DELETE ${base}/api/v1/admin/pull-tasks/:id`,
        admin_pull_task_active: `POST ${base}/api/v1/admin/pull-tasks/:id/active`,
        admin_pull_task_run_now: `POST ${base}/api/v1/admin/pull-tasks/:id/run-now`,
        admin_pending_tasks: `GET ${base}/api/v1/admin/pull-tasks/pending`,
        admin_pending_claim: `POST ${base}/api/v1/admin/pull-tasks/pending/:id/claim`,
        admin_pending_complete: `POST ${base}/api/v1/admin/pull-tasks/pending/:id/complete`,
        admin_pending_fail: `POST ${base}/api/v1/admin/pull-tasks/pending/:id/fail`,
        admin_pending_reset: `POST ${base}/api/v1/admin/pull-tasks/pending/:id/reset`,
        pull_tasks_pending_public: `GET ${base}/api/v1/pull-tasks/pending?target=`,
        site_auth_nonce: `POST ${base}/api/v1/site-auth/nonce`,
        site_auth_verify: `POST ${base}/api/v1/site-auth/verify`,
        site_auth_me: `GET ${base}/api/v1/site-auth/me`,
        site_auth_logout: `POST ${base}/api/v1/site-auth/logout`,
        site_favorites: `GET/POST ${base}/api/v1/site-favorites`,
        site_favorite_ids: `GET ${base}/api/v1/site-favorites/ids`,
        site_favorite_delete: `DELETE ${base}/api/v1/site-favorites/:item_id`,
      },
      console: `${base}/console`,
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

  // Rich detail pages (news-detail): a separate single-HTML-file
  // pipeline on top of the cleaned items. The pre-existing
  // news/item/<id>/ pages from the exporter are untouched — this
  // only adds: (1) a pending queue, (2) a push that writes one HTML
  // file into NEWS_DETAIL_DIR and records its relative path + status.
  // The status store is its own SQLite file (see news-detail-store),
  // never the cleaner's database and never the records database.
  const newsDetail = new NewsDetailService(
    cleaned,
    new NewsDetailStore(config.newsDetailDbFile),
    config,
  );

  router.get("/api/v1/news-detail/pending", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const raw = Number(req.query.limit ?? 10);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 10, 1), 10);
    res.json(newsDetail.listPending(limit));
  });

  // Public done list for the news-site list page: deliberately
  // unauthenticated, like the public pull-tasks pending endpoint —
  // the list page holds no API key, and item ids + file names are
  // already public (they appear in the list page and items.json).
  // It returns ids only, never HTML content, so a browser can rewrite
  // card links at load time the moment a detail page exists, with no
  // re-export and no deploy in between.
  router.get("/api/v1/news-detail/done", (_req, res) => {
    const items = newsDetail.listDone();
    res.json({ item_ids: items.map((i) => i.item_id), items, count: items.length });
  });

  router.get("/api/v1/news-detail/pages/:item_id", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    const page = newsDetail.getPage(req.params.item_id);
    if (!page) {
      res.status(404).json({ error: "detail page not found" });
      return;
    }
    res.json(page);
  });

  router.post("/api/v1/news-detail/pages", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    if (rateLimited(config.authRequired ? identity : (req.ip ?? "unknown"))) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    try {
      const result = newsDetail.savePage({
        item_id: typeof req.body?.item_id === "string" ? req.body.item_id : "",
        html: typeof req.body?.html === "string" ? req.body.html : "",
        detail_path: typeof req.body?.detail_path === "string" ? req.body.detail_path : undefined,
      });
      res.status(result.status === "created" ? 201 : 200).json(result);
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ValidationError) {
        res
          .status(err.tooLarge ? 413 : 400)
          .json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
        return;
      }
      throw err;
    }
  });

  // Resource uploads: a file + relative path, written under the
  // fixed RESOURCE_DIR (default /home/ec2-user/app/resource) and
  // served by nginx /resource/. Auth is stricter than records /
  // news-detail on purpose: a valid X-API-Key is required even when
  // the global AUTH_REQUIRED flag is off, because these files are
  // then served publicly by nginx. No DB row is created.
  const resource = new ResourceService(config);

  router.post("/api/v1/resource/files", (req, res) => {
    const identity = auth.resolveValidKey(req.header("x-api-key") ?? undefined);
    if (identity === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (rateLimited(identity)) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    try {
      const result = resource.saveFile({
        path: typeof req.body?.path === "string" ? req.body.path : undefined,
        filename: typeof req.body?.filename === "string" ? req.body.filename : "",
        content: typeof req.body?.content === "string" ? req.body.content : "",
        encoding: typeof req.body?.encoding === "string" ? req.body.encoding : undefined,
      });
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

  router.delete("/api/v1/records/:id", (req, res) => {
    const identity = identityOf(req, res);
    if (identity === null) return;
    if (!driver.deleteRecord(identity, req.params.id)) {
      res.status(404).json({ error: "record not found" });
      return;
    }
    res.status(204).send();
  });

  // Admin routes (web console). No rate limit: unlike the public push
  // endpoint, these are gated to a single admin identity, and a stolen
  // admin key is already total compromise — throttling would not help.
  router.get("/api/v1/admin/tokens", (req, res) => admin.listTokens(adminDeps, req, res));
  router.post("/api/v1/admin/tokens", (req, res) => admin.createToken(adminDeps, req, res));
  router.post("/api/v1/admin/tokens/:id/revoke", (req, res) => admin.revokeToken(adminDeps, req, res));
  router.delete("/api/v1/admin/tokens/:id", (req, res) => admin.deleteToken(adminDeps, req, res));
  router.get("/api/v1/admin/webhooks", (req, res) => admin.listWebhooks(adminDeps, req, res));
  router.post("/api/v1/admin/webhooks", (req, res) => admin.createWebhook(adminDeps, req, res));
  router.get("/api/v1/admin/webhooks/:id", (req, res) => admin.getWebhook(adminDeps, req, res));
  router.put("/api/v1/admin/webhooks/:id", (req, res) => admin.updateWebhook(adminDeps, req, res));
  router.delete("/api/v1/admin/webhooks/:id", (req, res) => admin.deleteWebhook(adminDeps, req, res));
  router.post("/api/v1/admin/webhooks/:id/active", (req, res) =>
    admin.setWebhookActive(adminDeps, req, res),
  );
  router.post("/api/v1/admin/webhooks/:id/test", (req, res) =>
    admin.testWebhook(adminDeps, req, res),
  );
  router.get("/api/v1/admin/webhook-trigger-history", (req, res) =>
    admin.listTriggerHistory(adminDeps, req, res),
  );
  // Pull tasks (queue model). The /pending routes must be registered
  // before /:id, or "pending" would be parsed as an id and 400.
  router.get("/api/v1/admin/pull-tasks/pending", (req, res) =>
    admin.listPendingTasks(adminDeps, req, res),
  );
  router.post("/api/v1/admin/pull-tasks/pending/:id/claim", (req, res) =>
    admin.claimPendingTask(adminDeps, req, res),
  );
  router.post("/api/v1/admin/pull-tasks/pending/:id/complete", (req, res) =>
    admin.completePendingTask(adminDeps, req, res),
  );
  router.post("/api/v1/admin/pull-tasks/pending/:id/fail", (req, res) =>
    admin.failPendingTask(adminDeps, req, res),
  );
  router.post("/api/v1/admin/pull-tasks/pending/:id/reset", (req, res) =>
    admin.resetPendingTask(adminDeps, req, res),
  );
  router.get("/api/v1/admin/pull-tasks", (req, res) => admin.listPullTasks(adminDeps, req, res));
  router.post("/api/v1/admin/pull-tasks", (req, res) => admin.createPullTask(adminDeps, req, res));
  router.get("/api/v1/admin/pull-tasks/:id", (req, res) => admin.getPullTask(adminDeps, req, res));
  router.put("/api/v1/admin/pull-tasks/:id", (req, res) =>
    admin.updatePullTask(adminDeps, req, res),
  );
  router.delete("/api/v1/admin/pull-tasks/:id", (req, res) =>
    admin.deletePullTask(adminDeps, req, res),
  );
  router.post("/api/v1/admin/pull-tasks/:id/active", (req, res) =>
    admin.setPullTaskActive(adminDeps, req, res),
  );
  router.post("/api/v1/admin/pull-tasks/:id/run-now", (req, res) =>
    admin.runPullTaskNow(adminDeps, req, res),
  );
  // Console chat (single stream). The /pending route must be registered
  // before /:id, or "pending" would be parsed as an id and 400.
  router.get("/api/v1/admin/chat/messages", (req, res) =>
    admin.listChatMessages(adminDeps, req, res),
  );
  router.post("/api/v1/admin/chat/messages", (req, res) =>
    admin.createChatMessage(adminDeps, req, res),
  );
  router.get("/api/v1/admin/chat/messages/pending", (req, res) =>
    admin.listPendingChatMessages(adminDeps, req, res),
  );
  router.post("/api/v1/admin/chat/messages/:id/claim", (req, res) =>
    admin.claimChatMessage(adminDeps, req, res),
  );
  router.post("/api/v1/admin/chat/messages/:id/complete", (req, res) =>
    admin.completeChatMessage(adminDeps, req, res),
  );
  router.post("/api/v1/admin/chat/messages/:id/fail", (req, res) =>
    admin.failChatMessage(adminDeps, req, res),
  );
  router.post("/api/v1/admin/chat/messages/:id/reset", (req, res) =>
    admin.resetChatMessage(adminDeps, req, res),
  );
  // Public detector for the 5-second hook: waiting ids only, no prompts.
  // Deliberately unauthenticated — the hook runtime holds no secrets.
  router.get("/api/v1/pull-tasks/pending", (req, res) =>
    admin.listPendingTasksPublic(adminDeps, req, res),
  );

  // News-site reader auth (wallet) + favorites. These use their own
  // session Bearer tokens, never API keys, and are rate-limited by IP
  // on the two login steps so nonce/verify cannot be spammed freely.
  const siteDeps: site.SiteDeps = { driver };
  router.post("/api/v1/site-auth/nonce", (req, res) => {
    if (rateLimited(req.ip ?? "unknown")) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    site.requestNonce(siteDeps, req, res);
  });
  router.post("/api/v1/site-auth/verify", (req, res) => {
    if (rateLimited(req.ip ?? "unknown")) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    site.verifyNonce(siteDeps, req, res);
  });
  router.get("/api/v1/site-auth/me", (req, res) => site.getMe(siteDeps, req, res));
  router.post("/api/v1/site-auth/logout", (req, res) => site.logout(siteDeps, req, res));
  router.get("/api/v1/site-favorites", (req, res) => site.listFavorites(siteDeps, req, res));
  router.get("/api/v1/site-favorites/ids", (req, res) => site.listFavoriteIds(siteDeps, req, res));
  router.post("/api/v1/site-favorites", (req, res) => site.addFavorite(siteDeps, req, res));
  router.delete("/api/v1/site-favorites/:item_id", (req, res) =>
    site.removeFavorite(siteDeps, req, res),
  );

  if (config.basePath) app.use(config.basePath, router);
  app.use(router);

  // Web console (Vue SPA), served by this same process — no new pm2 app.
  // Silent when the console has not been built (e.g. CLI runs, or a
  // deploy that predates the console): /console then simply 404s.
  //
  // redirect: false is load-bearing, not cosmetic. nginx proxies
  // /data-pipeline/ to this process with the prefix stripped, so the app
  // sees /console where the browser asked for /data-pipeline/console.
  // With the default redirect: true, a bare /console request answers
  // 301 Location: /console/ — a prefix-less URL the browser then
  // resolves against the public host, landing on whatever owns /console/
  // there (2026-10-25: the doc site, not this console). With redirect
  // false the index is served in place, no Location is ever emitted, and
  // the absolute asset base in the console build (see vite.config.js)
  // keeps assets resolving under both proxy shapes.
  const consoleDir = join(admin.repoRoot(config, adminDeps.envFile), "apps/console/dist");
  if (existsSync(consoleDir)) {
    const prefixes = [...new Set(["/console", config.basePath ? `${config.basePath}/console` : "/console"])];
    app.use(prefixes, express.static(consoleDir, { redirect: false }));
    // Bare mount paths (no trailing slash, no extra segment): serve the
    // SPA entry directly. express.static with redirect: false already
    // does this for directory requests; the explicit handler makes the
    // behaviour independent of static internals.
    app.get(prefixes, (_req, res) => {
      res.sendFile(join(consoleDir, "index.html"));
    });
    app.get(
      prefixes.map((p) => `${p}/*`),
      (_req, res) => {
        res.sendFile(join(consoleDir, "index.html"));
      },
    );
  }
}
