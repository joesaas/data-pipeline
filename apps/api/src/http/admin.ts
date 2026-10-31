import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Request, Response } from "express";
import type { AppConfig } from "../config.js";
import type { AuthService } from "../auth/auth.js";
import { verifyPg, type PgVerifyResult } from "../pg/verify.js";
import { ADMIN_IDENTITY, type ChatMessageStatus, type PendingTaskPublic, type PendingTaskStatus, type StoredPendingTask, type StoredPullTask, type StoredToken, type StoredWebhook, type TokenRole, type WebhookMeta } from "../domain/types.js";
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
  /** Override for the PG verify probe (tests inject a stub; production uses verifyPg). */
  pgVerify?: () => Promise<PgVerifyResult>;
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

/**
 * Hard-delete a token row — only for already-revoked rows (409 while
 * still active). Revoke-then-delete is deliberate: an active key must
 * never disappear with one click, and a revoked key is already dead,
 * so deleting its row cannot break a live integration. Records pushed
 * with the token are NOT deleted; they stay readable by admin, with
 * their bucket falling back to the token id in the Records page.
 */
export function deleteToken(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = req.params.id;
  const found = deps.driver.listTokens().find((t) => t.id === id);
  if (!found) {
    res.status(404).json({ error: "token not found" });
    return;
  }
  if (!found.revoked_at) {
    res.status(409).json({ error: "only revoked tokens can be deleted (revoke first)" });
    return;
  }
  deps.driver.deleteToken(id);
  res.json({ ok: true });
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
      const parsed = parsePayloadText(trimmed);
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
      const parsed = parsePayloadText(trimmed);
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

/**
 * Shared validation for a payload template: any text is allowed, not
 * just a JSON object. A template that parses as a JSON object is sent
 * as a JSON body by the trigger; anything else is sent verbatim as
 * plain text (see trigger.ts buildRequest), so a bare prompt no longer
 * needs a {"prompt": "..."} wrapper to be saved. Only the length is
 * still enforced.
 */
function parsePayloadText(raw: unknown): { content: string } | { error: string } {
  if (typeof raw !== "string") return { error: "payload must be a string" };
  const trimmed = raw.trim();
  if (trimmed.length > 200_000) return { error: "payload must be at most 200000 chars" };
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
 * Trigger history for the console's Webhooks tab: newest first, newest
 * 50 by default (max 200), optionally scoped to one webhook. History
 * rows are written by the trigger job itself (see job-runner
 * webhook-history.ts), so scheduled fires show up here without any API
 * involvement; rows survive webhook deletion (the name is a snapshot).
 */
export function listTriggerHistory(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  let webhookId: number | undefined;
  const rawId = req.query.webhook_id;
  if (rawId !== undefined) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "webhook_id must be a positive integer", field: "webhook_id" });
      return;
    }
    webhookId = id;
  }
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
  const { items, total } = deps.driver.listTriggerHistory({ webhook_id: webhookId, limit });
  res.json({ items, total });
}

/**
 * Shared child-spawn for test fires: runs the cursor-trigger job once,
 * exactly like the scheduler does (same code, same environment).
 * A second concurrent request is rejected by the caller's 409 guard, not
 * here, so the guard stays in front of the (possibly slow) row lookups.
 */
// --- Pull tasks (Muse polling, the counterpart to webhook push) -----------

function parsePullTaskId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "pull task id must be a positive integer", field: "id" });
    return null;
  }
  return id;
}

function parsePullTaskName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== "string") return { error: "name is required (max 100 chars)" };
  const name = raw.trim();
  if (!name || name.length > 100) return { error: "name is required (max 100 chars)" };
  return { name };
}

function parsePullTaskPrompt(raw: unknown): { prompt: string } | { error: string } {
  if (typeof raw !== "string") return { error: "prompt is required" };
  const prompt = raw.trim();
  if (!prompt || prompt.length > 200_000) return { error: "prompt is required (max 200000 chars)" };
  return { prompt };
}

function parsePullTaskCron(raw: unknown): { cron: string } | { error: string } {
  if (typeof raw !== "string") return { error: "cron is required" };
  const cron = raw.trim();
  if (!cron || !parseCron(cron)) {
    return { error: 'cron must be a valid 5-field cron expression "minute hour day month weekday" (e.g. "0 9 * * *"), evaluated in Asia/Shanghai time' };
  }
  return { cron };
}

