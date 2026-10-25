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
 * plaintext keys are never stored anywhere), and the cursor job status
 * reports webhook configuration as presence booleans only.
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
    };
  } catch {
    return { lastTriggeredAt: null, intervalMinutes: null };
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

export function cursorStatus(config: AppConfig, envFile: string | null): {
  stateFilePresent: boolean;
  lastTriggeredAt: string | null;
  intervalMinutes: number | null;
  effectiveIntervalMinutes: number;
  nextDueAt: string | null;
  webhookConfigured: boolean;
  runnerScriptPresent: boolean;
} {
  const path = cursorStatePath(config, envFile);
  const present = existsSync(path);
  const state = readCursorState(path);
  const effective = effectiveIntervalMinutes(state, process.env);
  return {
    stateFilePresent: present,
    lastTriggeredAt: state.lastTriggeredAt,
    intervalMinutes: state.intervalMinutes,
    effectiveIntervalMinutes: effective,
    nextDueAt: state.lastTriggeredAt
      ? new Date(Date.parse(state.lastTriggeredAt) + effective * 60_000).toISOString()
      : null,
    webhookConfigured: Boolean(process.env.CURSOR_WEBHOOK_URL) && Boolean(process.env.CURSOR_AUTOMATION_TOKEN),
    runnerScriptPresent: existsSync(cursorRunnerScript(config, envFile)),
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
  res.json(cursorStatus(deps.config, deps.envFile));
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
  res.json(cursorStatus(deps.config, deps.envFile));
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
  execFile(
    process.execPath,
    [script, "--run", "cursor-trigger"],
    { cwd: repoRoot(deps.config, deps.envFile), timeout: 90_000 },
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
