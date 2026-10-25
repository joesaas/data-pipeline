import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Request, Response } from "express";
import type { AppConfig } from "../config.js";
import type { AuthService } from "../auth/auth.js";
import { ADMIN_IDENTITY, type StoredToken, type StoredWebhook, type TokenRole, type WebhookMeta } from "../domain/types.js";
import { parseCron } from "@data-pipeline/shared";
import type { StorageDriver } from "../storage/storage-driver.js";

/**
 * Admin handlers for the web console (mounted on the API router).
 *
 * Every handler here requires an admin token: the caller must resolve to
 * ADMIN_IDENTITY, otherwise 401 (no/invalid key) or 403 (valid non-admin
 * key). When auth is off, everyone resolves to anonymous and admin routes
 * stay closed — that is deliberate, not a bug.
 *
 * These handlers never reveal secrets: token listings omit key_hash (and
 * plaintext keys are never stored anywhere), and webhook rows are shown
 * only as metadata — the token value itself is never returned.
 */

export interface AdminDeps {
  config: AppConfig;
  auth: AuthService;
  driver: StorageDriver;
  envFile: string | null;
}

export function publicToken(t: StoredToken): {
  id: string;
  name: string;
  role: string;
  created_at: string;
  revoked_at: string | null;
} {
  return {
    id: t.id,
    name: t.name,
    role: t.role ?? "user",
    created_at: t.created_at,
    revoked_at: t.revoked_at,
  };
}

/** Repo root: next to the loaded .env when known, else the parent of DATA_DIR. */
export function repoRoot(config: AppConfig, envFile: string | null): string {
  if (envFile) return dirname(envFile);
  return dirname(resolve(config.dataDir));
}

export function cursorRunnerScript(config: AppConfig, envFile: string | null): string {
  return join(repoRoot(config, envFile), "workers/job-runner/dist/src/main.js");
}

/** 401 when no/invalid key, 403 when a valid non-admin key. Returns null after responding. */
export function adminOf(deps: AdminDeps, req: Request, res: Response): string | null {
  const identity = deps.auth.resolveIdentity(req.header("x-api-key") ?? undefined);
  if (identity === null) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  if (identity !== ADMIN_IDENTITY) {
    res.status(403).json({ error: "admin token required" });
    return null;
  }
  return identity;
}

export function listTokens(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const items = deps.driver.listTokens().map(publicToken);
  res.json({ items, total: items.length });
}

export function createToken(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const body = (req.body ?? {}) as { name?: unknown; role?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) {
    res.status(400).json({ error: "name is required (max 100 chars)", field: "name" });
    return;
  }
  let role: TokenRole = "user";
  if (body.role !== undefined) {
    if (body.role !== "user" && body.role !== "admin") {
      res.status(400).json({ error: 'role must be "user" or "admin"', field: "role" });
      return;
    }
    role = body.role;
  }
  const { token, plainKey } = deps.auth.createToken(name, role);
  // Plaintext is returned exactly once; it is never stored.
  res.status(201).json({ ...publicToken(token), api_key: plainKey });
}

export function revokeToken(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = req.params.id;
  const found = deps.driver.listTokens().find((t) => t.id === id);
  if (!found) {
    res.status(404).json({ error: "token not found" });
    return;
  }
  deps.driver.revokeToken(id);
  const updated = deps.driver.listTokens().find((t) => t.id === id);
  res.json(publicToken(updated ?? found));
}

// --- Webhooks (the only webhook table) -------------------------------------

function validWebhookUrl(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol === "https:") return true;
    // Loopback http only, for local testing against a mock receiver.
    if (
      u.protocol === "http:" &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function validWebhookToken(s: string): boolean {
  return s.length > 0 && s.length <= 2000 && !/\s/.test(s) && !s.includes("'");
}

/** Path id must be a positive integer; 400 otherwise (and nothing runs). */
function parseWebhookId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "webhook id must be a positive integer", field: "id" });
    return null;
  }
  return id;
}

function webhookMeta(row: StoredWebhook): WebhookMeta {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    payload: row.payload,
    cron: row.cron ?? null,
    is_active: row.is_active,
    hasToken: row.token.trim() !== "",
    updated_at: row.updated_at,
  };
}

/**
 * Cron is a full value, like payload: absent means "not in this request"
 * (create: null, update: keep), an empty string clears it, anything else
 * must parse as a 5-field cron expression. Returns null, or an error
 * string to send as 400. The single shared parser guarantees the console
 * can never save a schedule the job-runner would not understand.
 */
