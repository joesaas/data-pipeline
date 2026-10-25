import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Request, Response } from "express";
import type { AppConfig } from "../config.js";
import type { AuthService } from "../auth/auth.js";
import { ADMIN_IDENTITY, type StoredToken, type TokenRole } from "../domain/types.js";
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
 * plaintext keys are never stored anywhere), and webhook configuration is
 * managed in the database webhook_configs table — the console shows only
 * presence, source, and update time, never the token value itself.
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

export function cursorStatePath(config: AppConfig, envFile: string | null): string {
  return join(repoRoot(config, envFile), "workers/job-runner/data/cursor-trigger-state.json");
}

export function cursorRunnerScript(config: AppConfig, envFile: string | null): string {
  return join(repoRoot(config, envFile), "workers/job-runner/dist/src/main.js");
}

export interface CursorJobState {
  lastTriggeredAt: string | null;
  intervalMinutes: number | null;
  /** Console-set instruction text for the webhook body; null = ping only. */
  prompt: string | null;
}

export function readCursorState(path: string): CursorJobState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CursorJobState>;
    return {
      lastTriggeredAt: typeof parsed.lastTriggeredAt === "string" ? parsed.lastTriggeredAt : null,
      intervalMinutes:
        typeof parsed.intervalMinutes === "number" && parsed.intervalMinutes >= 1
          ? Math.floor(parsed.intervalMinutes)
          : null,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : null,
    };
  } catch {
    return { lastTriggeredAt: null, intervalMinutes: null, prompt: null };
  }
}

export function writeCursorState(path: string, state: CursorJobState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Mirror of workers/job-runner/src/cursor-state.ts resolveIntervalMinutes — keep in sync. */
export function effectiveIntervalMinutes(state: CursorJobState, env: NodeJS.ProcessEnv): number {
  if (state.intervalMinutes !== null) return Math.max(1, state.intervalMinutes);
  const fromEnv = Number(env.CURSOR_TRIGGER_INTERVAL_MINUTES ?? 60) || 60;
  return Math.max(1, fromEnv);
}

// --- Root .env file access (webhook fallback + import source) ---------------
// Webhook configuration now lives in the database (see setCursorWebhook).
// The .env file remains only as the fallback the trigger job uses when no
// database row exists, and as the source for the one-click import below.
// Parsing is intentionally small: KEY=VALUE lines with an optional
// `export ` prefix; surrounding quotes are stripped for reads.

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvValues(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(ENV_LINE);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    map.set(m[1], v);
  }
  return map;
}

function readEnvFileValues(envPath: string): Map<string, string> {
  try {
    return parseEnvValues(readFileSync(envPath, "utf8"));
  } catch {
    return new Map();
  }
}

/** The row name the cursor-trigger job looks up in webhook_configs. */
export const CURSOR_WEBHOOK_NAME = "cursor-trigger";

/** Presence in the environment only (file OR real environment counts). */
function envWebhookPresent(config: AppConfig, envFile: string | null): boolean {
  const fileVals = readEnvFileValues(join(repoRoot(config, envFile), ".env"));
  const url = fileVals.get("CURSOR_WEBHOOK_URL") || process.env.CURSOR_WEBHOOK_URL || "";
  const token =
    fileVals.get("CURSOR_AUTOMATION_TOKEN") || process.env.CURSOR_AUTOMATION_TOKEN || "";
  return url.trim() !== "" && token.trim() !== "";
}

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

export function cursorStatus(config: AppConfig, envFile: string | null, driver: StorageDriver): {
  stateFilePresent: boolean;
  lastTriggeredAt: string | null;
  intervalMinutes: number | null;
  effectiveIntervalMinutes: number;
  nextDueAt: string | null;
  webhookConfigured: boolean;
  /** Where the effective webhook config comes from: "db" wins, else "env". */
  webhookSource: "db" | "env" | null;
  webhookInEnv: boolean;
  webhookUpdatedAt: string | null;
  /** Whether the database row carries a payload template. */
  webhookPayloadSet: boolean;
  runnerScriptPresent: boolean;
  /** The instruction text itself — not a secret, the console shows it. */
  prompt: string | null;
} {
  const path = cursorStatePath(config, envFile);
  const present = existsSync(path);
  const state = readCursorState(path);
  const effective = effectiveIntervalMinutes(state, process.env);
  const dbRow = driver.getWebhookConfig(CURSOR_WEBHOOK_NAME);
  const inEnv = envWebhookPresent(config, envFile);
  return {
    stateFilePresent: present,
    lastTriggeredAt: state.lastTriggeredAt,
    intervalMinutes: state.intervalMinutes,
    effectiveIntervalMinutes: effective,
    nextDueAt: state.lastTriggeredAt
      ? new Date(Date.parse(state.lastTriggeredAt) + effective * 60_000).toISOString()
      : null,
    webhookConfigured: dbRow !== null || inEnv,
    webhookSource: dbRow !== null ? "db" : inEnv ? "env" : null,
    webhookInEnv: inEnv,
    webhookUpdatedAt: dbRow?.updated_at ?? null,
    webhookPayloadSet: Boolean(dbRow?.payload?.trim()),
    runnerScriptPresent: existsSync(cursorRunnerScript(config, envFile)),
    prompt: state.prompt,
  };
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

export function getCursorStatus(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  res.json(cursorStatus(deps.config, deps.envFile, deps.driver));
}

export function setCursorInterval(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const body = (req.body ?? {}) as { intervalMinutes?: unknown };
  const minutes = body.intervalMinutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    res.status(400).json({ error: "intervalMinutes must be an integer between 1 and 1440", field: "intervalMinutes" });
    return;
  }
  const path = cursorStatePath(deps.config, deps.envFile);
  const state = readCursorState(path);
  writeCursorState(path, { ...state, intervalMinutes: minutes });
  res.json(cursorStatus(deps.config, deps.envFile, deps.driver));
}