/** Target names an agent ("muse" by default); lowercase letters, digits, dash, underscore, max 50. */
function parsePullTaskTarget(raw: unknown): { target: string } | { error: string } {
  if (raw === undefined) return { target: "muse" };
  if (typeof raw !== "string") return { error: "target must be a string" };
  const target = raw.trim();
  if (!target || target.length > 50 || !/^[a-z0-9][a-z0-9_-]*$/.test(target)) {
    return { error: 'target must match ^[a-z0-9][a-z0-9_-]*$ (max 50 chars), e.g. "muse"' };
  }
  return { target };
}

export function listPullTasks(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  res.json(deps.driver.listPullTasks());
}

export function createPullTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const body = (req.body ?? {}) as { name?: unknown; prompt?: unknown; cron?: unknown; target?: unknown };
  const name = parsePullTaskName(body.name);
  if ("error" in name) {
    res.status(400).json({ error: name.error, field: "name" });
    return;
  }
  if (deps.driver.listPullTasks().some((t) => t.name === name.name)) {
    res.status(409).json({ error: "pull task already exists", field: "name" });
    return;
  }
  const prompt = parsePullTaskPrompt(body.prompt);
  if ("error" in prompt) {
    res.status(400).json({ error: prompt.error, field: "prompt" });
    return;
  }
  const cron = parsePullTaskCron(body.cron);
  if ("error" in cron) {
    res.status(400).json({ error: cron.error, field: "cron" });
    return;
  }
  const target = parsePullTaskTarget(body.target);
  if ("error" in target) {
    res.status(400).json({ error: target.error, field: "target" });
    return;
  }
  const now = new Date().toISOString();
  // A new task is never active by default, like a new webhook: the
  // scheduler must not start queueing a task the moment it is created.
  const saved = deps.driver.savePullTask({
    id: 0,
    name: name.name,
    prompt: prompt.prompt,
    cron: cron.cron,
    target: target.target,
    is_active: false,
    last_run_at: null,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json(saved);
}

export function getPullTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePullTaskId(req, res);
  if (id === null) return;
  const row = deps.driver.getPullTask(id);
  if (!row) {
    res.status(404).json({ error: "pull task not found" });
    return;
  }
  res.json(row);
}

export function updatePullTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePullTaskId(req, res);
  if (id === null) return;
  const existing = deps.driver.getPullTask(id);
  if (!existing) {
    res.status(404).json({ error: "pull task not found" });
    return;
  }
  const body = (req.body ?? {}) as { prompt?: unknown; cron?: unknown; target?: unknown };
  let prompt = existing.prompt;
  let cron = existing.cron;
  let target = existing.target;
  if ("prompt" in body) {
    const parsed = parsePullTaskPrompt(body.prompt);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, field: "prompt" });
      return;
    }
    prompt = parsed.prompt;
  }
  if ("cron" in body) {
    const parsed = parsePullTaskCron(body.cron);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, field: "cron" });
      return;
    }
    cron = parsed.cron;
  }
  if ("target" in body) {
    const parsed = parsePullTaskTarget(body.target);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, field: "target" });
      return;
    }
    target = parsed.target;
  }
  // Editing a task never rewrites already-queued rows: pending rows
  // carry their own prompt/target snapshot, so only future scheduled
  // rows (and future manual runs) pick up the new values.
  const row = deps.driver.savePullTask({
    ...existing,
    prompt,
    cron,
    target,
    updated_at: new Date().toISOString(),
  });
  res.json(row);
}

export function deletePullTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePullTaskId(req, res);
  if (id === null) return;
  if (!deps.driver.deletePullTask(id)) {
    res.status(404).json({ error: "pull task not found" });
    return;
  }
  // Waiting rows of a deleted task will never be wanted; done/failed
  // rows stay as history.
  const cancelled = deps.driver.deleteWaitingPendingTasks(id);
  res.json({ ok: true, cancelled_waiting: cancelled });
}

export function setPullTaskActive(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePullTaskId(req, res);
  if (id === null) return;
  const target = deps.driver.getPullTask(id);
  if (!target) {
    res.status(404).json({ error: "pull task not found" });
    return;
  }
  const body = (req.body ?? {}) as { active?: unknown };
  if (typeof body.active !== "boolean") {
    res.status(400).json({ error: "active must be a boolean", field: "active" });
    return;
  }
  // Unlike webhooks, activating one pull task never deactivates others:
  // each task runs on its own cron.
  const row = deps.driver.savePullTask({
    ...target,
    is_active: body.active,
    updated_at: new Date().toISOString(),
  });
  res.json(row);
}