function parseCronField(raw: unknown, present: boolean): { cron: string | null } | { error: string } {
  if (!present) return { cron: null };
  if (typeof raw !== "string") return { error: "cron must be a string (empty clears it)" };
  const trimmed = raw.trim();
  if (!trimmed) return { cron: null };
  if (trimmed.length > 100) return { error: "cron must be at most 100 chars" };
  if (!parseCron(trimmed)) {
    return { error: 'cron must be a valid 5-field cron expression "minute hour day month weekday" (e.g. "0 9 * * *"), evaluated in Asia/Shanghai time' };
  }
  return { cron: trimmed };
}

/** Mark one webhook scheduled and clear every other (at most one active). */
export function activateWebhook(driver: StorageDriver, id: number): void {
  const now = new Date().toISOString();
  for (const m of driver.listWebhooks()) {
    if (m.is_active && m.id !== id) {
      const full = driver.getWebhook(m.id);
      if (full) driver.saveWebhook({ ...full, is_active: false, updated_at: now });
    }
  }
  const target = driver.getWebhook(id);
  if (target && !target.is_active) {
    driver.saveWebhook({ ...target, is_active: true, updated_at: now });
  }
}

export function listWebhooks(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  res.json(deps.driver.listWebhooks());
}

export function createWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const body = (req.body ?? {}) as {
    name?: unknown;
    webhookUrl?: unknown;
    webhookToken?: unknown;
    payload?: unknown;
    cron?: unknown;
  };
  const name = parsePayloadName(body.name);
  if ("error" in name) {
    res.status(400).json({ error: name.error, field: "name" });
    return;
  }
  if (deps.driver.listWebhooks().some((m) => m.name === name.name)) {
    res.status(409).json({ error: "webhook already exists", field: "name" });
    return;
  }
  const urlRaw = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
  const tokenRaw = typeof body.webhookToken === "string" ? body.webhookToken.trim() : "";
  if (!urlRaw || !validWebhookUrl(urlRaw)) {
    res.status(400).json({ error: "webhookUrl must be an https URL (loopback http allowed)", field: "webhookUrl" });
    return;
  }
  if (!validWebhookToken(tokenRaw)) {
    res.status(400).json({ error: "webhookToken must be a single token without whitespace or quotes", field: "webhookToken" });
    return;
  }
  let payload: string | null = null;
  if (body.payload !== undefined) {
    if (typeof body.payload !== "string") {
      res.status(400).json({ error: "payload must be a string (empty clears it)", field: "payload" });
      return;
    }
    const trimmed = body.payload.trim();
    if (trimmed) {
      const parsed = parsePayloadTemplate(trimmed);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error, field: "payload" });
        return;
      }
      payload = parsed.content;
    }
  }
  const cronParsed = parseCronField(body.cron, "cron" in body);
  if ("error" in cronParsed) {
    res.status(400).json({ error: cronParsed.error, field: "cron" });
    return;
  }
  const now = new Date().toISOString();
  // A new row is never scheduled by default: the timed trigger keeps
  // firing the row that was scheduled before, until one is set active.
  const saved = deps.driver.saveWebhook({
    id: 0,
    name: name.name,
    url: urlRaw,
    token: tokenRaw,
    payload,
    cron: cronParsed.cron,
    is_active: false,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(webhookMeta(saved));
}

export function getWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseWebhookId(req, res);
  if (id === null) return;
  const row = deps.driver.getWebhook(id);
  if (!row) {
    res.status(404).json({ error: "webhook not found" });
    return;
  }
  res.json(webhookMeta(row));
}

export function updateWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseWebhookId(req, res);
  if (id === null) return;
  const existing = deps.driver.getWebhook(id);
  if (!existing) {
    res.status(404).json({ error: "webhook not found" });
    return;
  }
  const body = (req.body ?? {}) as {
    webhookUrl?: unknown;
    webhookToken?: unknown;
    payload?: unknown;
    cron?: unknown;
  };
  let url = existing.url;
  let token = existing.token;
  let payload = existing.payload;
  let cron = existing.cron ?? null;
  if ("cron" in body) {
    const cronParsed = parseCronField(body.cron, true);
    if ("error" in cronParsed) {
      res.status(400).json({ error: cronParsed.error, field: "cron" });
      return;
    }
    cron = cronParsed.cron;
  }
  if (typeof body.webhookUrl === "string" && body.webhookUrl.trim()) {
    if (!validWebhookUrl(body.webhookUrl.trim())) {
      res.status(400).json({ error: "webhookUrl must be an https URL (loopback http allowed)", field: "webhookUrl" });
      return;
    }
    url = body.webhookUrl.trim();
  }
  if (typeof body.webhookToken === "string" && body.webhookToken.trim()) {
    if (!validWebhookToken(body.webhookToken.trim())) {
      res.status(400).json({ error: "webhookToken must be a single token without whitespace or quotes", field: "webhookToken" });
      return;
    }
    token = body.webhookToken.trim();
  }
  if ("payload" in body) {
    // Full value: absent keeps the stored template, an empty string clears it.
    if (typeof body.payload !== "string") {
      res.status(400).json({ error: "payload must be a string (empty clears it)", field: "payload" });
      return;
    }
    const trimmed = body.payload.trim();
    if (!trimmed) {
      payload = null;
    } else {
      const parsed = parsePayloadTemplate(trimmed);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error, field: "payload" });
        return;
      }
      payload = parsed.content;
    }
  }
  const row = deps.driver.saveWebhook({
    ...existing,
    url,
    token,
    payload,
    cron,
    updated_at: new Date().toISOString(),
  });
  res.json(webhookMeta(row));
}