/**
 * Set the webhook body's `prompt` (the instruction the receiving
 * automation runs). Stored in the trigger state file — not in .env,
 * because prompts are long, multi-line, and not secret. An empty or
 * whitespace-only prompt clears it back to ping-only. The state read is
 * spread into the write, so interval and last-triggered values survive;
 * the same discipline applies in reverse (interval saves keep prompt).
 * The prompt itself is not a secret, so the status response returns it
 * for the console to display and edit.
 */
export function setCursorPrompt(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const body = (req.body ?? {}) as { prompt?: unknown };
  if (typeof body.prompt !== "string") {
    res.status(400).json({ error: "prompt must be a string (empty clears it)", field: "prompt" });
    return;
  }
  const trimmed = body.prompt.trim();
  const prompt = trimmed ? trimmed : null;
  if (prompt !== null && prompt.length > 200_000) {
    res.status(400).json({ error: "prompt must be at most 200000 chars", field: "prompt" });
    return;
  }
  const path = cursorStatePath(deps.config, deps.envFile);
  const state = readCursorState(path);
  writeCursorState(path, { ...state, prompt });
  res.json(cursorStatus(deps.config, deps.envFile, deps.driver));
}

/**
 * Set the cursor webhook configuration in the database webhook_configs
 * table (write-only for the token: the response carries the status object,
 * never the values). Only the URL/token fields actually sent are changed;
 * an omitted field keeps its stored value. First setup requires both
 * fields. URLs must be https (loopback http allowed for local testing);
 * tokens must be a single whitespace-free token without quotes.
 *
 * `payload` is the user-authored JSON body template (it usually contains
 * the `prompt`); when set it is authoritative and the state's single
 * prompt is ignored. It is a full value, not a partial update: an absent
 * key keeps the stored template, an empty string clears it.
 *
 * Freshness contract: the trigger job reads the database on every trigger
 * attempt, so a console save takes effect on the next tick — no runner
 * restart needed. The .env values remain only as the fallback while no
 * database row exists.
 */
export function setCursorWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const body = (req.body ?? {}) as { webhookUrl?: unknown; webhookToken?: unknown; payload?: unknown };
  const urlRaw = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
  const tokenRaw = typeof body.webhookToken === "string" ? body.webhookToken.trim() : "";
  if (!urlRaw && !tokenRaw && !("payload" in body)) {
    res.status(400).json({ error: "provide webhookUrl and/or webhookToken and/or payload", field: "webhookUrl" });
    return;
  }
  if (urlRaw && !validWebhookUrl(urlRaw)) {
    res.status(400).json({ error: "webhookUrl must be an https URL (loopback http allowed)", field: "webhookUrl" });
    return;
  }
  if (tokenRaw && (tokenRaw.length > 2000 || /\s/.test(tokenRaw) || tokenRaw.includes("'"))) {
    res.status(400).json({ error: "webhookToken must be a single token without whitespace or quotes", field: "webhookToken" });
    return;
  }
  // `payload` is the full desired template, not a partial update: an
  // absent key keeps the stored template, an empty string clears it back
  // to the built-in body shape. A non-empty payload must be a JSON object
  // (max 200000 chars); it usually contains the `prompt` itself, and when
  // set it is authoritative — the state's single prompt is then ignored.
  let payload: string | null | undefined;
  if ("payload" in body) {
    if (typeof body.payload !== "string") {
      res.status(400).json({ error: "payload must be a string (empty clears it)", field: "payload" });
      return;
    }
    const trimmed = body.payload.trim();
    if (trimmed) {
      if (trimmed.length > 200_000) {
        res.status(400).json({ error: "payload must be at most 200000 chars", field: "payload" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        res.status(400).json({ error: "payload must be valid JSON", field: "payload" });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.status(400).json({ error: "payload must be a JSON object", field: "payload" });
        return;
      }
      payload = trimmed;
    } else {
      payload = null;
    }
  }
  const existing = deps.driver.getWebhookConfig(CURSOR_WEBHOOK_NAME);
  const url = urlRaw || existing?.url;
  const token = tokenRaw || existing?.token;
  if (!url || !token) {
    res.status(400).json({
      error: "both webhookUrl and webhookToken are required for the first setup",
      field: url ? "webhookToken" : "webhookUrl",
    });
    return;
  }
  deps.driver.saveWebhookConfig({
    name: CURSOR_WEBHOOK_NAME,
    url,
    token,
    payload: payload === undefined ? (existing?.payload ?? null) : payload,
    updated_at: new Date().toISOString(),
  });
  res.json(cursorStatus(deps.config, deps.envFile, deps.driver));
}

/** Read the stored webhook row without the token, for the console form. */
export function getCursorWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const row = deps.driver.getWebhookConfig(CURSOR_WEBHOOK_NAME);
  if (!row) {
    res.json({ name: CURSOR_WEBHOOK_NAME, url: null, payload: null, updated_at: null, configured: false });
    return;
  }
  res.json({
    name: row.name,
    url: row.url,
    payload: row.payload,
    updated_at: row.updated_at,
    configured: true,
  });
}