// --- Pending queue -----------------------------------------------------------
// The queue replaces the earlier due/run polling model (2026-10-25
// redesign): the scheduler inserts rows, the worker claims one, pushes
// its result to the records API itself, then marks it done. No review
// gate on this path, by li's decision.

function parsePendingTaskId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "pending task id must be a positive integer", field: "id" });
    return null;
  }
  return id;
}

function parsePendingStatus(raw: unknown): { status: PendingTaskStatus } | { error: string } {
  if (raw === undefined) return { error: "status is required" };
  if (raw !== "waiting" && raw !== "running" && raw !== "done" && raw !== "failed") {
    return { error: 'status must be one of "waiting", "running", "done", "failed"' };
  }
  return { status: raw };
}

export function listPendingTasks(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const target = typeof req.query.target === "string" ? req.query.target : undefined;
  if (target !== undefined) {
    const parsed = parsePullTaskTarget(target);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, field: "target" });
      return;
    }
  }
  const status = req.query.status;
  let statusFilter: PendingTaskStatus | undefined;
  if (typeof status === "string" && status) {
    const parsed = parsePendingStatus(status);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, field: "status" });
      return;
    }
    statusFilter = parsed.status;
  }
  let items = deps.driver.listPendingTasks({ target, status: statusFilter });
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100;
  items = items.slice(0, limit);
  res.json(items);
}

/**
 * Public detector endpoint for the 5-second hook: waiting rows only,
 * no prompts, no results — just enough for the hook to know there is
 * work and which ids are new. Deliberately unauthenticated (the hook
 * runtime holds no secrets); the prompts themselves stay behind the
 * admin-only claim endpoint. The hook wakes the worker, which then
 * claims with an admin key.
 */
export function listPendingTasksPublic(deps: AdminDeps, req: Request, res: Response): void {
  const targetRaw = typeof req.query.target === "string" && req.query.target ? req.query.target : "muse";
  const parsed = parsePullTaskTarget(targetRaw);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error, field: "target" });
    return;
  }
  const items: PendingTaskPublic[] = deps.driver
    .listPendingTasks({ target: parsed.target, status: "waiting" })
    .slice(0, 100)
    .map((t) => ({ id: t.id, pull_task_id: t.pull_task_id, due_at: t.due_at, kind: t.kind }));
  res.json({ target: parsed.target, waiting: items.length, items });
}

/** Claim a waiting row: waiting -> running. Anything else is a 409 — two workers can never run one row. */
export function claimPendingTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePendingTaskId(req, res);
  if (id === null) return;
  const row = deps.driver.getPendingTask(id);
  if (!row) {
    res.status(404).json({ error: "pending task not found" });
    return;
  }
  if (row.status !== "waiting") {
    res.status(409).json({ error: `pending task is ${row.status}, not waiting`, status: row.status });
    return;
  }
  const claimed = deps.driver.savePendingTask({
    ...row,
    status: "running",
    updated_at: new Date().toISOString(),
  });
  res.json(claimed);
}

/** Mark a running row done after its result was pushed. Requires the pushed record's external_id. */
export function completePendingTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePendingTaskId(req, res);
  if (id === null) return;
  const row = deps.driver.getPendingTask(id);
  if (!row) {
    res.status(404).json({ error: "pending task not found" });
    return;
  }
  if (row.status !== "running") {
    res.status(409).json({ error: `pending task is ${row.status}, not running`, status: row.status });
    return;
  }
  const body = (req.body ?? {}) as { external_id?: unknown; record_id?: unknown };
  if (typeof body.external_id !== "string" || !body.external_id.trim()) {
    res.status(400).json({ error: "external_id is required", field: "external_id" });
    return;
  }
  if (body.record_id !== undefined && typeof body.record_id !== "string") {
    res.status(400).json({ error: "record_id must be a string", field: "record_id" });
    return;
  }
  const done = deps.driver.savePendingTask({
    ...row,
    status: "done",
    result_external_id: body.external_id.trim(),
    result_record_id: typeof body.record_id === "string" ? body.record_id : null,
    error: null,
    updated_at: new Date().toISOString(),
  });
  // Display-only bookkeeping on the task itself (scheduling runs off the queue, not this field).
  const task = deps.driver.getPullTask(row.pull_task_id);
  if (task) {
    deps.driver.savePullTask({ ...task, last_run_at: new Date().toISOString(), updated_at: task.updated_at });
  }
  res.json(done);
}