export function deleteWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseWebhookId(req, res);
  if (id === null) return;
  if (!deps.driver.deleteWebhook(id)) {
    res.status(404).json({ error: "webhook not found" });
    return;
  }
  res.json({ ok: true });
}

export function setWebhookActive(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseWebhookId(req, res);
  if (id === null) return;
  const target = deps.driver.getWebhook(id);
  if (!target) {
    res.status(404).json({ error: "webhook not found" });
    return;
  }
  const body = (req.body ?? {}) as { active?: unknown };
  if (typeof body.active !== "boolean") {
    res.status(400).json({ error: "active must be a boolean", field: "active" });
    return;
  }
  if (body.active) {
    activateWebhook(deps.driver, target.id);
  } else {
    deps.driver.saveWebhook({
      ...target,
      is_active: false,
      updated_at: new Date().toISOString(),
    });
  }
  const row = deps.driver.getWebhook(target.id);
  res.json(webhookMeta(row ?? { ...target, is_active: body.active }));
}

/** Shared validation for a payload template: must be a JSON object. */
function parsePayloadTemplate(raw: unknown): { content: string } | { error: string } {
  if (typeof raw !== "string") return { error: "payload must be a string" };
  const trimmed = raw.trim();
  if (trimmed.length > 200_000) return { error: "payload must be at most 200000 chars" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: "payload must be valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "payload must be a JSON object" };
  }
  return { content: trimmed };
}

function parsePayloadName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== "string") return { error: "name must be a string" };
  const name = raw.trim();
  if (!name) return { error: "name is required" };
  if (name.length > 200) return { error: "name must be at most 200 chars" };
  return { name };
}

let triggerInFlight = false;

/**
 * Test-fire one webhook row once, without changing the scheduled row or
 * the trigger cadence: the child runs the job with a webhook override,
 * so it fires this row and skips the interval gate and the state write
 * (see the job file). The row must exist — resolved here, before spawn,
 * so an unknown id is a 404, never a misdirected fire.
 */
export function testWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseWebhookId(req, res);
  if (id === null) return;
  const row = deps.driver.getWebhook(id);
  if (!row) {
    res.status(404).json({ error: "webhook not found" });
    return;
  }
  if (triggerInFlight) {
    res.status(409).json({ error: "trigger already running" });
    return;
  }
  runTriggerChild(deps, res, { webhookOverride: String(row.id) });
}

/**
 * Shared child-spawn for test fires: runs the cursor-trigger job once,
 * exactly like the scheduler does (same code, same environment).
 * A second concurrent request is rejected by the caller's 409 guard, not
 * here, so the guard stays in front of the (possibly slow) row lookups.
 */
function runTriggerChild(
  deps: AdminDeps,
  res: Response,
  overrides: { webhookOverride?: string | null },
): void {
  const script = cursorRunnerScript(deps.config, deps.envFile);
  triggerInFlight = true;
  if (!existsSync(script)) {
    triggerInFlight = false;
    res.status(500).json({ ok: false, error: "job runner script not found (is the runner built?)" });
    return;
  }
  const childEnv = { ...process.env };
  // Set after the copy: the override is per-trigger, and the child's env
  // loader never overwrites variables already present.
  if (overrides.webhookOverride) childEnv.CURSOR_TRIGGER_WEBHOOK_OVERRIDE = overrides.webhookOverride;
  execFile(
    process.execPath,
    [script, "--run", "cursor-trigger"],
    { cwd: repoRoot(deps.config, deps.envFile), timeout: 90_000, env: childEnv },
    (err, stdout, stderr) => {
      triggerInFlight = false;
      const output = `${stdout}\n${stderr}`.trim().slice(-2000);
      if (err) {
        res.status(500).json({ ok: false, error: err.message, output });
        return;
      }
      res.json({ ok: true, output });
    },
  );
}