/**
 * One-click migration: copy the .env webhook values into the database
 * row, server-side — the values never travel to the browser. After this,
 * the database row wins and the .env lines are vestigial (removable).
 */
export function importCursorWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  const fileVals = readEnvFileValues(join(repoRoot(deps.config, deps.envFile), ".env"));
  const url = fileVals.get("CURSOR_WEBHOOK_URL") || process.env.CURSOR_WEBHOOK_URL || "";
  const token =
    fileVals.get("CURSOR_AUTOMATION_TOKEN") || process.env.CURSOR_AUTOMATION_TOKEN || "";
  if (!url.trim() || !token.trim()) {
    res.status(400).json({ error: "no webhook configuration found in the environment" });
    return;
  }
  deps.driver.saveWebhookConfig({
    name: CURSOR_WEBHOOK_NAME,
    url: url.trim(),
    token: token.trim(),
    payload: deps.driver.getWebhookConfig(CURSOR_WEBHOOK_NAME)?.payload ?? null,
    updated_at: new Date().toISOString(),
  });
  res.json(cursorStatus(deps.config, deps.envFile, deps.driver));
}

/** Remove the database row (idempotent). The trigger then falls back to .env, if set. */
export function deleteCursorWebhook(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  deps.driver.deleteWebhookConfig(CURSOR_WEBHOOK_NAME);
  res.json(cursorStatus(deps.config, deps.envFile, deps.driver));
}

/**
 * Restart the job-runner pm2 process so it picks up changed .env values
 * (interval env, or webhook fallback values). Database-managed webhook
 * configs and state-file settings need no restart — the job reads them
 * fresh on every tick. Restarting is safe: the trigger state file
 * survives, so the gate keeps counting from the last trigger and no
 * extra webhook fires on restart.
 */
export function restartJobRunner(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  execFile("pm2", ["restart", "data-job-runner"], { timeout: 30_000 }, (err, stdout, stderr) => {
    const output = `${stdout}\n${stderr}`.trim().slice(-2000);
    if (err) {
      res.status(500).json({ ok: false, error: err.message, output });
      return;
    }
    res.json({ ok: true, output });
  });
}

let triggerInFlight = false;

/**
 * Manual trigger: runs the cursor-trigger job once, in a child process,
 * exactly like the scheduler does (same code, same environment). A second
 * concurrent request gets 409 instead of double-firing the webhook.
 * Job output is returned trimmed; the job itself never logs secrets.
 */
export function triggerCursor(deps: AdminDeps, req: Request, res: Response): void {
  if (adminOf(deps, req, res) === null) return;
  if (triggerInFlight) {
    res.status(409).json({ error: "trigger already running" });
    return;
  }
  const script = cursorRunnerScript(deps.config, deps.envFile);
  if (!existsSync(script)) {
    res.status(500).json({ ok: false, error: "job runner script not found (is the runner built?)" });
    return;
  }
  triggerInFlight = true;
  // Fresh-environment scrub: the child reloads the repo-root .env at
  // startup via loadDefaultEnv, but that loader never overwrites variables
  // already present — and this process inherited the .env values from ITS
  // startup. Without scrubbing, a .env edit would never reach a manual
  // trigger until the API itself restarts. (Database webhook configs do
  // not need this: the job reads the database fresh on every attempt.)
  // Only keys the .env file actually defines are scrubbed: if a value
  // comes from the real environment only (pm2 env, not the file), the
  // inherited value is kept, so that deployment shape keeps working.
  const childEnv = { ...process.env };
  const fileVals = readEnvFileValues(join(repoRoot(deps.config, deps.envFile), ".env"));
  for (const k of ["CURSOR_WEBHOOK_URL", "CURSOR_AUTOMATION_TOKEN", "CURSOR_TRIGGER_INTERVAL_MINUTES"]) {
    if (fileVals.get(k)) delete childEnv[k];
  }
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