/** Mark a running row failed, with a short error for the queue display. */
export function failPendingTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePendingTaskId(req, res);
  if (id === null) return;
  const row = deps.driver.getPendingTask(id);
  if (!row) {
    res.status(404).json({ error: "pending task not found" });
    return;
  }
  if (row.status !== "running") {
    res.status(409).json({ error: `pending task is ${row.status}, not running`, status: row.status });
    return;
  }
  const body = (req.body ?? {}) as { error?: unknown };
  const error =
    typeof body.error === "string" && body.error.trim() ? body.error.trim().slice(0, 1000) : "failed";
  const failed = deps.driver.savePendingTask({
    ...row,
    status: "failed",
    error,
    updated_at: new Date().toISOString(),
  });
  res.json(failed);
}

/** Stale-running recovery: a worker that died mid-run leaves its row
 *  "running" forever; after 30 minutes anyone may reset it to waiting
 *  so the next wake retries it. Only running rows reset, never done ones. */
export function resetPendingTask(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePendingTaskId(req, res);
  if (id === null) return;
  const row = deps.driver.getPendingTask(id);
  if (!row) {
    res.status(404).json({ error: "pending task not found" });
    return;
  }
  if (row.status !== "running") {
    res.status(409).json({ error: `pending task is ${row.status}, not running`, status: row.status });
    return;
  }
  const reset = deps.driver.savePendingTask({
    ...row,
    status: "waiting",
    error: null,
    updated_at: new Date().toISOString(),
  });
  res.json(reset);
}

function parseChatMessageId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "chat message id must be a positive integer", field: "id" });
    return null;
  }
  return id;
}

function parseChatStatus(raw: unknown): { status: ChatMessageStatus } | { error: string } {
  if (raw !== "pending" && raw !== "processing" && raw !== "done" && raw !== "failed") {
    return { error: 'status must be one of "pending", "processing", "done", "failed"' };
  }
  return { status: raw };
}

/**
 * Console chat list: newest `limit` rows in chronological order, so a
 * long stream never pushes new messages out of view. Default 200, max 1000.
 */
export function listChatMessages(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const sourceRaw = req.query.source;
  let source: "human" | "muse" | undefined;
  if (typeof sourceRaw === "string" && sourceRaw) {
    if (sourceRaw !== "human" && sourceRaw !== "muse") {
      res.status(400).json({ error: 'source must be "human" or "muse"', field: "source" });
      return;
    }
    source = sourceRaw;
  }
  let statusFilter: ChatMessageStatus | undefined;
  if (typeof req.query.status === "string" && req.query.status) {
    const parsed = parseChatStatus(req.query.status);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error, field: "status" });
      return;
    }
    statusFilter = parsed.status;
  }
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
  const items = deps.driver.listChatMessages({ source, status: statusFilter });
  res.json({ items: items.slice(-limit), total: items.length });
}

/** Worker queue: oldest pending human rows first, so prompts are answered in order. */
export function listPendingChatMessages(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 10;
  const items = deps.driver
    .listChatMessages({ source: "human", status: "pending" })
    .slice(0, limit);
  res.json({ items, total: items.length });
}

export function createChatMessage(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const body = (req.body ?? {}) as { content?: unknown };
  if (typeof body.content !== "string") {
    res.status(400).json({ error: "content is required", field: "content" });
    return;
  }
  const content = body.content.trim();
  if (!content || content.length > 200_000) {
    res.status(400).json({ error: "content is required (max 200000 chars)", field: "content" });
    return;
  }
  const saved = deps.driver.createChatMessage({ source: "human", content });
  res.status(201).json(saved);
}

/** Claim an oldest-pending human row: pending -> processing. Anything else is a 409. */
export function claimChatMessage(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseChatMessageId(req, res);
  if (id === null) return;
  const row = deps.driver.getChatMessage(id);
  if (!row) {
    res.status(404).json({ error: "chat message not found" });
    return;
  }
  if (row.source !== "human" || row.status !== "pending") {
    res.status(409).json({ error: `chat message is ${row.source}/${row.status}, not human/pending`, status: row.status });
    return;
  }
  const claimed = deps.driver.saveChatMessage({
    ...row,
    status: "processing",
    updated_at: new Date().toISOString(),
  });
  res.json(claimed);
}

