import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { verifyMessage } from "ethers";
import { hashKey } from "../auth/auth.js";
import type { StorageDriver } from "../storage/storage-driver.js";

/**
 * News-site reader auth: wallet login + favorites. Deliberately separate
 * from API tokens (those are for agents): a reader proves ownership of
 * an address by signing a one-time message, then holds a random session
 * token (SHA-256 only is stored, like API keys).
 *
 * Flow: POST /site-auth/nonce {address} -> {message} (single-use,
 * 10 minutes, binds the address and the site domain so the signature
 * cannot be replayed on another site) -> the browser asks the wallet
 * to personal_sign it -> POST /site-auth/verify {address, signature}
 * -> {session_token, address} (30 days). Favorites are keyed by the
 * lowercase address, so the same wallet sees the same list anywhere.
 */

export interface SiteDeps {
  driver: StorageDriver;
}

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function validAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

function validItemId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const itemId = raw.trim();
  return itemId && itemId.length <= 200 ? itemId : null;
}

/** Bearer session -> address, or null after responding 401. */
export function siteAddressOf(deps: SiteDeps, req: Request, res: Response): string | null {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) {
    res.status(401).json({ error: "site session required" });
    return null;
  }
  const session = deps.driver.findSiteSessionByHash(hashKey(token));
  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    if (session) deps.driver.deleteSiteSession(session.token_hash);
    res.status(401).json({ error: "site session expired" });
    return null;
  }
  return session.address;
}

export function requestNonce(deps: SiteDeps, req: Request, res: Response): void {
  const address = validAddress((req.body ?? {}).address);
  if (!address) {
    res.status(400).json({ error: "address must be a 0x Ethereum address", field: "address" });
    return;
  }
  const nonce = randomBytes(16).toString("hex");
  const message =
    `Agent 101 资讯登录\n` +
    `地址：${address}\n` +
    `一次性口令：${nonce}\n` +
    `时间：${new Date().toISOString()}\n` +
    `请确认这是在 agent101.uk 上的登录签名，不要在其他网站签名此内容。`;
  deps.driver.saveSiteNonce({
    address,
    nonce,
    message,
    expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
  });
  res.json({ address, message });
}

export function verifyNonce(deps: SiteDeps, req: Request, res: Response): void {
  const body = (req.body ?? {}) as { address?: unknown; signature?: unknown };
  const address = validAddress(body.address);
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  if (!address) {
    res.status(400).json({ error: "address must be a 0x Ethereum address", field: "address" });
    return;
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    res.status(400).json({ error: "signature is required", field: "signature" });
    return;
  }
  const stored = deps.driver.getSiteNonce(address);
  if (!stored || Date.parse(stored.expires_at) <= Date.now()) {
    if (stored) deps.driver.deleteSiteNonce(address);
    res.status(401).json({ error: "nonce expired, request a new one" });
    return;
  }
  let recovered: string;
  try {
    recovered = verifyMessage(stored.message, signature).toLowerCase();
  } catch {
    res.status(401).json({ error: "signature verification failed" });
    return;
  }
  if (recovered !== address) {
    res.status(401).json({ error: "signature does not match address" });
    return;
  }
  // Single-use: a replayed signature finds no nonce and fails above.
  deps.driver.deleteSiteNonce(address);
  const sessionToken = randomBytes(32).toString("hex");
  const now = new Date();
  deps.driver.saveSiteSession({
    token_hash: hashKey(sessionToken),
    address,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  });
  res.json({ address, session_token: sessionToken });
}

export function getMe(deps: SiteDeps, req: Request, res: Response): void {
  const address = siteAddressOf(deps, req, res);
  if (address === null) return;
  res.json({ address });
}

export function logout(deps: SiteDeps, req: Request, res: Response): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (token) deps.driver.deleteSiteSession(hashKey(token));
  res.json({ ok: true });
}

export function listFavorites(deps: SiteDeps, req: Request, res: Response): void {
  const address = siteAddressOf(deps, req, res);
  if (address === null) return;
  const items = deps.driver.listSiteFavorites(address);
  res.json({ items, total: items.length });
}

export function listFavoriteIds(deps: SiteDeps, req: Request, res: Response): void {
  const address = siteAddressOf(deps, req, res);
  if (address === null) return;
  res.json({ ids: deps.driver.listSiteFavorites(address).map((f) => f.item_id) });
}

export function addFavorite(deps: SiteDeps, req: Request, res: Response): void {
  const address = siteAddressOf(deps, req, res);
  if (address === null) return;
  const itemId = validItemId((req.body ?? {}).item_id);
  if (!itemId) {
    res.status(400).json({ error: "item_id is required (max 200 chars)", field: "item_id" });
    return;
  }
  deps.driver.saveSiteFavorite({ address, item_id: itemId, created_at: new Date().toISOString() });
  res.status(201).json({ ok: true, item_id: itemId });
}

export function removeFavorite(deps: SiteDeps, req: Request, res: Response): void {
  const address = siteAddressOf(deps, req, res);
  if (address === null) return;
  const itemId = validItemId(req.params.item_id);
  if (!itemId) {
    res.status(400).json({ error: "item_id is required", field: "item_id" });
    return;
  }
  if (!deps.driver.deleteSiteFavorite(address, itemId)) {
    res.status(404).json({ error: "favorite not found" });
    return;
  }
  res.json({ ok: true });
}