/** Complete a processing human row: human -> done, plus its muse reply row. Requires reply content. */
export function completeChatMessage(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseChatMessageId(req, res);
  if (id === null) return;
  const row = deps.driver.getChatMessage(id);
  if (!row) {
    res.status(404).json({ error: "chat message not found" });
    return;
  }
  if (row.status !== "processing") {
    res.status(409).json({ error: `chat message is ${row.status}, not processing`, status: row.status });
    return;
  }
  const body = (req.body ?? {}) as { content?: unknown };
  if (typeof body.content !== "string") {
    res.status(400).json({ error: "content is required", field: "content" });
    return;
  }
  const reply = body.content.trim();
  if (!reply || reply.length > 200_000) {
    res.status(400).json({ error: "content is required (max 200000 chars)", field: "content" });
    return;
  }
  const done = deps.driver.completeChatMessage(id, reply);
  if (!done) {
    res.status(409).json({ error: "chat message is no longer processing", status: row.status });
    return;
  }
  res.json(done);
}

/** Mark a processing row failed, with a short error for the console display. */
export function failChatMessage(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseChatMessageId(req, res);
  if (id === null) return;
  const row = deps.driver.getChatMessage(id);
  if (!row) {
    res.status(404).json({ error: "chat message not found" });
    return;
  }
  if (row.status !== "processing") {
    res.status(409).json({ error: `chat message is ${row.status}, not processing`, status: row.status });
    return;
  }
  const body = (req.body ?? {}) as { error?: unknown };
  const error =
    typeof body.error === "string" && body.error.trim() ? body.error.trim().slice(0, 1000) : "failed";
  const failed = deps.driver.saveChatMessage({
    ...row,
    status: "failed",
    error,
    updated_at: new Date().toISOString(),
  });
  res.json(failed);
}

/** Stale-processing recovery: a worker that died mid-run leaves its row
 *  "processing" forever; anyone may reset it to pending so the next
 *  round retries it. Only processing rows reset, never done ones. */
export function resetChatMessage(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parseChatMessageId(req, res);
  if (id === null) return;
  const row = deps.driver.getChatMessage(id);
  if (!row) {
    res.status(404).json({ error: "chat message not found" });
    return;
  }
  if (row.status !== "processing") {
    res.status(409).json({ error: `chat message is ${row.status}, not processing`, status: row.status });
    return;
  }
  const reset = deps.driver.saveChatMessage({
    ...row,
    status: "pending",
    error: null,
    updated_at: new Date().toISOString(),
  });
  res.json(reset);
}

/**
 * PostgreSQL migration verification probe (see src/pg/verify.ts). Admin
 * only. Always answers 200 with a diagnostic envelope: ok is true only
 * when every check passes and all 16 tables exist. A failed probe is
 * data (the migration is not ready), not a server error, so it never
 * surfaces as a 500 — and the envelope never carries credentials: the
 * IAM token is generated per connection inside verifyPg and never
 * returned, logged, or embedded in an error message.
 */
export async function getPgVerify(deps: AdminDeps, req: Request, res: Response): Promise<void> {
  if (adminOf(deps, req, res) === null) return;
  try {
    const probe = deps.pgVerify ?? (() => verifyPg());
    const result = await probe();
    res.json(result);
  } catch {
    // verifyPg itself never throws, but a probe must never crash the API.
    res.status(500).json({ ok: false, reason: "pg verify failed" });
  }
}

/**
 * Manual "run now": insert a waiting row for this task right away.
 * Blocked (409) while the task already has any waiting row — otherwise
 * repeated clicks would pile up identical executions. Works whether or
 * not the task is active: a manual run is an explicit action, not a
 * schedule. due_at is now, so it never collides with a scheduled row.
 */
export function runPullTaskNow(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const id = parsePullTaskId(req, res);
  if (id === null) return;
  const task = deps.driver.getPullTask(id);
  if (!task) {
    res.status(404).json({ error: "pull task not found" });
    return;
  }
  const waiting = deps.driver
    .listPendingTasks({ target: task.target, status: "waiting" })
    .find((t) => t.pull_task_id === id);
  if (waiting) {
    res.status(409).json({ error: "task already has a waiting execution", pending_id: waiting.id });
    return;
  }
  const now = new Date().toISOString();
  try {
    const row = deps.driver.savePendingTask({
      id: 0,
      pull_task_id: task.id,
      pull_task_name: task.name,
      target: task.target,
      prompt: task.prompt,
      due_at: now,
      kind: "manual",
      status: "waiting",
      result_external_id: null,
      result_record_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    });
    res.status(201).json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|duplicate/i.test(msg)) {
      res.status(409).json({ error: "task already has a waiting execution" });
      return;
    }
    throw e;
  }
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
